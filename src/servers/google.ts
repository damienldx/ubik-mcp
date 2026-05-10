#!/usr/bin/env node
/**
 * Google Workspace — standalone MCP stdio server.
 *
 * Tools (4):
 *   - gmail_search_messages  Search emails (Gmail query syntax) and list summaries.
 *   - gmail_read_message     Read one full email by ID (headers + body).
 *   - gmail_send_message     Send a plain-text or HTML email.
 *   - gmail_trash_message    Move one email to the trash by ID.
 *
 * Auth: OAuth2 refresh-token flow against the Google token endpoint, using
 * native fetch. No UBIK-RELEASE dependency. Required env vars (loaded from
 * .env via dotenv):
 *   - GOOGLE_CLIENT_ID
 *   - GOOGLE_CLIENT_SECRET
 *   - GOOGLE_REFRESH_TOKEN
 *
 * Run with: tsx src/servers/google.ts
 */
import { config } from "dotenv";
import { join } from "node:path";
import { z } from "zod";

import { createMcpServer, runServer } from "../lib/server";

config({ path: join(process.cwd(), ".env") });

// ─── OAuth2 token cache ───

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SAFETY_MARGIN_MS = 30_000; // refresh 30s before expiry

type CachedToken = { token: string; expiresAt: number };
let cached: CachedToken | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + SAFETY_MARGIN_MS) {
    return cached.token;
  }
  const clientId     = requireEnv("GOOGLE_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CLIENT_SECRET");
  const refreshToken = requireEnv("GOOGLE_REFRESH_TOKEN");

  const body = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type:    "refresh_token",
  });

  const res = await fetch(TOKEN_URL, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google OAuth refresh failed (${res.status}): ${redact(text)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  cached = {
    token:     data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  return cached.token;
}

function redact(s: string): string {
  return s
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(["']?)(client_secret|refresh_token|access_token|token)\1\s*[:=]\s*["']?[^"'&\s]+["']?/gi,
             '$1$2$1=[REDACTED]');
}

// ─── Gmail API helper (with retry on 429/5xx and timeout) ───

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES        = 3;

async function gapi(
  url:     string,
  options: RequestInit = {},
): Promise<any> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const token      = await getAccessToken();
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(url, {
        ...options,
        signal:  controller.signal,
        headers: {
          Authorization:  `Bearer ${token}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      });
      clearTimeout(timer);

      if (res.ok) {
        if (res.status === 204) return null;
        return res.json();
      }
      if (res.status === 401) {
        // Token may have been revoked — invalidate cache and retry once.
        cached = null;
        if (attempt === 0) continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(Math.min(1000 * 2 ** attempt, 8000));
        continue;
      }
      const errText = await res.text().catch(() => "");
      throw new Error(`Gmail API error (${res.status}): ${redact(errText)}`);
    } catch (e: any) {
      lastError = e;
      const transient = e?.name === "AbortError"
        || e?.message?.includes("ETIMEDOUT")
        || e?.message?.includes("fetch failed");
      if (transient && attempt < MAX_RETRIES - 1) {
        await sleep(Math.min(1000 * 2 ** attempt, 8000));
        continue;
      }
      throw e;
    }
  }
  throw lastError ?? new Error("Gmail API: max retries exceeded");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── MCP server + tools ───

const server = createMcpServer("ubik-google", "1.0.0");

server.tool(
  "gmail_search_messages",
  "Searches emails in Gmail using the standard Gmail query syntax and returns a numbered summary list with message IDs.",
  {
    query:      z.string().default("").describe("Gmail search query (e.g. 'from:someone subject:hello'). Empty string lists the latest inbox messages."),
    labelId:    z.string().optional().describe("Gmail label ID to filter by (e.g. 'INBOX', 'TRASH', or a custom label ID)."),
    maxResults: z.number().int().positive().max(100).default(10).describe("Maximum number of message summaries to return (1-100)."),
  },
  async ({ query, labelId, maxResults }) => {
    let q = query?.trim() ? query.trim() : "in:inbox";
    if (labelId) q = `label:${labelId} ${q}`;

    let data: any;
    try {
      data = await gapi(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`,
      );
    } catch (err: any) {
      // Retry once with simplified query if Gmail rejects it as malformed.
      const simplified = q.replace(/['"()]/g, "").replace(/\bOR\b/gi, " ").replace(/\s+/g, " ").trim();
      if (simplified !== q) {
        data = await gapi(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(simplified)}&maxResults=${maxResults}`,
        );
      } else {
        return { content: [{ type: "text", text: `Gmail search error: ${err.message}` }], isError: true };
      }
    }

    if (!data?.messages?.length) {
      return { content: [{ type: "text", text: "No messages found." }] };
    }

    const ids: string[] = [];
    const summaries = await Promise.all(
      data.messages.slice(0, maxResults).map(async (m: any, i: number) => {
        const msg = await gapi(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=METADATA&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`,
        );
        const headers = msg.payload?.headers ?? [];
        const get     = (n: string): string => headers.find((h: any) => h.name === n)?.value ?? "";
        const labels  = msg.labelIds ?? [];
        const unread  = labels.includes("UNREAD") ? " ★" : "";
        ids.push(`#${i + 1}=${m.id}`);
        return `${i + 1}. ${get("From")} — ${get("Subject")}${unread} (${get("Date")})`;
      }),
    );
    const text = summaries.join("\n") + "\n\n[IDs pour gmail_read: " + ids.join(", ") + "]";
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "gmail_read_message",
  "Reads one full Gmail email by message ID and returns headers + decoded body (plain text, falls back to stripped HTML).",
  { messageId: z.string().describe("Gmail message ID (as returned by gmail_search_messages).") },
  async ({ messageId }) => {
    const msg     = await gapi(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=FULL`);
    const headers = msg.payload?.headers ?? [];
    const get     = (n: string): string => headers.find((h: any) => h.name === n)?.value ?? "";

    let body = extractTextBody(msg.payload);
    if (!body) {
      const html = extractHtmlBody(msg.payload);
      if (html) {
        body = "[HTML content] " + html.replace(/<[^>]+>/g, " ").substring(0, 2000);
      }
    }

    const text = `From: ${get("From")}\nTo: ${get("To")}\nDate: ${get("Date")}\nSubject: ${get("Subject")}\n\n${body || "(empty body)"}`;
    return { content: [{ type: "text", text }] };
  },
);

function extractTextBody(payload: any): string {
  const parts = payload?.parts ?? [payload];
  for (const part of parts) {
    if (part?.mimeType === "text/plain" && part.body?.data) {
      return Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
    if (part?.parts) {
      const nested = extractTextBody(part);
      if (nested) return nested;
    }
  }
  return "";
}

function extractHtmlBody(payload: any): string {
  const parts = payload?.parts ?? [payload];
  for (const part of parts) {
    if (part?.mimeType === "text/html" && part.body?.data) {
      return Buffer.from(part.body.data, "base64url").toString("utf-8");
    }
    if (part?.parts) {
      const nested = extractHtmlBody(part);
      if (nested) return nested;
    }
  }
  return "";
}

server.tool(
  "gmail_send_message",
  "Sends an email via the authenticated Gmail account (plain text or HTML).",
  {
    to:      z.string().describe("Recipient email address."),
    subject: z.string().describe("Email subject (UTF-8 supported)."),
    body:    z.string().describe("Email body — plain text by default, HTML if isHtml=true."),
    isHtml:  z.boolean().optional().describe("Set to true to send the body as HTML (default: false)."),
  },
  async ({ to, subject, body, isHtml }) => {
    const contentType = isHtml ? "text/html" : "text/plain";
    const subjectB64  = Buffer.from(subject).toString("base64");
    const message =
      `To: ${to}\r\n` +
      `Subject: =?utf-8?B?${subjectB64}?=\r\n` +
      `Content-Type: ${contentType}; charset=utf-8\r\n\r\n` +
      `${body}`;
    const raw = Buffer.from(message).toString("base64url");

    const result = await gapi(
      "https://gmail.googleapis.com/gmail/v1/users/me/messages/send",
      { method: "POST", body: JSON.stringify({ raw }) },
    );
    return { content: [{ type: "text", text: `Email sent (ID: ${result.id})` }] };
  },
);

server.tool(
  "gmail_trash_message",
  "Moves one Gmail email to the trash by message ID (the message is not permanently deleted).",
  { messageId: z.string().describe("Gmail message ID to move to trash.") },
  async ({ messageId }) => {
    await gapi(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/trash`,
      { method: "POST" },
    );
    return { content: [{ type: "text", text: `Message ${messageId} moved to trash.` }] };
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-google] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
