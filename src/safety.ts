import type { StateFile, EngagedEntry } from "./state.js";

// --- Action type classification ---

type ActionType = "post" | "comment" | "reaction" | "delete" | null;
type DedupType = "commented" | "reacted" | null;

const ACTION_MAP: Record<string, ActionType> = {
  get_me: null,
  create_post: "post",
  create_image_post: "post",
  create_multi_image_post: "post",
  reshare_post: "post",
  comment_on_post: "comment",
  react_to_post: "reaction",
  delete_post: "delete",
  upload_media: null,
};

const DEDUP_MAP: Record<string, DedupType> = {
  comment_on_post: "commented",
  react_to_post: "reacted",
};

// --- Budget configuration ---

export interface BudgetConfig {
  maxPosts: number;
  maxComments: number;
  maxReactions: number;
  maxDeletes: number;
}

function parseLimit(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === "") return defaultValue;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? defaultValue : parsed;
}

export function loadBudgetConfig(): BudgetConfig {
  return {
    maxPosts: parseLimit(process.env.LI_MCP_MAX_POSTS, 5),
    maxComments: parseLimit(process.env.LI_MCP_MAX_COMMENTS, 10),
    maxReactions: parseLimit(process.env.LI_MCP_MAX_REACTIONS, 30),
    maxDeletes: parseLimit(process.env.LI_MCP_MAX_DELETES, 3),
  };
}

// --- Budget info ---

function getBudgetInfo(
  action: Exclude<ActionType, null>,
  state: StateFile,
  config: BudgetConfig,
): { used: number; max: number; label: string } {
  switch (action) {
    case "post":
      return { used: state.budget.posts, max: config.maxPosts, label: "post" };
    case "comment":
      return { used: state.budget.comments, max: config.maxComments, label: "comment" };
    case "reaction":
      return { used: state.budget.reactions, max: config.maxReactions, label: "reaction" };
    case "delete":
      return { used: state.budget.deletes, max: config.maxDeletes, label: "delete" };
  }
}

// --- Budget formatting ---

function formatCounter(used: number, max: number, label: string): string {
  if (max === -1) return `${used}/unlimited ${label} used`;
  if (max === 0) return `${used}/${max} ${label} used (DISABLED)`;
  if (used >= max) return `${used}/${max} ${label} used (LIMIT REACHED)`;
  return `${used}/${max} ${label} used`;
}

function relativeTime(isoTimestamp: string): string {
  const diff = Date.now() - new Date(isoTimestamp).getTime();
  if (diff < 0) return "just now";
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatBudgetString(state: StateFile, config: BudgetConfig): string {
  const parts = [
    formatCounter(state.budget.posts, config.maxPosts, "posts"),
    formatCounter(state.budget.comments, config.maxComments, "comments"),
    formatCounter(state.budget.reactions, config.maxReactions, "reactions"),
    formatCounter(state.budget.deletes, config.maxDeletes, "deletes"),
  ];
  let result = parts.join(", ");
  if (state.last_write_at) result += ` | last action: ${relativeTime(state.last_write_at)}`;
  return result;
}

function remainingPart(used: number, max: number, label: string): string {
  if (max === -1) return `unlimited ${label}`;
  if (max === 0) return `0 ${label}`;
  return `${Math.max(0, max - used)} ${label}`;
}

function remainingSummary(state: StateFile, config: BudgetConfig): string {
  return [
    remainingPart(state.budget.posts, config.maxPosts, "posts"),
    remainingPart(state.budget.comments, config.maxComments, "comments"),
    remainingPart(state.budget.reactions, config.maxReactions, "reactions"),
    remainingPart(state.budget.deletes, config.maxDeletes, "deletes"),
  ].join(", ");
}

// --- Budget checks ---

export function checkBudget(toolName: string, state: StateFile, config: BudgetConfig): string | null {
  const action = ACTION_MAP[toolName] ?? null;
  if (!action) return null;

  const { used, max, label } = getBudgetInfo(action, state, config);

  if (max === 0) {
    return `Daily ${label}s are disabled (limit: 0). Remaining today: ${remainingSummary(state, config)}.`;
  }
  if (max !== -1 && used >= max) {
    return `Daily ${label} limit reached (${used}/${max}). Try again tomorrow. Remaining today: ${remainingSummary(state, config)}.`;
  }
  return null;
}

// --- Dedup checks ---

export function checkDedup(toolName: string, postUrn: string, state: StateFile): string | null {
  const dedupType = DEDUP_MAP[toolName] ?? null;
  if (!dedupType) return null;

  const entries: EngagedEntry[] = state.engaged[dedupType];
  const existing = entries.find((e) => e.post_urn === postUrn);
  if (existing) {
    return `Already ${dedupType} on ${postUrn} at ${existing.at}. Duplicate blocked.`;
  }
  return null;
}

// --- Write tool check ---

export function isWriteTool(toolName: string): boolean {
  return (ACTION_MAP[toolName] ?? null) !== null;
}

// --- Record action (mutates state in-place) ---

export function recordAction(toolName: string, postUrn: string | null, state: StateFile): void {
  const action = ACTION_MAP[toolName] ?? null;
  const now = new Date().toISOString();

  if (action === "post") state.budget.posts++;
  else if (action === "comment") state.budget.comments++;
  else if (action === "reaction") state.budget.reactions++;
  else if (action === "delete") state.budget.deletes++;

  if (action) state.last_write_at = now;

  const dedupType = DEDUP_MAP[toolName] ?? null;
  if (dedupType && postUrn) {
    state.engaged[dedupType].push({ post_urn: postUrn, at: now });
  }
}

// --- Typo-correcting parameter suggestions ---

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1]
          ? dp[i - 1][j - 1]
          : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function closestMatch(input: string, candidates: string[], maxDistance = 3): string | null {
  let best: string | null = null;
  let bestDist = maxDistance + 1;
  for (const candidate of candidates) {
    const dist = levenshtein(input.toLowerCase(), candidate.toLowerCase());
    if (dist < bestDist) {
      bestDist = dist;
      best = candidate;
    }
  }
  return best;
}

const PARAMETER_HINTS: Record<string, Record<string, string>> = {
  create_post: {
    image: "Use the 'create_image_post' tool (upload via 'upload_media' first).",
    images: "Use the 'create_multi_image_post' tool.",
    reply_to: "Replies require a target post URN — use 'comment_on_post'.",
  },
};

export function getParameterHint(toolName: string, unknownKey: string, validKeys?: string[]): string | null {
  const hint = PARAMETER_HINTS[toolName]?.[unknownKey];
  if (hint) return hint;
  if (validKeys && validKeys.length > 0) {
    const suggestion = closestMatch(unknownKey, validKeys);
    if (suggestion) return `Did you mean '${suggestion}'?`;
  }
  return null;
}
