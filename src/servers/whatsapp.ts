#!/usr/bin/env node
/**
 * WhatsApp — standalone MCP stdio server.
 *
 * Tools (3) — naming convention `whatsapp_<verb>_<object>`:
 *   - whatsapp_send_message  — Send a text message to a chat/contact.
 *   - whatsapp_send_media    — Send an image/video/audio/document from a local file path.
 *   - whatsapp_get_chat      — Get chat info (name, group participants).
 *
 * No OAuth here: this proxies over HTTP to the persistent Baileys bridge
 * (wa-video-capture.service, ~/.hermes/whatsapp/session — already paired by
 * hermes-agent). WhatsApp Web allows only one active WebSocket per
 * linked-device session, so this server does NOT open its own connection —
 * it just forwards to the bridge's HTTP endpoints (send/send-media/chat/health).
 * If the bridge is down or the session is logged out, calls fail with a
 * clear error instead of silently opening a second, conflicting connection.
 *
 * Multi-tenant / per-seat usage (plan_60514194, mission #6): the target
 * bridge URL was already NOT hardcoded — WHATSAPP_BRIDGE_URL was already
 * read from the environment, just with a fallback default. What was
 * missing for real per-seat/tenant use is that this server must run as
 * ONE STANDALONE INSTANCE PER TENANT (declared directly in that tenant's
 * own .mcp.json with its own WHATSAPP_BRIDGE_URL), NOT spawned through the
 * shared aggregator gateway (src/gateway.ts, :8902) — the gateway spawns
 * each backend server ONCE and forwards its OWN process.env, so a single
 * gateway instance cannot differentiate the bridge URL per caller/seat.
 * Each tenant's bridge process (scripts/whatsapp-bridge/bridge.js) also
 * needs its own --port/--session, one WhatsApp number per tenant — see
 * hermes-agent's bridge.js, same 1-session-per-WebSocket constraint.
 *
 * Required env vars (loaded from .env via dotenv):
 *   - WHATSAPP_BRIDGE_URL (optional, defaults to http://127.0.0.1:3000 —
 *     for multi-tenant use, ALWAYS set this explicitly per instance; the
 *     startup log line below makes a forgotten override visible instead of
 *     silently sharing the default bridge across tenants)
 *
 * Run with: tsx src/servers/whatsapp.ts
 */
import { config } from "dotenv";
import { join } from "node:path";
import { z } from "zod";

import { createMcpServer, runServer } from "../lib/server";

config({ path: join(process.cwd(), ".env") });

const BRIDGE_URL = process.env.WHATSAPP_BRIDGE_URL || "http://127.0.0.1:3000";
console.error(
  process.env.WHATSAPP_BRIDGE_URL
    ? `[ubik-whatsapp] proxying to bridge at ${BRIDGE_URL} (from WHATSAPP_BRIDGE_URL)`
    : `[ubik-whatsapp] WHATSAPP_BRIDGE_URL not set — proxying to DEFAULT bridge at ${BRIDGE_URL}. ` +
      `For multi-tenant/per-seat use, set WHATSAPP_BRIDGE_URL explicitly so this instance never ` +
      `silently shares another tenant's bridge.`,
);

async function bridgeFetch(pathAndQuery: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${BRIDGE_URL}${pathAndQuery}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`WhatsApp bridge error (${res.status}): ${data?.error || JSON.stringify(data)}`);
  }
  return data;
}

const server = createMcpServer("ubik-whatsapp", "1.0.0");

server.tool(
  "whatsapp_send_message",
  "Sends a text message to a WhatsApp chat or contact. chatId format: '<phone>@s.whatsapp.net' for a contact, '<id>@g.us' for a group.",
  {
    chatId: z.string().describe("Recipient JID, e.g. '33612345678@s.whatsapp.net' or a group '...@g.us'"),
    message: z.string().describe("Text message body"),
  },
  async ({ chatId, message }) => {
    const data = await bridgeFetch("/send", { method: "POST", body: JSON.stringify({ chatId, message }) });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "whatsapp_send_media",
  "Sends a local file (image/video/audio/document) to a WhatsApp chat, with an optional caption.",
  {
    chatId: z.string().describe("Recipient JID"),
    filePath: z.string().describe("Absolute path to the file to send"),
    mediaType: z.enum(["image", "video", "audio", "document"]).optional().describe("Overrides type inferred from the file extension"),
    caption: z.string().optional(),
    fileName: z.string().optional().describe("Display name for document sends"),
  },
  async ({ chatId, filePath, mediaType, caption, fileName }) => {
    const data = await bridgeFetch("/send-media", {
      method: "POST",
      body: JSON.stringify({ chatId, filePath, mediaType, caption, fileName }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "whatsapp_get_chat",
  "Gets chat info (display name, whether it's a group, group participant JIDs).",
  {
    chatId: z.string().describe("Chat JID"),
  },
  async ({ chatId }) => {
    const data = await bridgeFetch(`/chat/${encodeURIComponent(chatId)}`);
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

runServer(server).catch((err) => {
  console.error(err);
  process.exit(1);
});
