import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadState, saveState, getDefaultState, todayString, type TokenSet } from "./state.js";

const tmpFiles: string[] = [];
function tmpPath(): string {
  const p = path.join(os.tmpdir(), `li-mcp-test-${randomUUID()}.json`);
  tmpFiles.push(p);
  return p;
}

afterEach(() => {
  for (const f of tmpFiles.splice(0)) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* ignore */
    }
  }
});

describe("loadState", () => {
  it("returns default state for a missing file", () => {
    const state = loadState(tmpPath());
    expect(state.budget.posts).toBe(0);
    expect(state.tokens).toBeNull();
    expect(state.budget.date).toBe(todayString());
  });

  it("resets budget counters when the date changes", () => {
    const file = tmpPath();
    const stale = getDefaultState();
    stale.budget.date = "2000-01-01";
    stale.budget.posts = 5;
    stale.budget.comments = 3;
    saveState(file, stale);

    const loaded = loadState(file);
    expect(loaded.budget.date).toBe(todayString());
    expect(loaded.budget.posts).toBe(0);
    expect(loaded.budget.comments).toBe(0);
  });

  it("prunes engagement entries older than 90 days", () => {
    const file = tmpPath();
    const state = getDefaultState();
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    state.engaged.commented = [
      { post_urn: "urn:li:share:old", at: old },
      { post_urn: "urn:li:share:new", at: recent },
    ];
    saveState(file, state);

    const loaded = loadState(file);
    expect(loaded.engaged.commented).toHaveLength(1);
    expect(loaded.engaged.commented[0].post_urn).toBe("urn:li:share:new");
  });
});

describe("token round-trip", () => {
  it("persists and reloads a token set", () => {
    const file = tmpPath();
    const tokens: TokenSet = {
      access_token: "at",
      refresh_token: "rt",
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      refresh_token_expires_at: new Date(Date.now() + 1_000_000).toISOString(),
      person_urn: "urn:li:person:abc",
      member_name: "Jane Doe",
      obtained_at: new Date().toISOString(),
    };
    const state = getDefaultState();
    state.tokens = tokens;
    saveState(file, state);

    const loaded = loadState(file);
    expect(loaded.tokens).toEqual(tokens);
  });

  it("drops malformed tokens", () => {
    const file = tmpPath();
    fs.writeFileSync(file, JSON.stringify({ tokens: { access_token: 123 } }), "utf-8");
    expect(loadState(file).tokens).toBeNull();
  });
});

describe("saveState", () => {
  it("writes atomically and leaves no .tmp file", () => {
    const file = tmpPath();
    saveState(file, getDefaultState());
    expect(fs.existsSync(file)).toBe(true);
    expect(fs.existsSync(file + ".tmp")).toBe(false);
  });
});
