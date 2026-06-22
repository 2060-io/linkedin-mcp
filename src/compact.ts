/**
 * Response transformation: verbose LinkedIn JSON -> compact, token-efficient form.
 *
 * Phase 1 surfaces a small number of response shapes (OpenID userinfo, and the
 * lean objects our own client already builds for posts/comments/reactions), so
 * compaction mainly normalizes the userinfo profile and otherwise passes through.
 */

export interface CompactProfile {
  person_urn: string;
  name: string;
  email: string | null;
  picture: string | null;
  locale: string | null;
}

interface UserInfoLike {
  sub?: string;
  name?: string;
  given_name?: string;
  family_name?: string;
  email?: string;
  picture?: string;
  locale?: string | { language?: string; country?: string };
}

function isUserInfo(obj: unknown): obj is UserInfoLike {
  if (!obj || typeof obj !== "object") return false;
  return typeof (obj as Record<string, unknown>).sub === "string";
}

function localeToString(locale: UserInfoLike["locale"]): string | null {
  if (!locale) return null;
  if (typeof locale === "string") return locale;
  const lang = locale.language ?? "";
  const country = locale.country ?? "";
  const joined = [lang, country].filter(Boolean).join("_");
  return joined || null;
}

export function compactProfile(info: UserInfoLike): CompactProfile {
  const name =
    info.name ??
    [info.given_name, info.family_name].filter(Boolean).join(" ") ??
    "";
  return {
    person_urn: info.sub ? `urn:li:person:${info.sub}` : "",
    name,
    email: info.email ?? null,
    picture: info.picture ?? null,
    locale: localeToString(info.locale),
  };
}

export function compactResponse(apiResponse: unknown): unknown {
  if (!apiResponse || typeof apiResponse !== "object") return apiResponse;

  const resp = apiResponse as Record<string, unknown>;

  // OpenID Connect userinfo
  if (isUserInfo(resp.data)) {
    return { data: compactProfile(resp.data as UserInfoLike) };
  }
  if (isUserInfo(resp)) {
    return { data: compactProfile(resp as UserInfoLike) };
  }

  // Already-lean shapes (created post / comment / reaction) — pass through.
  return apiResponse;
}
