import express from "express";
import { randomUUID } from "crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { KnowledgeBase } from "./store.js";
import "dotenv/config";

export function startHttpTransport(
  createServer: () => McpServer,
  kb: KnowledgeBase
): void {
  const app = express();
  app.set("trust proxy", true);
  const port = parseInt(process.env.PORT ?? "3000", 10);
  const oauthClientId = process.env.OAUTH_CLIENT_ID;
  const oauthClientSecret = process.env.OAUTH_CLIENT_SECRET;
  const oauthEnabled = !!(oauthClientId && oauthClientSecret);

  if (!oauthEnabled) {
    console.warn("[warn] OAUTH_CLIENT_ID/OAUTH_CLIENT_SECRET not set — OAuth disabled");
  } else {
    console.log("[oauth] OAuth enabled for client:", oauthClientId);
  }

  // Cleanup expired OAuth entries every 5 minutes
  setInterval(() => kb.cleanupExpiredOAuth(), 5 * 60 * 1000);

  // Parse JSON and URL-encoded bodies
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));

  // Log every request
  app.use((req, _res, next) => {
    console.log(`[req] ${req.method} ${req.path} from=${req.ip} accept="${req.headers.accept ?? ""}" session="${req.headers["mcp-session-id"] ?? "none"}"`);
    next();
  });

  // --- OAuth auth middleware ---
  const authenticate: express.RequestHandler = (req, res, next) => {
    if (!oauthEnabled) {
      next();
      return;
    }

    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      console.warn(`[auth] REJECTED ${req.method} ${req.path} — missing Bearer token`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    const token = header.slice(7);
    if (!kb.validateAccessToken(token)) {
      console.warn(`[auth] REJECTED ${req.method} ${req.path} — invalid or expired token`);
      res.status(401).json({ error: "Unauthorized" });
      return;
    }

    next();
  };

  // --- OAuth discovery ---

  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    if (!oauthEnabled) {
      res.status(404).json({ error: "OAuth not configured" });
      return;
    }
    const baseUrl = `${_req.protocol}://${_req.get("host")}`;
    console.log(`[oauth] discovery requested, base=${baseUrl}`);
    res.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/oauth/authorize`,
      token_endpoint: `${baseUrl}/oauth/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post"],
    });
  });

  // --- OAuth authorize endpoint ---

  app.get("/oauth/authorize", (req, res) => {
    if (!oauthEnabled) {
      res.status(404).json({ error: "OAuth not configured" });
      return;
    }

    const clientId = req.query.client_id as string;
    const redirectUri = req.query.redirect_uri as string;
    const state = req.query.state as string | undefined;

    if (!clientId || !redirectUri) {
      res.status(400).json({ error: "Missing client_id or redirect_uri" });
      return;
    }

    if (clientId !== oauthClientId) {
      console.warn(`[oauth] authorize: unknown client_id="${clientId}"`);
      res.status(400).json({ error: "Unknown client_id" });
      return;
    }

    const code = randomUUID();
    kb.saveAuthCode(code, clientId, redirectUri, 5 * 60 * 1000);

    const redirectUrl = new URL(redirectUri);
    redirectUrl.searchParams.set("code", code);
    if (state) redirectUrl.searchParams.set("state", state);

    console.log(`[oauth] authorize: code generated for client="${clientId}", redirecting`);
    res.redirect(302, redirectUrl.toString());
  });

  // --- OAuth token endpoint ---

  app.post("/oauth/token", (req, res) => {
    if (!oauthEnabled) {
      res.status(404).json({ error: "OAuth not configured" });
      return;
    }

    const { grant_type, code, client_id, client_secret } = req.body;

    if (grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    if (!code || !client_id || !client_secret) {
      res.status(400).json({ error: "invalid_request", error_description: "Missing code, client_id, or client_secret" });
      return;
    }

    if (client_id !== oauthClientId || client_secret !== oauthClientSecret) {
      console.warn(`[oauth] token: bad credentials client_id="${client_id}"`);
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    const stored = kb.consumeAuthCode(code);
    if (!stored) {
      console.warn(`[oauth] token: invalid or expired code`);
      res.status(400).json({ error: "invalid_grant" });
      return;
    }

    const accessToken = randomUUID();
    const expiresIn = 3600; // 1 hour
    kb.saveAccessToken(accessToken, client_id, expiresIn * 1000);

    console.log(`[oauth] token: issued access_token for client="${client_id}"`);
    res.json({
      access_token: accessToken,
      token_type: "bearer",
      expires_in: expiresIn,
    });
  });

  // --- Health check (no auth) ---

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", documents: kb.count() });
  });

  // --- MCP transport ---

  // Track active transports by session ID
  const transports = new Map<string, StreamableHTTPServerTransport>();

  // Streamable HTTP: all MCP messages go through POST /mcp
  app.post("/mcp", authenticate, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    const body = req.body;
    const method = body?.method ?? body?.[0]?.method ?? "unknown";
    console.log(`[mcp] POST method="${method}" session="${sessionId ?? "new"}"`);

    try {
      if (sessionId && transports.has(sessionId)) {
        transport = transports.get(sessionId)!;
        console.log(`[mcp] reusing session ${sessionId}`);
      } else if (!sessionId) {
        // New session — create a fresh McpServer + transport pair
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
        });

        transport.onclose = () => {
          if (transport.sessionId) {
            console.log(`[mcp] session closed: ${transport.sessionId}`);
            transports.delete(transport.sessionId);
          }
        };

        const server = createServer();
        await server.connect(transport);
      } else {
        console.warn(`[mcp] session not found: ${sessionId}`);
        res.status(404).json({ error: "Session not found" });
        return;
      }

      // handleRequest processes the message; for initialize it also assigns sessionId
      await transport.handleRequest(req, res, body);

      // Store session AFTER handleRequest so sessionId is set from the initialize response
      if (transport.sessionId && !transports.has(transport.sessionId)) {
        transports.set(transport.sessionId, transport);
        console.log(`[mcp] new session stored: ${transport.sessionId} (active: ${transports.size})`);
      }

      console.log(`[mcp] handled method="${method}" status=${res.statusCode}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[mcp] ERROR handling method="${method}": ${message}`);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  // GET /mcp — SSE stream for server-initiated notifications
  app.get("/mcp", authenticate, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      console.warn(`[mcp] GET /mcp — no session: ${sessionId ?? "none"}`);
      res.status(400).json({ error: "Missing or invalid session ID" });
      return;
    }
    console.log(`[mcp] GET /mcp — opening SSE stream for session ${sessionId}`);
    const transport = transports.get(sessionId)!;
    await transport.handleRequest(req, res);
  });

  // DELETE /mcp — close session
  app.delete("/mcp", authenticate, async (req, res) => {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    if (!sessionId || !transports.has(sessionId)) {
      console.warn(`[mcp] DELETE session not found: ${sessionId ?? "none"}`);
      res.status(404).json({ error: "Session not found" });
      return;
    }
    const transport = transports.get(sessionId)!;
    await transport.close();
    transports.delete(sessionId);
    console.log(`[mcp] DELETE session ${sessionId} (active: ${transports.size})`);
    res.status(200).json({ message: "Session closed" });
  });

  app.listen(port, () => {
    console.log(`kb-server listening on http://localhost:${port}`);
    console.log(`  Health: http://localhost:${port}/health`);
    console.log(`  MCP:    POST http://localhost:${port}/mcp`);
    if (oauthEnabled) {
      console.log(`  OAuth:  GET http://localhost:${port}/.well-known/oauth-authorization-server`);
    }
  });
}
