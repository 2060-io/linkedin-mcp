import type { Express, Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { type OAuthConfig, buildAuthorizationUrl } from "./oauth.js";
import type { TokenManager } from "./tokens.js";
import { errorMessage } from "./helpers.js";

export interface OAuthRoutesConfig {
  oauthConfig: OAuthConfig;
  tokenManager: TokenManager;
  adminUser?: string;
  adminPassword?: string;
}

/** Constant-time string comparison via fixed-length SHA-256 digests. */
function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a).digest();
  const hb = createHash("sha256").update(b).digest();
  return timingSafeEqual(ha, hb);
}

function htmlPage(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;line-height:1.5}
code{background:#f4f4f5;padding:.1rem .3rem;border-radius:.2rem}</style></head>
<body><h1>${title}</h1>${body}</body></html>`;
}

function makeBasicAuth(adminUser?: string, adminPassword?: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!adminUser || !adminPassword) {
      res
        .status(503)
        .send(
          "OAuth admin endpoints are disabled. Set LI_MCP_ADMIN_USER and LI_MCP_ADMIN_PASSWORD to enable /oauth/*.",
        );
      return;
    }

    const header = req.headers.authorization ?? "";
    const [scheme, encoded] = header.split(" ");
    if (scheme !== "Basic" || !encoded) {
      res.set("WWW-Authenticate", 'Basic realm="linkedin-mcp"').status(401).send("Authentication required.");
      return;
    }

    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    const sep = decoded.indexOf(":");
    const user = sep >= 0 ? decoded.slice(0, sep) : decoded;
    const pass = sep >= 0 ? decoded.slice(sep + 1) : "";

    if (safeEqual(user, adminUser) && safeEqual(pass, adminPassword)) {
      next();
      return;
    }
    res.set("WWW-Authenticate", 'Basic realm="linkedin-mcp"').status(401).send("Invalid credentials.");
  };
}

function firstQueryValue(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/**
 * Mount the cluster-hosted OAuth endpoints, all protected by HTTP Basic Auth:
 *   GET /oauth/start    -> redirect the operator to LinkedIn's consent screen
 *   GET /oauth/callback -> exchange the code and persist tokens to the state file
 *   GET /oauth/status   -> report token presence/expiry (no secrets)
 */
export function mountOAuthRoutes(app: Express, config: OAuthRoutesConfig): void {
  const { oauthConfig, tokenManager } = config;
  const guard = makeBasicAuth(config.adminUser, config.adminPassword);

  app.get("/oauth/start", guard, (_req, res) => {
    const state = tokenManager.createOAuthState();
    res.redirect(buildAuthorizationUrl(oauthConfig, state));
  });

  app.get("/oauth/callback", guard, async (req, res) => {
    const error = firstQueryValue(req.query.error);
    if (error) {
      const desc = firstQueryValue(req.query.error_description) ?? "";
      res.status(400).send(htmlPage("Authorization failed", `<p>${error}: ${desc}</p>`));
      return;
    }

    const code = firstQueryValue(req.query.code);
    const state = firstQueryValue(req.query.state);
    if (!code || !state) {
      res.status(400).send(htmlPage("Authorization failed", "<p>Missing <code>code</code> or <code>state</code>.</p>"));
      return;
    }
    if (!tokenManager.consumeOAuthState(state)) {
      res.status(400).send(htmlPage("Authorization failed", "<p>Invalid or expired <code>state</code>. Start again at <code>/oauth/start</code>.</p>"));
      return;
    }

    try {
      const { memberName, personUrn } = await tokenManager.authorizeWithCode(code);
      res.send(
        htmlPage(
          "LinkedIn connected",
          `<p>Authorized as <strong>${memberName || personUrn}</strong>.</p>
           <p>Tokens are stored and will refresh automatically. You can close this tab.</p>`,
        ),
      );
    } catch (e: unknown) {
      res.status(500).send(htmlPage("Authorization failed", `<p>${errorMessage(e)}</p>`));
    }
  });

  app.get("/oauth/status", guard, (_req, res) => {
    res.json(tokenManager.status());
  });
}
