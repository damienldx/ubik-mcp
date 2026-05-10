#!/usr/bin/env tsx
/**
 * ubik-mcp HTTP gateway — aggregates all MCP stdio servers into one HTTP endpoint.
 * Spawns each server as a subprocess, proxies their tools/resources.
 * Exposes MCP over HTTP (SSE) on port 8902.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MCP_DIR = path.join(__dirname, "mcp");
const PORT = parseInt(process.env.PORT || "8902");

const SERVERS: { name: string; file: string }[] = [
  { name: "ubik-crawl",      file: "ubik-crawl-server.ts" },
  { name: "ubik-formation",  file: "ubik-formation-server.ts" },
  { name: "ubik-github",     file: "ubik-github-server.ts" },
  { name: "ubik-google",     file: "ubik-google-server.ts" },
  { name: "ubik-linkedin",   file: "ubik-linkedin-server.ts" },
  { name: "ubik-microsoft",  file: "ubik-microsoft-server.ts" },
  { name: "ubik-review",     file: "ubik-review-server.ts" },
  { name: "ubik-skills",     file: "ubik-skills-server.ts" },
  { name: "ubik-system",     file: "ubik-system-server.ts" },
];

// ── MCP Client to proxy a stdio subprocess ──────────────────────────────────

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

async function connectSubserver(name: string, file: string): Promise<Client | null> {
  const filePath = path.join(MCP_DIR, file);
  try {
    const transport = new StdioClientTransport({
      command: "tsx",
      args: [filePath],
      env: { ...process.env },
    });
    const client = new Client({ name: `proxy-${name}`, version: "1.0.0" });
    await client.connect(transport);
    console.log(`[ubik-mcp] connected: ${name}`);
    return client;
  } catch (e) {
    console.error(`[ubik-mcp] failed to connect ${name}:`, e);
    return null;
  }
}

// ── Build aggregated McpServer from all subserver tools ─────────────────────

async function buildAggregator(): Promise<McpServer> {
  const server = new McpServer({ name: "ubik-mcp-gateway", version: "1.0.0" });

  const clients = await Promise.all(
    SERVERS.map(({ name, file }) => connectSubserver(name, file))
  );

  for (let i = 0; i < SERVERS.length; i++) {
    const client = clients[i];
    if (!client) continue;
    const { name } = SERVERS[i];

    // Fetch tools from subserver and register them on aggregator
    const { tools } = await client.listTools();
    for (const tool of tools) {
      server.tool(
        tool.name,
        tool.description || "",
        tool.inputSchema as any,
        async (args: any) => {
          const result = await client.callTool({ name: tool.name, arguments: args });
          return result as any;
        }
      );
      console.log(`[ubik-mcp] registered tool: ${name}/${tool.name}`);
    }
  }

  return server;
}

// ── HTTP server with SSE transport ──────────────────────────────────────────

const transports = new Map<string, SSEServerTransport>();

async function main() {
  console.log("[ubik-mcp] starting aggregator...");
  const mcp = await buildAggregator();

  const http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url || "/", `http://localhost:${PORT}`);

    if (req.method === "GET" && url.pathname === "/mcp") {
      const transport = new SSEServerTransport("/mcp/message", res);
      transports.set(transport.sessionId, transport);
      res.on("close", () => transports.delete(transport.sessionId));
      await mcp.connect(transport);
      return;
    }

    if (req.method === "POST" && url.pathname === "/mcp/message") {
      const sessionId = url.searchParams.get("sessionId") || "";
      const transport = transports.get(sessionId);
      if (!transport) { res.writeHead(404); res.end("session not found"); return; }
      await transport.handlePostMessage(req, res);
      return;
    }

    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, service: "ubik-mcp", port: PORT }));
      return;
    }

    res.writeHead(404); res.end("not found");
  });

  http.listen(PORT, "127.0.0.1", () => {
    console.log(`[ubik-mcp] HTTP gateway listening on http://127.0.0.1:${PORT}`);
    console.log(`[ubik-mcp] MCP endpoint: http://127.0.0.1:${PORT}/mcp`);
  });
}

main().catch(console.error);
