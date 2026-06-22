# linkedin-mcp — Specification (Phase 1)

## What This Is

An autonomous MCP (Model Context Protocol) server for the **LinkedIn API**, focused on
**publishing on behalf of an authenticated member**. Built-in safety rails for unattended
LLM agent operation: daily budget limits, engagement dedup, TOON-encoded responses,
typo-correcting parameter suggestions, and budget-gated destructive tools.

It mirrors the design of [`x-autonomous-mcp`](https://github.com/2060-io/x-autonomous-mcp)
but adapts to LinkedIn's reality: **LinkedIn has no public feed, search, follow, or
member-read API**. The self-serve tier is essentially write-only. Therefore this MCP is a
**content-publishing tool**, not an autonomous "discover → engage → grow" agent.

### Scope

- **Phase 1 (this spec):** Member publishing via the self-serve products *Sign In with
  LinkedIn (OpenID Connect)* and *Share on LinkedIn* — **no LinkedIn approval required**.
- **Phase 2 (out of scope here):** Posting and engagement as an **organization / Company
  Page** via the Community Management API — requires LinkedIn app review, a verified
  business, and a Page admin role. See [Phase 2 — Out of Scope](#phase-2--out-of-scope).

### Why Phase 1 is write-only

Reading even the member's *own* posts/comments/likes requires the `r_member_social`
permission, which is **restricted and approval-only**. There is **no** home-feed, timeline,
search, mentions, or follow/unfollow API for members. Any tool that requires reading the
network is deferred to Phase 2 (org-only) or is simply not possible.

## Architecture

No LinkedIn SDK dependency. Auth uses OAuth 2.0 (3-legged authorization code flow); the
server calls `api.linkedin.com` with raw `fetch`. Mirrors the X MCP module layout.

| File | Purpose |
|------|---------|
| `src/index.ts` | MCP server, tool definitions, inline safety checks, global `VALID_KEYS` map, stdio + HTTP bootstrap |
| `src/linkedin-api.ts` | `LinkedInApiClient` — token-bearer auth, version headers, raw fetch to `api.linkedin.com`, media upload, post/comment/react/delete |
| `src/oauth.ts` | OAuth 2.0 helpers: authorization URL, code→token exchange, **token refresh**, `/v2/userinfo` |
| `src/oauth-routes.ts` | Cluster-hosted OAuth endpoints (`/oauth/start`, `/oauth/callback`, `/oauth/status`) behind HTTP Basic Auth; writes minted tokens to the PVC state file |
| `src/auth-cli.ts` | Optional local-dev helper (`npm run auth`) for minting a token against a localhost redirect |
| `src/helpers.ts` | Pure utilities: `parsePostUrn`, `errorMessage`, `formatResult` |
| `src/state.ts` | Persistent state: budget counters, engagement dedup sets, token store, atomic file I/O |
| `src/compact.ts` | Response transformation: verbose LinkedIn JSON → compact form |
| `src/safety.ts` | Budget checks, dedup checks, action classification, typo suggestions |
| `src/toon.ts` | Vendored TOON encoder (from `@toon-format/toon`, MIT) |

## OAuth Flow

LinkedIn requires **3-legged OAuth** — there is no app-only token for content. Tokens are
member-scoped. Access tokens last ~60 days; refresh tokens (~1 year) are used to mint new
access tokens without re-prompting.

### Required Products (enable in the LinkedIn Developer Portal → Products)

| Product | Scopes granted | Purpose |
|---|---|---|
| Sign In with LinkedIn using OpenID Connect | `openid`, `profile`, `email` | Identify the member; resolve Person URN |
| Share on LinkedIn | `w_member_social` | Post, comment, and like on behalf of the member |

Requested scope string: `openid profile email w_member_social`.

### One-time authorization — cluster-hosted callback (primary)

The OAuth consent is served **by the deployed MCP itself**, so there is no local build or
`kubectl cp`. The member approves in a browser and tokens land directly in the PVC-backed
state file. All `/oauth/*` routes are protected by HTTP Basic Auth (see [Security](#security)).

| Route | Purpose |
|---|---|
| `GET /oauth/start` | Builds the LinkedIn authorization URL (random `state`) and 302-redirects the operator to LinkedIn |
| `GET /oauth/callback` | LinkedIn redirects here with `code` + `state`; the server exchanges it, calls `/v2/userinfo`, and **persists `access_token` + `refresh_token` + Person URN to the PVC state file** |
| `GET /oauth/status` | Reports whether a valid token is present, the member name, and token expiry (never returns secrets) |

**Bootstrap steps**

1. Set the app's **Redirect URL** to `https://<public-host>/oauth/callback` (must equal `LINKEDIN_REDIRECT_URI`).
2. Deploy the chart (PVC enabled). On first boot there are no tokens, so tools return
   `isError: true` with "authorize at /oauth/start".
3. Browse to `https://<public-host>/oauth/start`, pass Basic Auth, and approve on LinkedIn.
4. The callback writes the tokens + Person URN to the state file on the PVC. The agent is now live.
5. ~1 year later (refresh-token expiry), repeat step 3 — the only recurring manual action.

> **Local dev alternative:** `npm run auth` runs the same code→token exchange against a
> `localhost` redirect URI and writes to a local state file. Handy for testing; not used for
> the k8s deployment. **Secrets are never logged in plaintext.**

### Runtime token refresh

Before each request the server checks token expiry. On expiry (or a `401`), it calls the
token endpoint with `grant_type=refresh_token` to mint a fresh access token, persists it
atomically to the **PVC-backed state file** (the state file — not env/Secret — is the source
of truth for live tokens), and retries the original call once. If the refresh token is also
expired/invalid, tools return `isError: true` with an instruction to re-authorize at
`/oauth/start`.

### Request headers (every API call)

```
Authorization: Bearer <access_token>
LinkedIn-Version: <YYYYMM>          # e.g. 202506
X-Restli-Protocol-Version: 2.0.0
Content-Type: application/json
```

## Security

The OAuth admin endpoints (`/oauth/start`, `/oauth/callback`, `/oauth/status`) can mint and
report on tokens that post as the member, so they are protected:

- **HTTP Basic Auth** on all `/oauth/*` routes. Credentials come from the secrets
  `LI_MCP_ADMIN_USER` / `LI_MCP_ADMIN_PASSWORD` (stored in the k8s Secret, never in chart
  values). Requests without valid credentials get `401` + a `WWW-Authenticate: Basic` challenge.
- **`state` parameter** is random per authorization and validated on callback (CSRF protection).
- Serve only over HTTPS/TLS; additionally restrict `/oauth/*` via Ingress allow-list / NetworkPolicy.
- The MCP tool endpoint (`/mcp`) and health (`/healthz`) are not behind Basic Auth; protect
  them at the network layer as today.

## Tools

**Identity**
- `get_me` — authenticated member profile via `/v2/userinfo` (Person URN, name, email, picture).

**Publishing** (`w_member_social`, `POST https://api.linkedin.com/rest/posts`)
- `create_post` — text post. Optional `link` (article share with title/description) → renders a link card.
- `create_image_post` — text + 1 image. Uploads media first (see `upload_media`).
- `create_multi_image_post` — text + 2–20 images.
- `create_video_post` — text + 1 video.
- `reshare_post` — reshare an existing post by URN, with optional commentary.

**Engagement** (`w_member_social`; require a known target post URN — no discovery)
- `comment_on_post` — add a comment to a post URN.
- `react_to_post` — react (`LIKE`, `PRAISE`, `EMPATHY`, `INTEREST`, `APPRECIATION`, `ENTERTAINMENT`) to a post URN.

**Media**
- `upload_media` — register + upload an image/video via the Images/Videos API, returns
  `urn:li:image:...` / `urn:li:video:...` for use in a post.

**Lifecycle**
- `delete_post` — delete one of the member's own posts by URN (budget-gated).

> **No read tools in Phase 1.** `get_post`, listing your own posts, reading comments/
> reactions, search, feed, and mentions all require `r_member_social` (restricted) or are
> not offered by LinkedIn at all. They are deferred to Phase 2 / org scope.

### Post body shape (reference)

```json
{
  "author": "urn:li:person:{id}",
  "commentary": "Post text with optional {hashtag} and @mentions",
  "visibility": "PUBLIC",
  "distribution": {
    "feedDistribution": "MAIN_FEED",
    "targetEntities": [],
    "thirdPartyDistributionChannels": []
  },
  "lifecycleState": "PUBLISHED",
  "isReshareDisabledByAuthor": false
}
```

Image/video/multi-image/reshare add a `content` block referencing uploaded media URNs or a
`reshareContext`. Mentions/hashtags use entity URNs with character ranges in `commentary`.

## Safety Features

Mirrors the X MCP. Safety lives in the server, not the prompt.

1. **Daily budget limits** — `LI_MCP_MAX_POSTS`, `LI_MCP_MAX_COMMENTS`,
   `LI_MCP_MAX_REACTIONS`, `LI_MCP_MAX_DELETES`. `0` disables an action, `-1` = unlimited.
   Counters reset at midnight UTC (aligned with LinkedIn's own reset).
2. **Budget in every response** — the LLM sees remaining budget on every call.
3. **LinkedIn-aware caps** — defaults stay well under LinkedIn's member ceiling
   (150 share-API requests/day) and the separate per-author daily *share* limit.
4. **TOON encoding** — `LI_MCP_TOON=true` (default). Token-efficient tabular output. `false` = JSON.
5. **Compact responses** — `LI_MCP_COMPACT=true` (default). Strips verbose URNs/envelopes,
   flattens identity fields, returns the created post URN plainly.
6. **Engagement dedup** — `LI_MCP_DEDUP=true` (default). Never comment/react on the same
   post URN twice. 90-day pruning window.
7. **Typo-correcting parameter suggestions** — unknown params checked against `VALID_KEYS`
   with fuzzy-match suggestions; hardcoded redirects for common mistakes.
8. **Destructive tool budget** — `delete_post` is budget-limited; `LI_MCP_MAX_DELETES=0` blocks it.
9. **429 handling** — distinguishes the two LinkedIn 429s (API rate limit vs author share
   limit) and surfaces the reason; never auto-retries a share-limit 429.

## Environment Variables

**Required**
```
LINKEDIN_CLIENT_ID            # App API key (Developer Portal)
LINKEDIN_CLIENT_SECRET        # App secret
LINKEDIN_REDIRECT_URI         # Must equal https://<public-host>/oauth/callback AND a Redirect URL on the app
```

**OAuth admin Basic Auth (k8s Secret)**
```
LI_MCP_ADMIN_USER             # Basic Auth username for /oauth/* routes
LI_MCP_ADMIN_PASSWORD         # Basic Auth password for /oauth/* routes
```

**Member token — NOT set manually in k8s.** Minted via `/oauth/start` and persisted to the
PVC state file, then refreshed automatically. These exist only for local dev / seeding:
```
LINKEDIN_ACCESS_TOKEN         # (optional) seed member access token (~60 days)
LINKEDIN_REFRESH_TOKEN        # (optional) seed member refresh token (~1 year)
LINKEDIN_PERSON_URN           # (optional) urn:li:person:{sub}; else derived via /v2/userinfo
```

**API**
```
LINKEDIN_API_VERSION          # LinkedIn-Version header, YYYYMM (default: pinned, e.g. 202506)
```

**Safety (optional)**
```
LI_MCP_MAX_POSTS              # Daily post limit (default 5, 0=disabled, -1=unlimited)
LI_MCP_MAX_COMMENTS           # Daily comment limit (default 10)
LI_MCP_MAX_REACTIONS          # Daily reaction limit (default 30)
LI_MCP_MAX_DELETES            # Daily delete limit (default 3, 0=disabled)
LI_MCP_TOON                   # TOON encoding (default: true; "false" for JSON)
LI_MCP_COMPACT                # Compact responses (default: true)
LI_MCP_DEDUP                  # Engagement dedup (default: true)
LI_MCP_STATE_FILE             # State file path (default: {cwd}/linkedin-mcp-state.json)
```

**Transport (container)**
```
MCP_TRANSPORT=http            # stdio | http
MCP_PORT=8000
MCP_PATH=/mcp
MCP_HEALTH_PATH=/healthz
```

## Rate Limits

LinkedIn enforces two 24h ceilings (reset midnight UTC): **Application** and **per-Member**.
For the Share API the member ceiling is **150 requests/day** (application 100,000/day), plus
a separate **per-author daily share limit** (a distinct 429). Exact per-endpoint quotas are
only visible in the Developer Portal → Analytics after a first call. The server's daily
budgets are the first line of defense; LinkedIn's 429s are the second.

## State

A single JSON file (default `{cwd}/linkedin-mcp-state.json`), written atomically
(tmp + rename), holding:

- `budget` — today's used counts + date (auto-reset on date change)
- `engaged` — dedup sets (commented/reacted post URNs), 90-day pruned
- `tokens` — access/refresh tokens, expiry, Person URN (minted via `/oauth/callback`)

**Durability (required):** the state file MUST live on a mounted **PVC** (`LI_MCP_STATE_FILE`
→ volume path). It is the **source of truth for the OAuth tokens** written by
`/oauth/callback` and updated on every refresh. Without it, a restart loses budgets/dedup
**and the live tokens**, forcing a full re-authorization. The Helm chart provisions the PVC
by default (per the X MCP chart lesson).

## Build & Test

```bash
npm install
npm run build      # tsc -> dist/
npm test           # vitest
npm run auth       # OPTIONAL local-dev: mint a member token against a localhost redirect
npm start          # node dist/index.js
```

Testing follows the X MCP's **frozen-fixtures** discipline: integration tests assert against
byte-for-byte real LinkedIn API responses captured in `src/fixtures/`. **Never invent API
responses or fixture data.**

## Phase 2 — Out of Scope

Requires the **Community Management API** (LinkedIn review + verified business + Page admin):

- Post/edit/delete as an **organization** (text/image/video/article/carousel/multi-image, targeted & dark posts)
- Read the org's posts, comments (incl. nested), reactions, and mentions
- Comment/react as the org
- Organization analytics (follower, visitor, post performance)
- `list_organizations` / org access-control checks (`/organizationAuthorizations`)

Scopes: `w_organization_social`, `r_organization_social`, `w_organization_social_feed`,
`r_organization_social_feed`.

## Not Possible on LinkedIn (dropped from the X MCP feature set)

- `search` (no public content search) · `get_timeline` / home feed · `get_mentions` (member)
- `follow` / `unfollow` (no member-graph write) · follow-cycle / cleanup workflows · lists
- Member-level post analytics · direct messaging

## Rules

1. Keep the server minimal. No feature creep.
2. Every tool must handle errors gracefully and return `isError: true`.
3. Don't add dependencies without a strong reason.
4. Token efficiency matters. Don't request fields the tools don't use.
5. Pin `LinkedIn-Version`; bump deliberately and re-capture fixtures when you do.
6. Never log tokens; `/oauth/callback` writes them straight to the PVC state file. Protect all `/oauth/*` routes with Basic Auth.
7. All timestamps must be ISO 8601.
8. NEVER invent test data or API responses — capture real ones.
