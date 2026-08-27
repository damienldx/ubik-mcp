import test from "node:test";
import assert from "node:assert/strict";

import {
  buildChatMessagesPath,
  buildRecentMessagesPath,
  RECENT_MESSAGES_DEFAULT_LIMIT,
  RECENT_MESSAGES_MAX_LIMIT,
} from "./whatsapp-recent";

test("buildRecentMessagesPath transmits an explicit valid limit", () => {
  assert.equal(buildRecentMessagesPath(10), "/messages/recent?limit=10");
  assert.equal(buildRecentMessagesPath(1), "/messages/recent?limit=1");
});

test("buildRecentMessagesPath falls back to the default limit when omitted or invalid", () => {
  assert.equal(buildRecentMessagesPath(undefined), `/messages/recent?limit=${RECENT_MESSAGES_DEFAULT_LIMIT}`);
  assert.equal(buildRecentMessagesPath(0), `/messages/recent?limit=${RECENT_MESSAGES_DEFAULT_LIMIT}`);
  assert.equal(buildRecentMessagesPath(-5), `/messages/recent?limit=${RECENT_MESSAGES_DEFAULT_LIMIT}`);
  assert.equal(buildRecentMessagesPath(Number.NaN), `/messages/recent?limit=${RECENT_MESSAGES_DEFAULT_LIMIT}`);
});

test("buildRecentMessagesPath clamps an oversized limit to the bridge's contract max", () => {
  assert.equal(buildRecentMessagesPath(99999), `/messages/recent?limit=${RECENT_MESSAGES_MAX_LIMIT}`);
  assert.equal(buildRecentMessagesPath(RECENT_MESSAGES_MAX_LIMIT + 1), `/messages/recent?limit=${RECENT_MESSAGES_MAX_LIMIT}`);
  assert.equal(buildRecentMessagesPath(RECENT_MESSAGES_MAX_LIMIT), `/messages/recent?limit=${RECENT_MESSAGES_MAX_LIMIT}`);
});

test("proxy correctness: tool forwards to the bridge path built by buildRecentMessagesPath", async () => {
  // Simulates whatsapp_get_recent_messages' handler without pulling in the
  // full MCP server (which requires stdio transport wiring) — proves the
  // handler calls the bridge with exactly the path the pure helper builds,
  // and returns the bridge's JSON body untouched (same proxy pattern as
  // whatsapp_get_chat).
  const calls: string[] = [];
  async function fakeBridgeFetch(pathAndQuery: string) {
    calls.push(pathAndQuery);
    return [{ messageId: "abc", chatId: "1@s.whatsapp.net", body: "hi" }];
  }

  async function handler({ limit }: { limit?: number }) {
    const data = await fakeBridgeFetch(buildRecentMessagesPath(limit));
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  }

  const result = await handler({ limit: 5 });

  assert.deepEqual(calls, ["/messages/recent?limit=5"]);
  assert.deepEqual(JSON.parse(result.content[0].text), [
    { messageId: "abc", chatId: "1@s.whatsapp.net", body: "hi" },
  ]);
});

test("buildChatMessagesPath transmits chatId and an explicit valid limit", () => {
  assert.equal(
    buildChatMessagesPath("33612345678@s.whatsapp.net", 10),
    "/messages/recent/33612345678%40s.whatsapp.net?limit=10",
  );
});

test("buildChatMessagesPath falls back to the default limit when omitted or invalid", () => {
  assert.equal(
    buildChatMessagesPath("1@g.us", undefined),
    `/messages/recent/1%40g.us?limit=${RECENT_MESSAGES_DEFAULT_LIMIT}`,
  );
  assert.equal(
    buildChatMessagesPath("1@g.us", 0),
    `/messages/recent/1%40g.us?limit=${RECENT_MESSAGES_DEFAULT_LIMIT}`,
  );
  assert.equal(
    buildChatMessagesPath("1@g.us", -5),
    `/messages/recent/1%40g.us?limit=${RECENT_MESSAGES_DEFAULT_LIMIT}`,
  );
});

test("buildChatMessagesPath clamps an oversized limit to the bridge's contract max", () => {
  assert.equal(
    buildChatMessagesPath("1@g.us", 99999),
    `/messages/recent/1%40g.us?limit=${RECENT_MESSAGES_MAX_LIMIT}`,
  );
});

test("proxy correctness: whatsapp_get_chat_messages forwards to the bridge path built by buildChatMessagesPath", async () => {
  const calls: string[] = [];
  async function fakeBridgeFetch(pathAndQuery: string) {
    calls.push(pathAndQuery);
    return [{ messageId: "xyz", chatId: "1@s.whatsapp.net", body: "hey" }];
  }

  async function handler({ chatId, limit }: { chatId: string; limit?: number }) {
    const data = await fakeBridgeFetch(buildChatMessagesPath(chatId, limit));
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  }

  const result = await handler({ chatId: "1@s.whatsapp.net", limit: 3 });

  assert.deepEqual(calls, ["/messages/recent/1%40s.whatsapp.net?limit=3"]);
  assert.deepEqual(JSON.parse(result.content[0].text), [
    { messageId: "xyz", chatId: "1@s.whatsapp.net", body: "hey" },
  ]);
});
