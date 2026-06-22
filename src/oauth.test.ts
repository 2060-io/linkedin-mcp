import { describe, it, expect } from "vitest";
import { buildAuthorizationUrl, toTokenSet, type OAuthConfig, type TokenResponse, type UserInfo } from "./oauth.js";

const config: OAuthConfig = {
  clientId: "client123",
  clientSecret: "secret",
  redirectUri: "https://mcp.example.com/oauth/callback",
  scopes: ["openid", "profile", "email", "w_member_social"],
};

describe("buildAuthorizationUrl", () => {
  it("includes all required query parameters", () => {
    const url = new URL(buildAuthorizationUrl(config, "state-xyz"));
    expect(url.origin + url.pathname).toBe("https://www.linkedin.com/oauth/v2/authorization");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client123");
    expect(url.searchParams.get("redirect_uri")).toBe("https://mcp.example.com/oauth/callback");
    expect(url.searchParams.get("scope")).toBe("openid profile email w_member_social");
    expect(url.searchParams.get("state")).toBe("state-xyz");
  });
});

describe("toTokenSet", () => {
  const info: UserInfo = { sub: "AbC", given_name: "Jane", family_name: "Doe" };

  it("computes expiry timestamps and the person URN", () => {
    const token: TokenResponse = {
      access_token: "at",
      expires_in: 5184000, // 60 days
      refresh_token: "rt",
      refresh_token_expires_in: 31536000, // 365 days
    };
    const before = Date.now();
    const set = toTokenSet(token, info);
    expect(set.person_urn).toBe("urn:li:person:AbC");
    expect(set.member_name).toBe("Jane Doe");
    expect(set.refresh_token).toBe("rt");

    const accessTtl = new Date(set.expires_at).getTime() - before;
    expect(accessTtl).toBeGreaterThan(5183000 * 1000);
    expect(set.refresh_token_expires_at).not.toBeNull();
  });

  it("carries forward a previous refresh token when omitted", () => {
    const token: TokenResponse = { access_token: "at2", expires_in: 3600 };
    const previous = {
      access_token: "old",
      refresh_token: "carry-me",
      expires_at: new Date().toISOString(),
      refresh_token_expires_at: new Date(Date.now() + 1000).toISOString(),
      person_urn: "urn:li:person:AbC",
      member_name: "Jane Doe",
      obtained_at: new Date().toISOString(),
    };
    const set = toTokenSet(token, info, previous);
    expect(set.refresh_token).toBe("carry-me");
    expect(set.refresh_token_expires_at).toBe(previous.refresh_token_expires_at);
  });
});
