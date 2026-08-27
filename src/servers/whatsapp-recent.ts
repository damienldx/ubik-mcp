/**
 * Pure helper for whatsapp_get_recent_messages (mission #2, plan_41391cc2).
 *
 * Contract fixed in mission #1 (hermes-agent commit 3ea0b4d5):
 *   GET /messages/recent?limit=N -> 200, body = JSON array, same item
 *   shape as /messages. limit optional, default 50, capped at 200.
 *
 * Extracted as a pure function (not inlined in whatsapp.ts) so the
 * param-transmission/clamping behavior is unit-testable without spinning
 * up the MCP server or an HTTP mock — same rationale as bridge.js's
 * recent-history.js split in mission #1.
 */

export const RECENT_MESSAGES_DEFAULT_LIMIT = 50;
export const RECENT_MESSAGES_MAX_LIMIT = 200;

function clampLimit(limit?: number): number {
  let effective = limit;
  if (typeof effective !== "number" || !Number.isFinite(effective) || effective <= 0) {
    effective = RECENT_MESSAGES_DEFAULT_LIMIT;
  }
  return Math.min(effective, RECENT_MESSAGES_MAX_LIMIT);
}

/** Builds the bridge path+query for GET /messages/recent, clamping limit
 *  client-side to match the bridge's own contract (defense in depth —
 *  the bridge also clamps, but a caller passing e.g. limit=99999 should
 *  see the effective, capped value it will actually get back). */
export function buildRecentMessagesPath(limit?: number): string {
  return `/messages/recent?limit=${clampLimit(limit)}`;
}

/**
 * Builds the bridge path+query for GET /messages/recent/:chatId (mission
 * #2, t_355b208662; contract fixed in hermes-agent mission #1, bridge.js
 * commit 844290e2, reviewed/approved by Orion): same shape and same
 * getRecent() as /messages/recent above, just filtered server-side to one
 * conversation before the limit is applied — "last N" means the last N
 * messages of THAT chat. Unknown/empty chatId -> [] (not an error).
 * chatId is the raw WhatsApp jid (e.g. '3361...@s.whatsapp.net' or
 * '...@g.us'), same format as whatsapp_get_chat — URL-encoded here since
 * it travels in the path, not the query string.
 */
export function buildChatMessagesPath(chatId: string, limit?: number): string {
  return `/messages/recent/${encodeURIComponent(chatId)}?limit=${clampLimit(limit)}`;
}
