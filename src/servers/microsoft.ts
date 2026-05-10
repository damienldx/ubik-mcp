#!/usr/bin/env node
/**
 * Microsoft 365 (Outlook) — standalone MCP stdio server.
 *
 * Tools (4) — naming convention `microsoft_<verb>_<object>`:
 *   - microsoft_search_emails  — Search the user's Outlook inbox.
 *   - microsoft_read_email     — Read a single email by message ID.
 *   - microsoft_send_email     — Send an email from the user's account.
 *   - microsoft_create_draft   — Create a draft email without sending.
 *
 * Auth: OAuth2 refresh-token flow against Microsoft identity platform, using
 * native fetch. No UBIK-RELEASE dependency. Required env vars (loaded from
 * .env via dotenv):
 *   - MICROSOFT_CLIENT_ID
 *   - MICROSOFT_CLIENT_SECRET
 *   - MICROSOFT_REFRESH_TOKEN
 *   - MICROSOFT_TENANT_ID (optional, defaults to 'common')
 *   - MICROSOFT_SCOPE     (optional, defaults to delegated Graph mail scopes)
 *
 * Run with: tsx src/servers/microsoft.ts
 */
import { config } from "dotenv";
import { join } from "node:path";
import { z } from "zod";

import { createMcpServer, runServer } from "../lib/server";

config({ path: join(process.cwd(), ".env") });

// ─── Constants ───

const GRAPH = "https://graph.microsoft.com/v1.0";
const DEFAULT_SCOPE =
  "offline_access Mail.Read Mail.Send Mail.ReadWrite";
const SAFETY_MARGIN_MS  = 30_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RETRIES        = 3;

// ─── OAuth2 token cache ───

type CachedToken = { token: string; expiresAt: number };
let cached: CachedToken | null = null;

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

function tokenUrl(): string {
  const tenant = process.env.MICROSOFT_TENANT_ID || "common";
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`;
}

async function getAccessToken(): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + SAFETY_MARGIN_MS) {
    return cached.token;
  }
  const clientId     = requireEnv("MICROSOFT_CLIENT_ID");
  const clientSecret = requireEnv("MICROSOFT_CLIENT_SECRET");
  const refreshToken = requireEnv("MICROSOFT_REFRESH_TOKEN");
  const scope        = process.env.MICROSOFT_SCOPE || DEFAULT_SCOPE;

  const body = new URLSearchParams({
    client_id:     clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type:    "refresh_token",
    scope,
  });

  const res = await fetch(tokenUrl(), {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body:    body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Microsoft OAuth refresh failed (${res.status}): ${redact(text)}`);
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

// ─── Microsoft Graph helper (with retry on 429/5xx and timeout) ───

async function graph(
  endpoint: string,
  options:  RequestInit = {},
): Promise<any> {
  let lastError: Error | null = null;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const token      = await getAccessToken();
      const controller = new AbortController();
      const timer      = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const res = await fetch(`${GRAPH}${endpoint}`, {
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
        cached = null;
        if (attempt === 0) continue;
      }
      if (res.status === 429 || res.status >= 500) {
        await sleep(Math.min(1000 * 2 ** attempt, 8000));
        continue;
      }
      const errText = await res.text().catch(() => "");
      throw new Error(`Microsoft Graph error (${res.status}): ${redact(errText)}`);
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
  throw lastError ?? new Error("Microsoft Graph: max retries exceeded");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── MCP server + tools ───

const server = createMcpServer("ubik-microsoft", "1.0.0");

server.tool(
  "microsoft_search_emails",
  "Searches emails in the user's Outlook mailbox; an empty query returns the latest received messages.",
  {
    query:      z.string().default("").describe("Search query (e.g. 'from:someone subject:hello'). Empty = latest emails."),
    maxResults: z.number().int().positive().max(100).default(10).describe("Maximum number of messages to return (1–100, default 10)."),
  },
  async ({ query, maxResults }) => {
    // $orderby is not supported alongside $search on Graph API.
    const url = query?.trim()
      ? `/me/messages?$search="${encodeURIComponent(query.trim())}"&$top=${maxResults}&$select=id,subject,from,receivedDateTime,isRead`
      : `/me/messages?$top=${maxResults}&$select=id,subject,from,receivedDateTime,isRead&$orderby=receivedDateTime desc`;

    const data = await graph(url);
    if (!data?.value?.length) {
      return { content: [{ type: "text", text: "No messages found." }] };
    }

    const lines: string[]   = data.value.map((m: any, i: number) => {
      const from   = m.from?.emailAddress?.name || m.from?.emailAddress?.address || "?";
      const date   = m.receivedDateTime
        ? new Date(m.receivedDateTime).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" })
        : "?";
      const unread = m.isRead ? "" : " ★";
      return `${i + 1}. ${from} — ${m.subject}${unread} (${date})`;
    });
    const idMap: string[]   = data.value.map((m: any, i: number) => `#${i + 1}=${m.id}`);
    const text = lines.join("\n") + "\n\n[IDs for microsoft_read_email: " + idMap.join(", ") + "]";
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "microsoft_read_email",
  "Reads a single Outlook email by its message ID and returns headers and body.",
  { messageId: z.string().describe("Outlook message ID (returned by microsoft_search_emails)") },
  async ({ messageId }) => {
    const msg = await graph(
      `/me/messages/${encodeURIComponent(messageId)}?$select=subject,from,toRecipients,receivedDateTime,body`,
    );
    const body = msg.body?.contentType === "text"
      ? (msg.body?.content ?? "")
      : (msg.body?.content ?? "").replace(/<[^>]+>/g, " ").substring(0, 5000);

    const text =
      `From: ${msg.from?.emailAddress?.address ?? "?"}\n` +
      `To: ${(msg.toRecipients ?? []).map((r: any) => r.emailAddress?.address).filter(Boolean).join(", ")}\n` +
      `Date: ${msg.receivedDateTime ?? "?"}\n` +
      `Subject: ${msg.subject ?? "(no subject)"}\n\n` +
      `${body || "(empty body)"}`;
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "microsoft_send_email",
  "Sends an email from the user's Outlook account. The message is also saved to Sent Items.",
  {
    to:      z.string().describe("Recipient email address(es), comma-separated."),
    subject: z.string().describe("Email subject."),
    body:    z.string().describe("Email body (plain text by default; set isHtml=true for HTML)."),
    cc:      z.string().optional().describe("CC recipient(s), comma-separated."),
    isHtml:  z.boolean().optional().describe("Set true if `body` should be sent as HTML (default false = plain text)."),
  },
  async ({ to, subject, body, cc, isHtml }) => {
    const recipients = (s: string) =>
      s.split(",").map((e) => e.trim()).filter(Boolean).map((e) => ({ emailAddress: { address: e } }));

    const message: any = {
      subject,
      body: { contentType: isHtml ? "HTML" : "Text", content: body },
      toRecipients: recipients(to),
    };
    if (cc) message.ccRecipients = recipients(cc);

    await graph("/me/sendMail", {
      method: "POST",
      body:   JSON.stringify({ message, saveToSentItems: true }),
    });
    return { content: [{ type: "text", text: `Email sent to ${to}.` }] };
  },
);

server.tool(
  "microsoft_create_draft",
  "Creates a draft email in the user's Outlook drafts folder without sending it. Returns the new draft ID.",
  {
    to:      z.string().describe("Recipient email address(es), comma-separated."),
    subject: z.string().describe("Email subject."),
    body:    z.string().describe("Email body (plain text by default; set isHtml=true for HTML)."),
    isHtml:  z.boolean().optional().describe("Set true if `body` should be stored as HTML (default false = plain text)."),
  },
  async ({ to, subject, body, isHtml }) => {
    const recipients = to
      .split(",")
      .map((e) => e.trim())
      .filter(Boolean)
      .map((e) => ({ emailAddress: { address: e } }));

    const result = await graph("/me/messages", {
      method: "POST",
      body: JSON.stringify({
        subject,
        body:         { contentType: isHtml ? "HTML" : "Text", content: body },
        toRecipients: recipients,
      }),
    });
    return { content: [{ type: "text", text: `Draft created (ID: ${result.id})` }] };
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-microsoft] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
