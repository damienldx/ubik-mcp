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
 * Autonomy gate (plan_60514194, mission #6 revised scope, ordre LEAD/Damien
 * 2026-08-26): bacchus seats (lba-seat/lba-direction) must NEVER be able to
 * send a WhatsApp message without going through the same VERT/ORANGE/ROUGE
 * classify_niveau() gate already coded+tested 900+ times for mail/Teams
 * (LBA-DESKTOP/plan/bacchus_direction_autonomie.py — Python, SQLite-backed
 * ORANGE-tier persist+confirm flow). That gate is NOT reachable from here:
 * this is a generic, repo-agnostic TS proxy used fleet-wide (not just by
 * bacchus — e.g. the fleet's own mcp__ubik__whatsapp_* tools), with no
 * caller identity and no coupling to LBA-DESKTOP's Python backend. Two bad
 * options were rejected: (a) unconditionally block all sends here would
 * regress every EXISTING non-bacchus caller of this shared server; (b)
 * reimplementing classify_niveau() in TypeScript here would duplicate
 * business logic across languages/repos with real drift risk, and couldn't
 * reach the ORANGE-tier SQLite persist+confirm state LBA-DESKTOP already
 * has. Chosen instead (default-safe, zero regression, zero duplication):
 * an opt-in kill switch, OFF by default (today's fleet-wide behavior is
 * UNCHANGED), that a bacchus per-tenant instance turns ON to refuse EVERY
 * send outright until the real gate is wired at the correct layer (a new
 * LBA-DESKTOP endpoint mirroring mail_envoyer's classify_niveau() call,
 * itself proxying to this bridge — separate chantier, not this mission).
 * This satisfies the hard constraint ("never an ungated whatsapp send")
 * for bacchus without touching shared infra behavior for anyone else.
 *
 * Required env vars (loaded from .env via dotenv):
 *   - WHATSAPP_BRIDGE_URL (optional, defaults to http://127.0.0.1:3000 —
 *     for multi-tenant use, ALWAYS set this explicitly per instance; the
 *     startup log line below makes a forgotten override visible instead of
 *     silently sharing the default bridge across tenants)
 *   - WHATSAPP_REQUIRE_AUTONOMY_GATE (optional, default unset/false — set
 *     to "true"/"1" on a bacchus per-tenant instance to refuse ALL sends
 *     until the classify_niveau() gate is wired server-side; whatsapp_get_chat
 *     stays unaffected, it's read-only)
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

const REQUIRE_AUTONOMY_GATE = /^(1|true)$/i.test(process.env.WHATSAPP_REQUIRE_AUTONOMY_GATE || "");
if (REQUIRE_AUTONOMY_GATE) {
  console.error(
    "[ubik-whatsapp] WHATSAPP_REQUIRE_AUTONOMY_GATE is set — whatsapp_send_message/send_media " +
    "will refuse every call until the classify_niveau() autonomy gate is wired server-side " +
    "(LBA-DESKTOP endpoint, mirrors mail_envoyer). whatsapp_get_chat is unaffected.",
  );
}

function autonomyGateRefusal(): { content: Array<{ type: "text"; text: string }> } {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        error: "autonomy_gate_not_wired",
        message:
          "Refused: this instance requires the VERT/ORANGE/ROUGE autonomy gate (classify_niveau) " +
          "before any WhatsApp send, same as mail/Teams — that gate is not yet wired for WhatsApp. " +
          "No message was sent. This is not a transient error; do not retry.",
      }),
    }],
  };
}

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
    if (REQUIRE_AUTONOMY_GATE) return autonomyGateRefusal();
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
    if (REQUIRE_AUTONOMY_GATE) return autonomyGateRefusal();
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
