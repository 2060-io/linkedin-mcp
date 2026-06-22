import { compactResponse } from "./compact.js";
import { encode } from "./toon.js";

/**
 * Normalize a LinkedIn post reference (URN or share URL) into a canonical URN.
 *
 * Accepts:
 *  - A raw URN:           urn:li:share:123 | urn:li:ugcPost:123 | urn:li:activity:123
 *  - A feed update URL:   https://www.linkedin.com/feed/update/urn:li:activity:123/
 *  - A posts URL slug:    https://www.linkedin.com/posts/jane-doe_topic-activity-123-abcd
 */
export function parsePostUrn(input: string): string {
  const trimmed = input.trim();

  // Already a URN
  if (/^urn:li:(share|ugcPost|activity):\d+$/.test(trimmed)) return trimmed;

  // URN embedded in a URL (feed update links)
  const embedded = trimmed.match(/urn:li:(share|ugcPost|activity):(\d+)/);
  if (embedded) return `urn:li:${embedded[1]}:${embedded[2]}`;

  // "...-activity-123456-abcd" slug form
  const slug = trimmed.match(/activity-(\d+)-/);
  if (slug) return `urn:li:activity:${slug[1]}`;

  throw new Error(`Invalid LinkedIn post URN or URL: ${input}`);
}

/**
 * URL-encode a URN for use as a REST path segment
 * (e.g. urn:li:share:123 -> urn%3Ali%3Ashare%3A123).
 */
export function encodeUrn(urn: string): string {
  return encodeURIComponent(urn);
}

/**
 * Safely extract a message string from an unknown error value.
 */
export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  return String(e);
}

/**
 * Format an API result and budget info as the MCP response payload.
 *
 * In compact mode, compactResponse preserves a { data, ... } shape, so we merge
 * li_budget into that structure directly. In non-compact mode we wrap the raw
 * response in { data: ... }.
 */
export function formatResult(
  data: unknown,
  budgetString?: string,
  compact?: boolean,
  toon?: boolean,
): string {
  let output: Record<string, unknown>;

  if (compact && data && typeof data === "object") {
    const compacted = compactResponse(data);
    output =
      compacted && typeof compacted === "object"
        ? { ...(compacted as Record<string, unknown>) }
        : { data: compacted };
  } else {
    output = { data };
  }

  if (budgetString) output.li_budget = budgetString;
  if (toon) return encode(output);
  return JSON.stringify(output);
}
