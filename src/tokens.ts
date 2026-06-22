import { randomUUID } from "node:crypto";
import { loadState, saveState, OAUTH_STATE_MAX_AGE_MS, type TokenSet } from "./state.js";
import {
  type OAuthConfig,
  exchangeCodeForToken,
  refreshAccessToken,
  fetchUserInfo,
  toTokenSet,
} from "./oauth.js";

// Refresh the access token when it's within this window of expiring.
const EXPIRY_SKEW_MS = 5 * 60 * 1000;

const REAUTH_HINT =
  "Not authorized. Visit /oauth/start (HTTP) or run `npm run auth` (local) to connect a LinkedIn account.";

export interface AuthContext {
  accessToken: string;
  personUrn: string;
}

export interface AuthStatus {
  authorized: boolean;
  member_name?: string;
  person_urn?: string;
  access_token_valid?: boolean;
  access_token_expires_at?: string;
  refresh_token_expires_at?: string | null;
}

/**
 * Owns the member's OAuth tokens: persistence to the (PVC-backed) state file,
 * proactive refresh, and the short-lived CSRF `state` used by the OAuth routes.
 * The state file is the single source of truth for live tokens.
 */
export class TokenManager {
  constructor(
    private statePath: string,
    private oauthConfig: OAuthConfig,
  ) {}

  /** Return a valid access token + person URN, refreshing if necessary. Throws if unauthorized. */
  async getValid(): Promise<AuthContext> {
    const tokens = loadState(this.statePath).tokens;
    if (!tokens) throw new Error(REAUTH_HINT);

    const notYetExpiring = Date.now() < new Date(tokens.expires_at).getTime() - EXPIRY_SKEW_MS;
    if (notYetExpiring) {
      return { accessToken: tokens.access_token, personUrn: tokens.person_urn };
    }

    const refreshed = await this.refresh(tokens);
    return { accessToken: refreshed.access_token, personUrn: refreshed.person_urn };
  }

  private async refresh(tokens: TokenSet): Promise<TokenSet> {
    if (!tokens.refresh_token) {
      throw new Error(`Access token expired and no refresh token available. ${REAUTH_HINT}`);
    }
    if (
      tokens.refresh_token_expires_at &&
      Date.now() >= new Date(tokens.refresh_token_expires_at).getTime()
    ) {
      throw new Error(`Refresh token expired. ${REAUTH_HINT}`);
    }

    const tokenResponse = await refreshAccessToken(this.oauthConfig, tokens.refresh_token);
    const info = await fetchUserInfo(tokenResponse.access_token);
    const next = toTokenSet(tokenResponse, info, tokens);
    this.persistTokens(next);
    return next;
  }

  /** Exchange an authorization code, fetch the profile, and persist the token set. */
  async authorizeWithCode(code: string): Promise<{ personUrn: string; memberName: string }> {
    const tokenResponse = await exchangeCodeForToken(this.oauthConfig, code);
    const info = await fetchUserInfo(tokenResponse.access_token);
    const previous = loadState(this.statePath).tokens;
    const tokens = toTokenSet(tokenResponse, info, previous);
    this.persistTokens(tokens, { clearOAuthState: true });
    return { personUrn: tokens.person_urn, memberName: tokens.member_name };
  }

  /** Mint and persist a fresh CSRF `state` value for an authorization round-trip. */
  createOAuthState(): string {
    const value = randomUUID();
    const state = loadState(this.statePath);
    state.oauth_state = { value, created_at: new Date().toISOString() };
    saveState(this.statePath, state);
    return value;
  }

  /** Validate and consume a CSRF `state` value (single use, time-limited). */
  consumeOAuthState(value: string): boolean {
    const state = loadState(this.statePath);
    const entry = state.oauth_state;
    state.oauth_state = null;
    saveState(this.statePath, state);
    if (!entry || !value || entry.value !== value) return false;
    return Date.now() - new Date(entry.created_at).getTime() <= OAUTH_STATE_MAX_AGE_MS;
  }

  status(): AuthStatus {
    const tokens = loadState(this.statePath).tokens;
    if (!tokens) return { authorized: false };
    return {
      authorized: true,
      member_name: tokens.member_name,
      person_urn: tokens.person_urn,
      access_token_valid: Date.now() < new Date(tokens.expires_at).getTime(),
      access_token_expires_at: tokens.expires_at,
      refresh_token_expires_at: tokens.refresh_token_expires_at,
    };
  }

  private persistTokens(tokens: TokenSet, opts?: { clearOAuthState?: boolean }): void {
    const state = loadState(this.statePath);
    state.tokens = tokens;
    if (opts?.clearOAuthState) state.oauth_state = null;
    saveState(this.statePath, state);
  }
}
