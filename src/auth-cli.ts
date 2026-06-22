#!/usr/bin/env node

/**
 * Local-dev OAuth helper. Spins a temporary loopback server at LINKEDIN_REDIRECT_URI,
 * prints the authorization URL, captures the redirect, exchanges the code, and persists
 * the token to the state file. For Kubernetes, use the cluster-hosted /oauth/start instead.
 */

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { loadOAuthConfig, buildAuthorizationUrl } from "./oauth.js";
import { TokenManager } from "./tokens.js";
import { errorMessage } from "./helpers.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

function firstValue(value: string | null): string | undefined {
  return value === null ? undefined : value;
}

async function main(): Promise<void> {
  const oauthConfig = loadOAuthConfig();
  if (!oauthConfig) {
    throw new Error(
      "Missing LinkedIn app credentials. Set LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, and LINKEDIN_REDIRECT_URI.",
    );
  }

  const statePath =
    process.env.LI_MCP_STATE_FILE ?? path.resolve(process.cwd(), "linkedin-mcp-state.json");
  const tokenManager = new TokenManager(statePath, oauthConfig);

  const redirect = new URL(oauthConfig.redirectUri);
  const port = Number(redirect.port || "80");
  const callbackPath = redirect.pathname;
  const stateValue = tokenManager.createOAuthState();
  const authUrl = buildAuthorizationUrl(oauthConfig, stateValue);

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://${redirect.host}`);
      if (url.pathname !== callbackPath) {
        res.writeHead(404).end("Not found");
        return;
      }

      const error = firstValue(url.searchParams.get("error"));
      if (error) {
        res.writeHead(400).end(`Authorization failed: ${error}`);
        server.close();
        reject(new Error(`Authorization failed: ${error}`));
        return;
      }

      const code = firstValue(url.searchParams.get("code"));
      const state = firstValue(url.searchParams.get("state"));
      if (!code || !state || !tokenManager.consumeOAuthState(state)) {
        res.writeHead(400).end("Invalid callback (missing code or bad state).");
        server.close();
        reject(new Error("Invalid callback: missing code or bad state."));
        return;
      }

      try {
        const { memberName, personUrn } = await tokenManager.authorizeWithCode(code);
        res.writeHead(200, { "Content-Type": "text/plain" }).end(
          `LinkedIn connected as ${memberName || personUrn}. You can close this tab.`,
        );
        console.error(`\n✅ Authorized as ${memberName || personUrn}`);
        console.error(`   Token written to ${statePath}`);
        server.close();
        resolve();
      } catch (e: unknown) {
        res.writeHead(500).end(errorMessage(e));
        server.close();
        reject(e);
      }
    });

    server.listen(port, () => {
      console.error("Open this URL in your browser to authorize:\n");
      console.error(`  ${authUrl}\n`);
      console.error(`Waiting for the redirect to ${oauthConfig.redirectUri} ...`);
    });
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Auth failed:", errorMessage(error));
    process.exit(1);
  });
