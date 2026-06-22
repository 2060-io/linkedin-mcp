# linkedin-mcp Helm Chart

Deploys `linkedin-mcp` as an HTTP MCP server on Kubernetes, with PVC-backed token
state and a cluster-hosted OAuth flow.

## Install

```bash
helm install linkedin-mcp ./charts \
  --set secret.LINKEDIN_CLIENT_ID=your-client-id \
  --set secret.LINKEDIN_CLIENT_SECRET=your-client-secret \
  --set secret.LI_MCP_ADMIN_USER=admin \
  --set secret.LI_MCP_ADMIN_PASSWORD=a-strong-password \
  --set 'env[2].value=https://linkedin-mcp.example.com/oauth/callback'
```

Set `LINKEDIN_REDIRECT_URI` (the `env` entry shown above) to your public
`/oauth/callback` URL, and add the same URL as a Redirect URL on the LinkedIn app.

## Authorize (one-time, then ~yearly)

1. Visit `https://<public-host>/oauth/start` and pass HTTP Basic Auth
   (`LI_MCP_ADMIN_USER` / `LI_MCP_ADMIN_PASSWORD`).
2. Approve on LinkedIn. The callback writes the member's tokens to the PVC.
3. Check `https://<public-host>/oauth/status` to confirm.

Tokens refresh automatically until the refresh token expires (~1 year), at which
point you repeat step 1.

## State persistence

Tokens, daily budget counters, and engagement dedup live in a single JSON file on
a `PersistentVolumeClaim` (provisioned by default). This must stay enabled for
unattended use — a restart without it loses the OAuth tokens (forcing re-auth) and
resets safety budgets. State is a per-pod file with no shared locking, so the chart
supports a single replica and uses the `Recreate` strategy.

## Endpoints

```
http://<release-name>-linkedin-mcp:8000/mcp        # MCP (StreamableHTTP)
http://<release-name>-linkedin-mcp:8000/healthz    # Health check
http://<release-name>-linkedin-mcp:8000/oauth/start # OAuth (Basic Auth protected)
```

> Protect `/oauth/*` with TLS and, ideally, an Ingress allow-list / NetworkPolicy —
> those routes can mint tokens that post as the member.
