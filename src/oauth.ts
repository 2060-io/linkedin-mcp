import type { TokenSet } from "./state.js";

const AUTHORIZATION_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";

export const DEFAULT_SCOPES = ["openid", "profile", "email", "w_member_social"];

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  scope?: string;
  token_type?: string;
}

export interface UserInfo {
  sub: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  picture?: string;
  locale?: string | { language?: string; country?: string };
}

/** Build OAuth config from environment. Returns null if app credentials are absent. */
export function loadOAuthConfig(): OAuthConfig | null {
  const clientId = process.env.LINKEDIN_CLIENT_ID;
  const clientSecret = process.env.LINKEDIN_CLIENT_SECRET;
  const redirectUri = process.env.LINKEDIN_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) return null;
  return { clientId, clientSecret, redirectUri, scopes: DEFAULT_SCOPES };
}

export function buildAuthorizationUrl(config: OAuthConfig, state: string): string {
  const url = new URL(AUTHORIZATION_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  return url.toString();
}

async function postForm(body: URLSearchParams, operation: string): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await response.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`${operation} failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  if (!response.ok) {
    const err = data as { error?: string; error_description?: string };
    const detail = err.error_description || err.error || text.slice(0, 300);
    throw new Error(`${operation} failed (HTTP ${response.status}): ${detail}`);
  }
  return data as TokenResponse;
}

export function exchangeCodeForToken(config: OAuthConfig, code: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    redirect_uri: config.redirectUri,
  });
  return postForm(body, "exchangeCodeForToken");
}

export function refreshAccessToken(config: OAuthConfig, refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  return postForm(body, "refreshAccessToken");
}

export async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const response = await fetch(USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`fetchUserInfo failed (HTTP ${response.status}): ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as UserInfo;
}

/**
 * Merge a token response + userinfo into a persistable TokenSet.
 * Carries forward the previous refresh token when LinkedIn omits one on refresh.
 */
export function toTokenSet(
  token: TokenResponse,
  info: UserInfo,
  previous?: TokenSet | null,
): TokenSet {
  const now = Date.now();
  const refreshToken = token.refresh_token ?? previous?.refresh_token ?? null;
  const refreshExpiresAt = token.refresh_token_expires_in
    ? new Date(now + token.refresh_token_expires_in * 1000).toISOString()
    : (previous?.refresh_token_expires_at ?? null);

  const name =
    info.name ?? [info.given_name, info.family_name].filter(Boolean).join(" ") ?? "";

  return {
    access_token: token.access_token,
    refresh_token: refreshToken,
    expires_at: new Date(now + token.expires_in * 1000).toISOString(),
    refresh_token_expires_at: refreshExpiresAt,
    person_urn: `urn:li:person:${info.sub}`,
    member_name: name,
    obtained_at: new Date(now).toISOString(),
  };
}
