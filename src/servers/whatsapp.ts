#!/usr/bin/env node
/**
 * WhatsApp — standalone MCP stdio server.
 *
 * Tools (9) — naming convention `whatsapp_<verb>_<object>`:
 *   - whatsapp_send_message         — Send a text message to a chat/contact. GATED.
 *   - whatsapp_send_media           — Send an image/video/audio/document from a local file path. GATED.
 *   - whatsapp_edit_message         — Edit a previously sent message. GATED.
 *   - whatsapp_typing               — Send a typing/composing indicator. Ungated (ephemeral, no content).
 *   - whatsapp_health               — Bridge connection health (status, queue length, uptime). Ungated (read-only).
 *   - whatsapp_get_chat             — Get chat info (name, group participants).
 *   - whatsapp_get_recent_messages  — Non-destructive read of the N most recent
 *     messages (proxies GET /messages/recent, added in hermes-agent commit
 *     3ea0b4d5 — mission #1, plan_41391cc2). Read-only; unlike the bridge's
 *     /messages, it never drains the destructive routing queue used by the
 *     future bacchus_whatsapp_router.py poller.
 *   - whatsapp_get_chat_messages    — Non-destructive read of the N most
 *     recent messages of ONE conversation, filtered by chatId (proxies
 *     GET /messages/recent/:chatId, added in hermes-agent commit 844290e2
 *     — mission #1, plan_e99959c1, reviewed/approved by Orion). Fills the
 *     gap where get_recent_messages is unfiltered (global feed) and
 *     get_chat returns metadata only, no content — Bacchus had no way to
 *     read the actual history of a specific chat. Same buffer/shape as
 *     get_recent_messages, just server-side filtered; unknown chatId -> [].
 *   - whatsapp_download_media       — Download the media attached to a
 *     previously received message (proxies GET /media/:messageId, added in
 *     hermes-agent commit aaa59aaa — mission #5, plan_14995c8c). Read-only,
 *     ungated (downloads content already received, not an outbound action).
 *     Only messages still in the bridge's recentHistory (last 200) are
 *     downloadable — an older messageId returns 404 even if the file is
 *     still on disk. Bridge caps cached files at 25 MB (413 above that).
 *
 * NOT exposed: GET /messages — destructive read (drains the routing queue
 * reserved for bacchus_whatsapp_router.py's poller); a second reader here
 * would steal messages from that poller. Use whatsapp_get_recent_messages
 * instead.
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
 * Autonomy gate (plan_60514194, mission #6; extended to whatsapp_edit_message
 * and fixed on whatsapp_send_media in mission #4, plan_14995c8c, 2026-08-26 —
 * send_media was missing the gate check entirely, an inconsistency with
 * send_message despite the mandate yamls already documenting it as gated).
 * Gate covers every tool that writes content the recipient actually sees
 * (send_message, send_media, edit_message) — never typing/health/reads.
 * Bacchus seats (lba-seat/lba-direction) must NEVER be able to
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
 *     to "true"/"1" on a bacchus per-tenant instance to refuse ALL sends/
 *     edits (send_message, send_media, edit_message) until the
 *     classify_niveau() gate is wired server-side; typing/health/get_chat/
 *     get_recent_messages stay unaffected, they don't write content)
 *
 * Run with: tsx src/servers/whatsapp.ts
 */
import { config } from "dotenv";
import { join } from "node:path";
import { z } from "zod";

import { createMcpServer, runServer } from "../lib/server";
import { buildChatMessagesPath, buildRecentMessagesPath } from "./whatsapp-recent";

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
    "[ubik-whatsapp] WHATSAPP_REQUIRE_AUTONOMY_GATE is set — whatsapp_send_message/send_media/" +
    "edit_message will refuse every call until the classify_niveau() autonomy gate is wired " +
    "server-side (LBA-DESKTOP endpoint, mirrors mail_envoyer). whatsapp_typing/health/get_chat/" +
    "get_recent_messages are unaffected.",
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
  "whatsapp_edit_message",
  "Edits a previously sent WhatsApp text message (only messages sent by this account can be edited).",
  {
    chatId: z.string().describe("Chat JID the original message was sent to"),
    messageId: z.string().describe("The sent message's id (returned as messageId by whatsapp_send_message/whatsapp_send_media)"),
    message: z.string().describe("New text content replacing the original message"),
  },
  async ({ chatId, messageId, message }) => {
    if (REQUIRE_AUTONOMY_GATE) return autonomyGateRefusal();
    const data = await bridgeFetch("/edit", {
      method: "POST",
      body: JSON.stringify({ chatId, messageId, message }),
    });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "whatsapp_typing",
  "Sends a 'composing' (typing…) indicator to a chat. Ephemeral UI signal, no message content — not gated.",
  {
    chatId: z.string().describe("Chat JID to show the typing indicator in"),
  },
  async ({ chatId }) => {
    const data = await bridgeFetch("/typing", { method: "POST", body: JSON.stringify({ chatId }) });
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "whatsapp_health",
  "Checks the WhatsApp bridge's connection health: connection status, pending queue length, recent-history length, process uptime. Read-only, not gated — lets the caller verify its own WhatsApp connection before acting.",
  {},
  async () => {
    const data = await bridgeFetch("/health");
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

server.tool(
  "whatsapp_get_recent_messages",
  "Non-destructive read of the N most recent WhatsApp messages. Unlike the bridge's polling queue, this never removes messages from the routing queue reserved for the WhatsApp message router.",
  {
    limit: z.number().int().positive().optional().describe("Max messages to return (default 50, capped at 200)"),
  },
  async ({ limit }) => {
    const data = await bridgeFetch(buildRecentMessagesPath(limit));
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "whatsapp_get_chat_messages",
  "Non-destructive read of the N most recent WhatsApp messages of ONE conversation, filtered by chatId. Unlike whatsapp_get_recent_messages (global feed) or whatsapp_get_chat (metadata only), this returns the actual message content of a specific chat. Unknown chatId returns an empty list, not an error.",
  {
    chatId: z.string().describe("Chat JID to read, e.g. '33612345678@s.whatsapp.net' or a group '...@g.us'"),
    limit: z.number().int().positive().optional().describe("Max messages to return (default 50, capped at 200)"),
  },
  async ({ chatId, limit }) => {
    const data = await bridgeFetch(buildChatMessagesPath(chatId, limit));
    return { content: [{ type: "text", text: JSON.stringify(data) }] };
  },
);

server.tool(
  "whatsapp_download_media",
  "Downloads the media (image/video/audio/document) attached to a previously received WhatsApp message, returned as base64-encoded bytes. Read-only, not gated — downloads content already received, not an outbound action. Only messages still in the bridge's recent history (last 200) are downloadable; an older messageId returns a not-found error even if the file still exists on disk. The bridge caps cached files at 25 MB and refuses larger ones.",
  {
    messageId: z.string().describe("The WhatsApp message id whose attached media to download (e.g. from whatsapp_get_recent_messages)"),
  },
  async ({ messageId }) => {
    const res = await fetch(`${BRIDGE_URL}/media/${encodeURIComponent(messageId)}`);
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(`WhatsApp media download error (${res.status}): ${data?.error || JSON.stringify(data)}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          messageId,
          contentType: res.headers.get("content-type") ?? null,
          sizeBytes: buf.length,
          base64Body: buf.toString("base64"),
        }),
      }],
    };
  },
);

runServer(server).catch((err) => {
  console.error(err);
  process.exit(1);
});
