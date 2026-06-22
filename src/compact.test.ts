import { describe, it, expect } from "vitest";
import { compactProfile, compactResponse } from "./compact.js";

describe("compactProfile", () => {
  it("builds a person URN and flattens identity fields", () => {
    const result = compactProfile({
      sub: "AbC123",
      name: "Jane Doe",
      email: "jane@example.com",
      picture: "https://media.example.com/jane.jpg",
      locale: { language: "en", country: "US" },
    });
    expect(result).toEqual({
      person_urn: "urn:li:person:AbC123",
      name: "Jane Doe",
      email: "jane@example.com",
      picture: "https://media.example.com/jane.jpg",
      locale: "en_US",
    });
  });

  it("falls back to given+family name and null optionals", () => {
    const result = compactProfile({ sub: "x", given_name: "Jane", family_name: "Doe" });
    expect(result.name).toBe("Jane Doe");
    expect(result.email).toBeNull();
    expect(result.picture).toBeNull();
    expect(result.locale).toBeNull();
  });
});

describe("compactResponse", () => {
  it("detects bare userinfo", () => {
    const out = compactResponse({ sub: "x", name: "Jane" }) as { data: { person_urn: string } };
    expect(out.data.person_urn).toBe("urn:li:person:x");
  });

  it("detects wrapped userinfo under data", () => {
    const out = compactResponse({ data: { sub: "y", name: "Joe" } }) as { data: { person_urn: string } };
    expect(out.data.person_urn).toBe("urn:li:person:y");
  });

  it("passes through lean post/comment shapes", () => {
    const post = { id: "urn:li:share:1", author: "urn:li:person:x" };
    expect(compactResponse(post)).toBe(post);
  });
});
