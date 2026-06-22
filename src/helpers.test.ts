import { describe, it, expect } from "vitest";
import { parsePostUrn, encodeUrn, errorMessage, formatResult } from "./helpers.js";

describe("parsePostUrn", () => {
  it("passes through canonical URNs", () => {
    expect(parsePostUrn("urn:li:share:123")).toBe("urn:li:share:123");
    expect(parsePostUrn("urn:li:ugcPost:456")).toBe("urn:li:ugcPost:456");
    expect(parsePostUrn("urn:li:activity:789")).toBe("urn:li:activity:789");
  });

  it("extracts a URN embedded in a feed update URL", () => {
    expect(parsePostUrn("https://www.linkedin.com/feed/update/urn:li:activity:7012345678901234567/")).toBe(
      "urn:li:activity:7012345678901234567",
    );
  });

  it("extracts an activity id from a posts slug URL", () => {
    expect(parsePostUrn("https://www.linkedin.com/posts/jane-doe_topic-activity-7012345678901234567-AbCd")).toBe(
      "urn:li:activity:7012345678901234567",
    );
  });

  it("throws on garbage input", () => {
    expect(() => parsePostUrn("not-a-post")).toThrow(/Invalid LinkedIn post/);
  });
});

describe("encodeUrn", () => {
  it("percent-encodes a URN for path use", () => {
    expect(encodeUrn("urn:li:share:123")).toBe("urn%3Ali%3Ashare%3A123");
  });
});

describe("errorMessage", () => {
  it("handles Error, string, and unknown", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
    expect(errorMessage("plain")).toBe("plain");
    expect(errorMessage(42)).toBe("42");
  });
});

describe("formatResult", () => {
  it("wraps data and appends li_budget as JSON when toon is off", () => {
    const out = formatResult({ id: "urn:li:share:1" }, "5/5 posts used", false, false);
    const parsed = JSON.parse(out);
    expect(parsed.data).toEqual({ id: "urn:li:share:1" });
    expect(parsed.li_budget).toBe("5/5 posts used");
  });

  it("compacts userinfo into a profile", () => {
    const out = formatResult({ sub: "abc", name: "Jane", email: "j@x.com" }, undefined, true, false);
    const parsed = JSON.parse(out);
    expect(parsed.data.person_urn).toBe("urn:li:person:abc");
    expect(parsed.data.name).toBe("Jane");
  });

  it("emits TOON when enabled", () => {
    const out = formatResult({ id: "x" }, undefined, false, true);
    expect(out).toContain("data:");
    expect(out.trim().startsWith("{")).toBe(false);
  });
});
