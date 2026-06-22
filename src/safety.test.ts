import { describe, it, expect } from "vitest";
import {
  type BudgetConfig,
  checkBudget,
  checkDedup,
  recordAction,
  isWriteTool,
  formatBudgetString,
  getParameterHint,
} from "./safety.js";
import { getDefaultState } from "./state.js";

const config: BudgetConfig = { maxPosts: 2, maxComments: 5, maxReactions: 10, maxDeletes: 0 };

describe("checkBudget", () => {
  it("returns null for read-only tools", () => {
    expect(checkBudget("get_me", getDefaultState(), config)).toBeNull();
  });

  it("blocks when a limit is reached", () => {
    const state = getDefaultState();
    state.budget.posts = 2;
    expect(checkBudget("create_post", state, config)).toMatch(/limit reached/);
  });

  it("blocks disabled actions (limit 0)", () => {
    expect(checkBudget("delete_post", getDefaultState(), config)).toMatch(/disabled/);
  });

  it("allows when under budget", () => {
    expect(checkBudget("create_post", getDefaultState(), config)).toBeNull();
  });
});

describe("recordAction", () => {
  it("increments the post counter", () => {
    const state = getDefaultState();
    recordAction("create_post", null, state);
    expect(state.budget.posts).toBe(1);
    expect(state.last_write_at).not.toBeNull();
  });

  it("records dedup entries for comment/react", () => {
    const state = getDefaultState();
    recordAction("comment_on_post", "urn:li:share:1", state);
    expect(state.engaged.commented).toHaveLength(1);
    expect(state.engaged.commented[0].post_urn).toBe("urn:li:share:1");
  });
});

describe("checkDedup", () => {
  it("blocks a repeat engagement", () => {
    const state = getDefaultState();
    recordAction("react_to_post", "urn:li:share:9", state);
    expect(checkDedup("react_to_post", "urn:li:share:9", state)).toMatch(/Duplicate blocked/);
  });

  it("allows a new target", () => {
    expect(checkDedup("react_to_post", "urn:li:share:new", getDefaultState())).toBeNull();
  });
});

describe("isWriteTool", () => {
  it("classifies tools", () => {
    expect(isWriteTool("create_post")).toBe(true);
    expect(isWriteTool("delete_post")).toBe(true);
    expect(isWriteTool("get_me")).toBe(false);
    expect(isWriteTool("upload_media")).toBe(false);
  });
});

describe("formatBudgetString", () => {
  it("flags disabled and limit-reached counters", () => {
    const state = getDefaultState();
    state.budget.posts = 2;
    const str = formatBudgetString(state, config);
    expect(str).toMatch(/2\/2 posts used \(LIMIT REACHED\)/);
    expect(str).toMatch(/0\/0 deletes used \(DISABLED\)/);
  });
});

describe("getParameterHint", () => {
  it("redirects image params to the right tool", () => {
    expect(getParameterHint("create_post", "image", ["text", "link"])).toMatch(/create_image_post/);
  });

  it("suggests the closest valid key", () => {
    expect(getParameterHint("create_post", "txt", ["text", "link", "visibility"])).toMatch(/Did you mean 'text'/);
  });
});
