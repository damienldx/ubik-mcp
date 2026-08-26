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

/** Builds the bridge path+query for GET /messages/recent, clamping limit
 *  client-side to match the bridge's own contract (defense in depth —
 *  the bridge also clamps, but a caller passing e.g. limit=99999 should
 *  see the effective, capped value it will actually get back). */
export function buildRecentMessagesPath(limit?: number): string {
  let effective = limit;
  if (typeof effective !== "number" || !Number.isFinite(effective) || effective <= 0) {
    effective = RECENT_MESSAGES_DEFAULT_LIMIT;
  }
  effective = Math.min(effective, RECENT_MESSAGES_MAX_LIMIT);
  return `/messages/recent?limit=${effective}`;
}
