import fs from "fs";
import path from "path";

export interface EngagedEntry {
  post_urn: string;
  at: string; // ISO 8601
}

export interface TokenSet {
  access_token: string;
  refresh_token: string | null;
  expires_at: string; // ISO 8601 — when the access token expires
  refresh_token_expires_at: string | null; // ISO 8601 — when re-auth is required
  person_urn: string; // urn:li:person:{sub}
  member_name: string;
  obtained_at: string; // ISO 8601
}

export interface OAuthStateEntry {
  value: string;
  created_at: string; // ISO 8601
}

export interface StateFile {
  budget: {
    date: string; // ISO 8601 date: "2026-06-22"
    posts: number;
    comments: number;
    reactions: number;
    deletes: number;
  };
  last_write_at: string | null;
  engaged: {
    commented: EngagedEntry[];
    reacted: EngagedEntry[];
  };
  tokens: TokenSet | null;
  oauth_state: OAuthStateEntry | null;
}

// Dedup entries older than 90 days are pruned on load
const DEDUP_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

// OAuth `state` values older than 10 minutes are abandoned
export const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

export function todayString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDefaultState(): StateFile {
  return {
    budget: { date: todayString(), posts: 0, comments: 0, reactions: 0, deletes: 0 },
    last_write_at: null,
    engaged: { commented: [], reacted: [] },
    tokens: null,
    oauth_state: null,
  };
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && !isNaN(value) ? value : fallback;
}

function asEngagedArray(value: unknown): EngagedEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (e): e is EngagedEntry =>
      e && typeof e === "object" && typeof e.post_urn === "string" && typeof e.at === "string",
  );
}

function pruneEngaged(entries: EngagedEntry[]): EngagedEntry[] {
  const cutoff = Date.now() - DEDUP_MAX_AGE_MS;
  return entries.filter((e) => new Date(e.at).getTime() > cutoff);
}

function asTokens(value: unknown): TokenSet | null {
  if (!value || typeof value !== "object") return null;
  const t = value as Record<string, unknown>;
  if (typeof t.access_token !== "string" || typeof t.expires_at !== "string") return null;
  if (typeof t.person_urn !== "string") return null;
  return {
    access_token: t.access_token,
    refresh_token: typeof t.refresh_token === "string" ? t.refresh_token : null,
    expires_at: t.expires_at,
    refresh_token_expires_at:
      typeof t.refresh_token_expires_at === "string" ? t.refresh_token_expires_at : null,
    person_urn: t.person_urn,
    member_name: typeof t.member_name === "string" ? t.member_name : "",
    obtained_at: typeof t.obtained_at === "string" ? t.obtained_at : new Date().toISOString(),
  };
}

function asOAuthState(value: unknown): OAuthStateEntry | null {
  if (!value || typeof value !== "object") return null;
  const s = value as Record<string, unknown>;
  if (typeof s.value !== "string" || typeof s.created_at !== "string") return null;
  return { value: s.value, created_at: s.created_at };
}

/**
 * Validate and normalize parsed JSON into a safe StateFile.
 * Missing/invalid fields fall back to defaults; budget resets when the date changes.
 */
function validateState(raw: unknown): StateFile {
  if (!raw || typeof raw !== "object") return getDefaultState();

  const obj = raw as Record<string, unknown>;
  const budget = obj.budget && typeof obj.budget === "object" ? (obj.budget as Record<string, unknown>) : {};
  const engaged = obj.engaged && typeof obj.engaged === "object" ? (obj.engaged as Record<string, unknown>) : {};

  const today = todayString();
  const budgetDate = typeof budget.date === "string" ? budget.date : today;
  const dateChanged = budgetDate !== today;

  return {
    budget: {
      date: today,
      posts: dateChanged ? 0 : asNumber(budget.posts, 0),
      comments: dateChanged ? 0 : asNumber(budget.comments, 0),
      reactions: dateChanged ? 0 : asNumber(budget.reactions, 0),
      deletes: dateChanged ? 0 : asNumber(budget.deletes, 0),
    },
    last_write_at: typeof obj.last_write_at === "string" ? obj.last_write_at : null,
    engaged: {
      commented: pruneEngaged(asEngagedArray(engaged.commented)),
      reacted: pruneEngaged(asEngagedArray(engaged.reacted)),
    },
    tokens: asTokens(obj.tokens),
    oauth_state: asOAuthState(obj.oauth_state),
  };
}

export function loadState(filePath: string): StateFile {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    return validateState(JSON.parse(raw));
  } catch (e: unknown) {
    if (e instanceof Error && "code" in e && (e as NodeJS.ErrnoException).code === "ENOENT") {
      return getDefaultState();
    }
    console.error(`Warning: could not parse state file ${filePath}, starting fresh:`, e);
    return getDefaultState();
  }
}

export function saveState(filePath: string, state: StateFile): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf-8");
  fs.renameSync(tmp, filePath);
}
