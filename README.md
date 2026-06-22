# linkedin-mcp

An MCP (Model Context Protocol) server that lets AI agents **publish to LinkedIn** as
the authenticated member — text posts, link shares, single/multi-image posts, reshares,
comments, and reactions — with built-in safety rails for autonomous operation: daily
budget limits, engagement deduplication, compact TOON-encoded responses, and
self-describing errors with typo suggestions.

Authentication is **OAuth 2.0 (3-legged)** with a **cluster-hosted callback** protected
by HTTP Basic Auth, so you never have to copy tokens onto a server by hand. Tokens,
budgets, and dedup state live in a single JSON file you can back with a Kubernetes PVC.

Works with **Claude Code**, **Claude Desktop**, **OpenAI Codex**, **Cursor**,
**Windsurf**, **Cline**, and any other MCP-compatible client.

> **Scope (Phase 1).** LinkedIn's public API only allows **member write** actions plus
> reading your own profile. There is **no** public API to read the feed, search posts,
> list followers/connections, or follow people. This MCP is therefore publish-and-engage
> oriented. See [`spec.md`](./spec.md) for the full design and rationale.

---

## What Can It Do?

| Category | Tools | What You Can Say |
| --- | --- | --- |
| **Identity** | `get_me` | "Who am I posting as?" |
| **Publish** | `create_post`, `create_image_post`, `create_multi_image_post`, `reshare_post` | "Post 'hello world' on LinkedIn" / "Share this image with a caption" |
| **Media** | `upload_media` | "Upload this image and post it" |
| **Engage** | `comment_on_post`, `react_to_post` | "Comment 'congrats' on this post" / "Like this post" |
| **Lifecycle** | `delete_post` | "Delete that post" |

Post-targeting tools accept either a LinkedIn **URN** (`urn:li:share:...` /
`urn:li:ugcPost:...` / `urn:li:activity:...`) or a post **URL** interchangeably.

---

## Safety Features

### Daily budget limits

Hard per-action limits per day. The server refuses when exhausted — even if the LLM
ignores every instruction.

```bash
LI_MCP_MAX_POSTS=5       # Max posts/reshares per day (default)
LI_MCP_MAX_COMMENTS=10   # Max comments per day
LI_MCP_MAX_REACTIONS=30  # Max reactions per day
LI_MCP_MAX_DELETES=3     # Max post deletions per day
```

Set to `0` to disable an action entirely. Set to `-1` for unlimited.

### Budget counters in every response

Every response includes the remaining budget, so the LLM sees its limits proactively:

```text
li_budget: "1/5 posts used, 0/10 comments used, 2/30 reactions used, 0/3 deletes used | last action: 3m ago"
```

### Engagement deduplication (default on)

Never comment on or react to the same post twice. Set `LI_MCP_DEDUP=false` to disable.

### TOON + compact responses (default on)

Responses use [TOON](https://github.com/toon-format/toon) and drop verbose fields to
save tokens. Set `LI_MCP_TOON=false` for JSON, `LI_MCP_COMPACT=false` to keep full shapes.

### Self-describing errors

Tools validate parameters and return actionable hints with fuzzy-matched suggestions for
typos, so the LLM learns from mistakes instead of getting opaque errors.

### Text formatting (automatic)

You pass post text as **plain text** — the server handles LinkedIn's quirks for you:

- LinkedIn parses `commentary` as **"Little Text"**, where `\ | { } @ [ ] ( ) < > # * _ ~`
  are reserved. An unescaped one (notably `(`) **silently truncates** the post. The server
  escapes them automatically.
- `#hashtags` are preserved as clickable hashtags.
- Images are only attached once LinkedIn finishes processing them, so posts never render as
  "This post cannot be displayed".

---

## Setup

### 1. Clone, install, build

```bash
git clone https://github.com/2060-io/linkedin-mcp.git
cd linkedin-mcp
npm install
npm run build
```

### 2. Create a LinkedIn app

1. Go to the [LinkedIn Developer Portal](https://www.linkedin.com/developers/apps) and
   create an app (it must be linked to a Company Page).
2. On the **Products** tab, request **Sign In with LinkedIn using OpenID Connect** and
   **Share on LinkedIn**. This grants the `openid`, `profile`, `email`, and
   `w_member_social` scopes.
3. On the **Auth** tab, copy the **Client ID** and **Client Secret**, and add your
   **Redirect URL** (see below).

### 3. Configure credentials

```bash
cp .env.example .env
```

Fill in `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, and `LINKEDIN_REDIRECT_URI`
(must EXACTLY match a Redirect URL on the app). See [`.env.example`](./.env.example) for
every option.

---

## Authorize (get a member token)

OAuth tokens are minted once, then refreshed automatically until the refresh token
expires (~1 year), at which point you re-authorize.

### Option A — Local dev CLI

```bash
# LINKEDIN_REDIRECT_URI=http://localhost:8000/oauth/callback
npm run auth
```

Open the printed URL, approve, and the tokens are written to the local state file.

### Option B — Cluster-hosted callback (recommended for k8s)

With `MCP_TRANSPORT=http` and `LI_MCP_ADMIN_USER` / `LI_MCP_ADMIN_PASSWORD` set, the
server exposes Basic-Auth-protected OAuth routes:

```text
GET /oauth/start     # redirects to LinkedIn consent
GET /oauth/callback  # LinkedIn returns here; tokens persisted to state file
GET /oauth/status    # shows whether a valid token is stored
```

Visit `https://<public-host>/oauth/start`, authenticate with Basic Auth, approve on
LinkedIn, and the member tokens land on the PVC. See [`charts/README.md`](./charts/README.md).

---

## Run

```bash
# stdio (for local MCP clients)
MCP_TRANSPORT=stdio npm start

# http (for cluster / remote)
MCP_TRANSPORT=http MCP_PORT=8000 npm start
```

HTTP endpoints: `/mcp` (StreamableHTTP), `/healthz`, and `/oauth/*`.

### Connect a client (stdio example)

```json
{
  "mcpServers": {
    "linkedin": {
      "command": "node",
      "args": ["/absolute/path/to/linkedin-mcp/dist/index.js"],
      "env": { "MCP_TRANSPORT": "stdio" }
    }
  }
}
```

---

## Deploy to Kubernetes

A Helm chart is provided in [`charts/`](./charts). It provisions a PVC for token/budget
state, runs a single replica with the `Recreate` strategy, and wires LinkedIn + Basic
Auth credentials through a Secret. See [`charts/README.md`](./charts/README.md) for
install and authorization steps.

---

## State persistence

All durable state — OAuth tokens (the source of truth), daily budget counters, and
engagement dedup — lives in one JSON file (`LI_MCP_STATE_FILE`, default
`{cwd}/linkedin-mcp-state.json`). On Kubernetes, back it with a PVC so tokens survive
restarts; otherwise a restart forces re-authorization and resets budgets.

---

## Development

```bash
npm run build   # tsc
npm test        # vitest
npm run dev     # build + start
```

---

## Credits

TOON encoder vendored from [@toon-format/toon](https://github.com/toon-format/toon)
(MIT). Architecture mirrors the sibling
[x-autonomous-mcp](https://github.com/2060-io/x-autonomous-mcp).

## License

MIT
