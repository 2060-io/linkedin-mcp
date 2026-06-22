#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import express from "express";
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { LinkedInApiClient, type ReactionType, type Visibility } from "./linkedin-api.js";
import { loadOAuthConfig } from "./oauth.js";
import { TokenManager } from "./tokens.js";
import { mountOAuthRoutes } from "./oauth-routes.js";
import { parsePostUrn, errorMessage, formatResult } from "./helpers.js";
import { loadState, saveState, type StateFile } from "./state.js";
import {
  loadBudgetConfig,
  formatBudgetString,
  checkBudget,
  checkDedup,
  recordAction,
  getParameterHint,
  isWriteTool,
} from "./safety.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

const SERVER_NAME = "linkedin-mcp";
const SERVER_VERSION = "0.1.0";

// --- Configuration ---

const oauthConfig = loadOAuthConfig();
if (!oauthConfig) {
  throw new Error(
    "Missing LinkedIn app credentials. Set LINKEDIN_CLIENT_ID, LINKEDIN_CLIENT_SECRET, and LINKEDIN_REDIRECT_URI. See .env.example.",
  );
}

const statePath =
  process.env.LI_MCP_STATE_FILE ?? path.resolve(process.cwd(), "linkedin-mcp-state.json");
const apiVersion = process.env.LINKEDIN_API_VERSION ?? "202506";
const budgetConfig = loadBudgetConfig();
const compactMode = process.env.LI_MCP_COMPACT !== "false"; // default true
const dedupEnabled = process.env.LI_MCP_DEDUP !== "false"; // default true
const toonEnabled = process.env.LI_MCP_TOON !== "false"; // default true

const tokenManager = new TokenManager(statePath, oauthConfig);
const client = new LinkedInApiClient({
  version: apiVersion,
  getAccessToken: async () => (await tokenManager.getValid()).accessToken,
});

const REACTIONS = ["LIKE", "PRAISE", "EMPATHY", "INTEREST", "APPRECIATION", "ENTERTAINMENT"] as const;
const VISIBILITIES = ["PUBLIC", "CONNECTIONS", "LOGGED_IN"] as const;

// --- Valid parameter keys per tool (for typo suggestions) ---

const VALID_KEYS: Record<string, string[]> = {
  get_me: [],
  create_post: ["text", "link", "visibility"],
  upload_media: ["image_data"],
  create_image_post: ["text", "image_urn", "image_data", "alt_text", "visibility"],
  create_multi_image_post: ["text", "images", "visibility"],
  reshare_post: ["post", "text", "visibility"],
  comment_on_post: ["post", "text"],
  react_to_post: ["post", "reaction"],
  delete_post: ["post"],
};

// --- Handler wrapper ---
// Centralizes: unknown-param checks, budget checks, dedup checks, action recording,
// response formatting (compact + budget string), and error handling.

interface WrapOptions {
  getTargetUrn?: (args: Record<string, unknown>) => string | Promise<string>;
}

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function wrapHandler(
  toolName: string,
  handler: (args: Record<string, unknown>, targetUrn: string | undefined) => Promise<unknown>,
  opts?: WrapOptions,
): (args: Record<string, unknown>) => Promise<ToolResult> {
  return async (args) => {
    try {
      const validKeys = VALID_KEYS[toolName];
      if (validKeys) {
        const unknownKeys = Object.keys(args).filter((k) => !validKeys.includes(k));
        if (unknownKeys.length > 0) {
          const hints = unknownKeys
            .map((k) => {
              const hint = getParameterHint(toolName, k, validKeys);
              return hint ? `Unknown parameter '${k}': ${hint}` : `Unknown parameter '${k}'.`;
            })
            .join("\n");
          const budgetString = formatBudgetString(loadState(statePath), budgetConfig);
          return errorResult(
            `Error: ${hints}\n\nValid parameters for ${toolName}: ${validKeys.join(", ") || "(none)"}\n\nCurrent li_budget: ${budgetString}`,
          );
        }
      }

      const state = loadState(statePath);

      const budgetError = checkBudget(toolName, state, budgetConfig);
      if (budgetError) {
        return errorResult(`Error: ${budgetError}\n\nCurrent li_budget: ${formatBudgetString(state, budgetConfig)}`);
      }

      const targetUrn = opts?.getTargetUrn ? await opts.getTargetUrn(args) : undefined;
      if (dedupEnabled && targetUrn) {
        const dedupError = checkDedup(toolName, targetUrn, state);
        if (dedupError) {
          return errorResult(`Error: ${dedupError}\n\nCurrent li_budget: ${formatBudgetString(state, budgetConfig)}`);
        }
      }

      const result = await handler(args, targetUrn);

      if (isWriteTool(toolName)) {
        recordAction(toolName, targetUrn ?? null, state);
        saveState(statePath, state);
      }

      const budgetString = formatBudgetString(state, budgetConfig);
      return { content: [{ type: "text", text: formatResult(result, budgetString, compactMode, toonEnabled) }] };
    } catch (e: unknown) {
      try {
        const budgetString = formatBudgetString(loadState(statePath), budgetConfig);
        return errorResult(`Error: ${errorMessage(e)}\n\nCurrent li_budget: ${budgetString}`);
      } catch {
        return errorResult(`Error: ${errorMessage(e)}`);
      }
    }
  };
}

// --- Media resolution helper ---

async function resolveImageUrn(
  ownerUrn: string,
  args: { image_urn?: string; image_data?: string },
): Promise<string> {
  if (args.image_urn) return args.image_urn;
  if (args.image_data) {
    const { image_urn } = await client.uploadImage({ ownerUrn, dataBase64: args.image_data });
    return image_urn;
  }
  throw new Error("Provide either 'image_urn' (from upload_media) or 'image_data' (base64).");
}

// --- MCP server factory ---

function buildServer(): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // -------- Identity --------

  server.registerTool(
    "get_me",
    {
      description: "Get the authenticated LinkedIn member's profile (Person URN, name, email).",
      inputSchema: z.object({}).passthrough(),
    },
    wrapHandler("get_me", async () => client.getUserInfo()),
  );

  // -------- Publishing --------

  server.registerTool(
    "create_post",
    {
      description:
        "Publish a text post on LinkedIn as the authenticated member. Optionally attach a link (article share). For images use create_image_post.",
      inputSchema: z
        .object({
          text: z.string().describe("The post body (commentary)."),
          link: z
            .object({
              url: z.string().describe("URL to share."),
              title: z.string().optional(),
              description: z.string().optional(),
            })
            .optional()
            .describe("Optional link to render as an article card."),
          visibility: z.enum(VISIBILITIES).optional().describe("Default PUBLIC."),
        })
        .passthrough(),
    },
    wrapHandler("create_post", async (args) => {
      const { personUrn } = await tokenManager.getValid();
      return client.createPost({
        authorUrn: personUrn,
        commentary: args.text as string,
        link: args.link as { url: string; title?: string; description?: string } | undefined,
        visibility: args.visibility as Visibility | undefined,
      });
    }),
  );

  server.registerTool(
    "upload_media",
    {
      description:
        "Upload an image (base64) and return its image URN for use in create_image_post / create_multi_image_post.",
      inputSchema: z
        .object({ image_data: z.string().describe("Base64-encoded image bytes.") })
        .passthrough(),
    },
    wrapHandler("upload_media", async (args) => {
      const { personUrn } = await tokenManager.getValid();
      return client.uploadImage({ ownerUrn: personUrn, dataBase64: args.image_data as string });
    }),
  );

  server.registerTool(
    "create_image_post",
    {
      description:
        "Publish a post with a single image. Provide image_urn (from upload_media) or image_data (base64).",
      inputSchema: z
        .object({
          text: z.string(),
          image_urn: z.string().optional(),
          image_data: z.string().optional(),
          alt_text: z.string().optional(),
          visibility: z.enum(VISIBILITIES).optional(),
        })
        .passthrough(),
    },
    wrapHandler("create_image_post", async (args) => {
      const { personUrn } = await tokenManager.getValid();
      const imageUrn = await resolveImageUrn(personUrn, {
        image_urn: args.image_urn as string | undefined,
        image_data: args.image_data as string | undefined,
      });
      return client.createPost({
        authorUrn: personUrn,
        commentary: args.text as string,
        imageUrn,
        imageAltText: args.alt_text as string | undefined,
        visibility: args.visibility as Visibility | undefined,
      });
    }),
  );

  server.registerTool(
    "create_multi_image_post",
    {
      description: "Publish a post with 2-20 images. Each image may be an existing urn or base64 data.",
      inputSchema: z
        .object({
          text: z.string(),
          images: z
            .array(
              z.object({
                urn: z.string().optional(),
                data: z.string().optional(),
                alt_text: z.string().optional(),
              }),
            )
            .min(2)
            .max(20),
          visibility: z.enum(VISIBILITIES).optional(),
        })
        .passthrough(),
    },
    wrapHandler("create_multi_image_post", async (args) => {
      const { personUrn } = await tokenManager.getValid();
      const images = args.images as Array<{ urn?: string; data?: string; alt_text?: string }>;
      const resolved = [];
      for (const img of images) {
        const id = await resolveImageUrn(personUrn, { image_urn: img.urn, image_data: img.data });
        resolved.push({ id, altText: img.alt_text });
      }
      return client.createPost({
        authorUrn: personUrn,
        commentary: args.text as string,
        multiImages: resolved,
        visibility: args.visibility as Visibility | undefined,
      });
    }),
  );

  server.registerTool(
    "reshare_post",
    {
      description: "Reshare an existing post (by URN or URL) with your own commentary.",
      inputSchema: z
        .object({
          post: z.string().describe("Post URN or URL to reshare."),
          text: z.string().describe("Your commentary."),
          visibility: z.enum(VISIBILITIES).optional(),
        })
        .passthrough(),
    },
    wrapHandler("reshare_post", async (args) => {
      const { personUrn } = await tokenManager.getValid();
      return client.createPost({
        authorUrn: personUrn,
        commentary: args.text as string,
        reshareUrn: parsePostUrn(args.post as string),
        visibility: args.visibility as Visibility | undefined,
      });
    }),
  );

  // -------- Engagement (require a known post URN) --------

  server.registerTool(
    "comment_on_post",
    {
      description: "Add a comment to a post (by URN or URL) as the authenticated member.",
      inputSchema: z
        .object({
          post: z.string().describe("Post URN or URL to comment on."),
          text: z.string().describe("Comment text."),
        })
        .passthrough(),
    },
    wrapHandler(
      "comment_on_post",
      async (args, targetUrn) => {
        const { personUrn } = await tokenManager.getValid();
        return client.commentOnPost({
          postUrn: targetUrn!,
          actorUrn: personUrn,
          message: args.text as string,
        });
      },
      { getTargetUrn: (args) => parsePostUrn(args.post as string) },
    ),
  );

  server.registerTool(
    "react_to_post",
    {
      description: "React to a post (by URN or URL). Reaction defaults to LIKE.",
      inputSchema: z
        .object({
          post: z.string().describe("Post URN or URL to react to."),
          reaction: z.enum(REACTIONS).optional().describe("Default LIKE."),
        })
        .passthrough(),
    },
    wrapHandler(
      "react_to_post",
      async (args, targetUrn) => {
        const { personUrn } = await tokenManager.getValid();
        return client.reactToPost({
          postUrn: targetUrn!,
          actorUrn: personUrn,
          reactionType: (args.reaction as ReactionType | undefined) ?? "LIKE",
        });
      },
      { getTargetUrn: (args) => parsePostUrn(args.post as string) },
    ),
  );

  // -------- Lifecycle --------

  server.registerTool(
    "delete_post",
    {
      description: "Delete one of your own posts (by URN or URL). Budget-limited; set LI_MCP_MAX_DELETES=0 to disable.",
      inputSchema: z.object({ post: z.string().describe("Post URN or URL to delete.") }).passthrough(),
    },
    wrapHandler(
      "delete_post",
      async (_args, targetUrn) => client.deletePost(targetUrn!),
      { getTargetUrn: (args) => parsePostUrn(args.post as string) },
    ),
  );

  return server;
}

// ============================================================
// START SERVER
// ============================================================

async function startStdio(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function startHttp(): Promise<void> {
  const port = Number(process.env.MCP_PORT ?? process.env.PORT ?? "8000");
  const mcpPath = process.env.MCP_PATH ?? "/mcp";
  const healthPath = process.env.MCP_HEALTH_PATH ?? "/healthz";
  const bodyLimit = process.env.MCP_BODY_LIMIT ?? "50mb";

  type Session = { server: McpServer; transport: StreamableHTTPServerTransport };
  const sessions = new Map<string, Session>();

  const app = express();
  app.use(express.json({ limit: bodyLimit }));

  app.get(healthPath, (_req, res) => {
    res.status(200).send("ok");
  });

  // Cluster-hosted OAuth (Basic Auth protected). Tokens land in the state file.
  mountOAuthRoutes(app, {
    oauthConfig: oauthConfig!,
    tokenManager,
    adminUser: process.env.LI_MCP_ADMIN_USER,
    adminPassword: process.env.LI_MCP_ADMIN_PASSWORD,
  });

  app.all(mcpPath, async (req, res) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let session = sessionId ? sessions.get(sessionId) : undefined;

      if (!session) {
        const body = req.body as { method?: string } | undefined;
        const isInitialize = req.method === "POST" && body?.method === "initialize";
        if (!isInitialize) {
          res.status(400).json({
            jsonrpc: "2.0",
            error: { code: -32000, message: "Bad Request: no session. Send an initialize request first." },
            id: null,
          });
          return;
        }

        const mcpServer = buildServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            sessions.set(sid, { server: mcpServer, transport });
          },
        });
        transport.onclose = () => {
          if (transport.sessionId) sessions.delete(transport.sessionId);
        };
        await mcpServer.connect(transport);
        session = { server: mcpServer, transport };
      }

      await session.transport.handleRequest(req, res, req.body);
    } catch (err) {
      console.error("[linkedin-mcp] handleRequest error:", err);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  await new Promise<void>((resolve) => {
    app.listen(port, () => {
      console.error(
        `[linkedin-mcp] StreamableHTTP on :${port}${mcpPath} (health: ${healthPath}, oauth: /oauth/start)`,
      );
      resolve();
    });
  });

  const shutdown = async (signal: string) => {
    console.error(`[linkedin-mcp] Received ${signal}, shutting down ${sessions.size} session(s)`);
    try {
      for (const [, { transport, server }] of sessions) {
        try { await transport.close(); } catch { /* ignore */ }
        try { await server.close(); } catch { /* ignore */ }
      }
      sessions.clear();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function main(): Promise<void> {
  const transportKind = (process.env.MCP_TRANSPORT ?? "stdio").toLowerCase();
  if (transportKind === "http" || transportKind === "streamablehttp") {
    await startHttp();
  } else {
    await startStdio();
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
