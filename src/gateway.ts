#!/usr/bin/env node
/**
 * ubik-mcp HTTP gateway
 *
 * Spawns each stdio MCP server in src/servers/ as a subprocess, agrégates
 * their tools through MCP Client + StdioClientTransport, and re-exposes the
 * union via an SSE-backed McpServer on http://127.0.0.1:8902.
 *
 * Routes:
 *   GET /health   — JSON status (servers connected, tools count, uptime)
 *   GET /mcp      — SSE endpoint for MCP clients
 *   POST /mcp     — message endpoint (paired with the SSE session)
 *
 * No dependency on UBIK-RELEASE. Imports limited to @modelcontextprotocol/sdk,
 * dotenv, and node built-ins.
 */
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

config({ path: path.join(process.cwd(), ".env") });

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

const HOST = process.env.UBIK_GATEWAY_HOST || "127.0.0.1";
const PORT = Number(process.env.UBIK_GATEWAY_PORT || 8902);

const STARTED_AT = Date.now();

interface UpstreamServer {
  name:    string;
  command: string;
  args:    string[];
  client?: Client;
  tools:   Array<{ name: string; description?: string; inputSchema?: unknown }>;
  error?:  string;
}

// Resolve absolute paths to subprocess servers. tsx is invoked so .ts files
// can be run without a separate compile step (matches package.json scripts).
const SERVERS: UpstreamServer[] = [
  { name: "skills",    command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "skills.ts")],    tools: [] },
  { name: "system",    command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "system.ts")],    tools: [] },
  { name: "crawl",     command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "crawl.ts")],     tools: [] },
  { name: "review",    command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "review.ts")],    tools: [] },
  { name: "formation", command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "formation.ts")], tools: [] },
  { name: "github",    command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "github.ts")],    tools: [] },
  { name: "google",    command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "google.ts")],    tools: [] },
  { name: "linkedin",  command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "linkedin.ts")],  tools: [] },
  { name: "microsoft", command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "microsoft.ts")], tools: [] },
  { name: "desktop",   command: "npx", args: ["-y", "tsx", path.join(__dirname, "servers", "desktop.ts")],   tools: [] },
];

async function connectUpstream(srv: UpstreamServer): Promise<void> {
  try {
    const transport = new StdioClientTransport({
      command: srv.command,
      args:    srv.args,
      env:     { ...process.env } as Record<string, string>,
      stderr:  "pipe",
    });
    const client = new Client(
      { name: `ubik-gateway-client/${srv.name}`, version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    const list = await client.listTools();
    srv.client = client;
    srv.tools  = (list.tools ?? []).map((t) => ({
      name:        t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
    process.stderr.write(`[gateway] upstream "${srv.name}" connected — ${srv.tools.length} tools\n`);
  } catch (err) {
    srv.error = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[gateway] upstream "${srv.name}" failed: ${srv.error}\n`);
  }
}

function buildAggregator(): McpServer {
  const agg = new McpServer({ name: "ubik-mcp-gateway", version: "1.0.0" });

  for (const srv of SERVERS) {
    if (!srv.client) continue;
    for (const tool of srv.tools) {
      const exposedName = `${srv.name}.${tool.name}`;
      // Register a passthrough — the inputSchema is what the upstream
      // declared, so we pass the raw arguments object back through.
      // The MCP SDK's `tool()` helper accepts a name + description and an
      // async handler returning {content,...}. We route to upstream.callTool.
      agg.tool(
        exposedName,
        tool.description || `Routed to ${srv.name}.${tool.name}`,
        // No fine-grained zod schema here — MCP SDK accepts a raw shape or
        // a free-form handler. We use a permissive shape so any args pass.
        {} as Record<string, never>,
        async (args: Record<string, unknown>) => {
          if (!srv.client) {
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: `upstream ${srv.name} not connected` }) }], isError: true };
          }
          try {
            const result = await srv.client.callTool({ name: tool.name, arguments: args });
            return {
              content: (result.content as { type: "text"; text: string }[]) ?? [],
              isError: !!result.isError,
            };
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
          }
        },
      );
    }
  }

  return agg;
}

// ── HTTP server ───────────────────────────────────────────────────────────────

interface SseSession {
  transport: SSEServerTransport;
}

const sessions = new Map<string, SseSession>();
let aggServer: McpServer | null = null;

function healthPayload() {
  return {
    ok:        true,
    version:   "1.0.0",
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    upstreams: SERVERS.map((s) => ({
      name:       s.name,
      connected:  !!s.client,
      toolCount:  s.tools.length,
      error:      s.error ?? null,
    })),
    totalTools: SERVERS.reduce((acc, s) => acc + (s.client ? s.tools.length : 0), 0),
    sessions:   sessions.size,
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? `${HOST}:${PORT}`}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, healthPayload());
    return;
  }

  if (req.method === "GET" && url.pathname === "/mcp") {
    if (!aggServer) {
      sendJson(res, 503, { ok: false, error: "aggregator not ready" });
      return;
    }
    const transport = new SSEServerTransport("/mcp", res);
    sessions.set(transport.sessionId, { transport });
    transport.onclose = () => { sessions.delete(transport.sessionId); };
    try {
      await aggServer.connect(transport);
    } catch (err) {
      process.stderr.write(`[gateway] SSE connect failed: ${err}\n`);
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/mcp") {
    const sessionId = url.searchParams.get("sessionId");
    if (!sessionId) { sendJson(res, 400, { ok: false, error: "missing sessionId" }); return; }
    const session = sessions.get(sessionId);
    if (!session) { sendJson(res, 404, { ok: false, error: "session not found" }); return; }
    try {
      await session.transport.handlePostMessage(req, res);
    } catch (err) {
      process.stderr.write(`[gateway] SSE post failed: ${err}\n`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "post handler failed" });
    }
    return;
  }

  sendJson(res, 404, { ok: false, error: `Not found: ${req.method} ${url.pathname}` });
}

async function main(): Promise<void> {
  process.stderr.write(`[gateway] starting on http://${HOST}:${PORT}\n`);
  await Promise.all(SERVERS.map(connectUpstream));
  aggServer = buildAggregator();

  const server = http.createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      process.stderr.write(`[gateway] handler error: ${err}\n`);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal" });
    });
  });

  server.listen(PORT, HOST, () => {
    const total = SERVERS.reduce((acc, s) => acc + (s.client ? s.tools.length : 0), 0);
    process.stderr.write(`[gateway] ready — ${total} aggregated tools, ${SERVERS.length} upstreams\n`);
  });

  const shutdown = async () => {
    process.stderr.write("[gateway] shutting down\n");
    for (const srv of SERVERS) {
      try { await srv.client?.close(); } catch { /* ignore */ }
    }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  };
  process.on("SIGINT",  shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  process.stderr.write(`[gateway] fatal: ${err}\n`);
  process.exit(1);
});
