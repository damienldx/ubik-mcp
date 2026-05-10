#!/usr/bin/env node
/**
 * Google Workspace — standalone MCP stdio server.
 *
 * Tools (21) — naming convention:
 *   gmail_<verb>_<object>  for Gmail tools
 *   google_<service>_<verb>_<object> for Drive / Calendar / Docs / Sheets
 *
 *   Gmail (7)
 *     - gmail_search_messages, gmail_read_message, gmail_send_message,
 *       gmail_trash_message, gmail_list_labels, gmail_create_label,
 *       gmail_get_attachment
 *
 *   Google Drive (5)
 *     - google_drive_list_files, google_drive_get_file,
 *       google_drive_upload_file, google_drive_create_folder,
 *       google_drive_share_file
 *
 *   Google Calendar (3)
 *     - google_calendar_list_events, google_calendar_create_event,
 *       google_calendar_delete_event
 *
 *   Google Docs (2)
 *     - google_docs_get, google_docs_create
 *
 *   Google Sheets (4)
 *     - google_sheets_get_values, google_sheets_update_values,
 *       google_sheets_append_values, google_sheets_create
 *
 * Auth: OAuth2 refresh-token flow against the Google token endpoint, using
 * native fetch. No UBIK-RELEASE dependency. Required env vars (loaded from
 * .env via dotenv):
 *   - GOOGLE_CLIENT_ID
 *   - GOOGLE_CLIENT_SECRET
 *   - GOOGLE_REFRESH_TOKEN
 *
 * Required scopes (delegated to the refresh token):
 *   - https://www.googleapis.com/auth/gmail.modify
 *   - https://www.googleapis.com/auth/drive
 *   - https://www.googleapis.com/auth/calendar
 *   - https://www.googleapis.com/auth/documents
 *   - https://www.googleapis.com/auth/spreadsheets
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ok(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ═════════════════════════════════════════════════════════════════════════════
//  Gmail (compléments)
// ═════════════════════════════════════════════════════════════════════════════

server.tool(
  "gmail_list_labels",
  "Lists every Gmail label visible to the authenticated user (system + user-defined).",
  {},
  async () => {
    const data = await gapi("https://gmail.googleapis.com/gmail/v1/users/me/labels");
    const labels = (data.labels ?? []).map((l: any) => ({
      id:   l.id,
      name: l.name,
      type: l.type,
    }));
    return ok({ count: labels.length, labels });
  },
);

server.tool(
  "gmail_create_label",
  "Creates a user-defined Gmail label and returns its new ID.",
  {
    name: z.string().min(1).describe("Display name of the label (slashes create nesting, e.g. 'Projects/Acme')."),
    labelListVisibility:   z.enum(["labelShow", "labelShowIfUnread", "labelHide"]).optional()
      .describe("Visibility in the label list (default labelShow)."),
    messageListVisibility: z.enum(["show", "hide"]).optional()
      .describe("Visibility in the message list (default show)."),
  },
  async ({ name, labelListVisibility, messageListVisibility }) => {
    const data = await gapi(
      "https://gmail.googleapis.com/gmail/v1/users/me/labels",
      {
        method: "POST",
        body:   JSON.stringify({
          name,
          labelListVisibility:   labelListVisibility   ?? "labelShow",
          messageListVisibility: messageListVisibility ?? "show",
        }),
      },
    );
    return ok({ id: data.id, name: data.name, type: data.type });
  },
);

server.tool(
  "gmail_get_attachment",
  "Downloads a Gmail attachment by message ID + attachment ID. Returns base64url-encoded binary data.",
  {
    messageId:    z.string().describe("Gmail message ID containing the attachment."),
    attachmentId: z.string().describe("Attachment ID (found inside the message payload parts)."),
  },
  async ({ messageId, attachmentId }) => {
    const data = await gapi(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/attachments/${attachmentId}`,
    );
    return ok({
      attachmentId,
      messageId,
      sizeBytes:    data.size ?? null,
      base64urlData: data.data ?? "",
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
//  Google Drive
// ═════════════════════════════════════════════════════════════════════════════

server.tool(
  "google_drive_list_files",
  "Lists files and folders in the user's Google Drive matching an optional query.",
  {
    query: z.string().optional().describe("Drive query (e.g. \"name contains 'budget' and mimeType='application/pdf'\"). Empty lists root."),
    limit: z.number().int().positive().max(1000).optional().describe("Max files to return (default 100, max 1000)."),
  },
  async ({ query, limit }) => {
    const params = new URLSearchParams({
      pageSize: String(limit ?? 100),
      fields:   "files(id,name,mimeType,modifiedTime,size,parents,webViewLink)",
    });
    if (query?.trim()) params.set("q", query.trim());
    const data = await gapi(`https://www.googleapis.com/drive/v3/files?${params.toString()}`);
    return ok({ count: (data.files ?? []).length, files: data.files ?? [] });
  },
);

server.tool(
  "google_drive_get_file",
  "Downloads the raw bytes of a Google Drive file as a base64-encoded string. Use Drive's native MIME export for Docs/Sheets/Slides instead — this returns binary content as-is.",
  {
    fileId: z.string().describe("Google Drive file ID."),
    maxBytes: z.number().int().positive().optional().describe("Hard cap on bytes returned (default 5_000_000 = 5 MB)."),
  },
  async ({ fileId, maxBytes }) => {
    const cap   = maxBytes ?? 5_000_000;
    const token = await getAccessToken();
    const res = await fetch(
      `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { content: [{ type: "text" as const, text: `Drive get error (${res.status}): ${redact(text)}` }], isError: true };
    }
    const buf  = Buffer.from(await res.arrayBuffer());
    const slim = buf.length > cap ? buf.subarray(0, cap) : buf;
    return ok({
      fileId,
      sizeBytes:    buf.length,
      truncated:    buf.length > cap,
      contentType:  res.headers.get("content-type") ?? null,
      base64Body:   slim.toString("base64"),
    });
  },
);

server.tool(
  "google_drive_upload_file",
  "Uploads a new file to Google Drive (multipart upload — metadata + body in a single request).",
  {
    name:        z.string().describe("Filename (with extension)."),
    contentBase64: z.string().describe("File content, base64-encoded."),
    mimeType:    z.string().optional().describe("MIME type of the file (default 'application/octet-stream')."),
    parentId:    z.string().optional().describe("Parent folder ID (default: My Drive root)."),
  },
  async ({ name, contentBase64, mimeType, parentId }) => {
    const token = await getAccessToken();
    const meta: Record<string, unknown> = { name };
    if (parentId) meta.parents = [parentId];
    if (mimeType) meta.mimeType = mimeType;

    const boundary = `ubik-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const ctype    = mimeType ?? "application/octet-stream";
    const body =
      `--${boundary}\r\n` +
      `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(meta)}\r\n` +
      `--${boundary}\r\n` +
      `Content-Type: ${ctype}\r\n` +
      `Content-Transfer-Encoding: base64\r\n\r\n` +
      `${contentBase64}\r\n` +
      `--${boundary}--`;

    const res = await fetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart",
      {
        method:  "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": `multipart/related; boundary=${boundary}`,
        },
        body,
      },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { content: [{ type: "text" as const, text: `Drive upload error (${res.status}): ${redact(text)}` }], isError: true };
    }
    const data = await res.json();
    return ok({ id: data.id, name: data.name, mimeType: data.mimeType, parents: data.parents });
  },
);

server.tool(
  "google_drive_create_folder",
  "Creates an empty folder in Google Drive.",
  {
    name:     z.string().describe("Folder name."),
    parentId: z.string().optional().describe("Parent folder ID (default: My Drive root)."),
  },
  async ({ name, parentId }) => {
    const meta: Record<string, unknown> = {
      name,
      mimeType: "application/vnd.google-apps.folder",
    };
    if (parentId) meta.parents = [parentId];

    const data = await gapi(
      "https://www.googleapis.com/drive/v3/files",
      { method: "POST", body: JSON.stringify(meta) },
    );
    return ok({ id: data.id, name: data.name, parents: data.parents ?? [] });
  },
);

server.tool(
  "google_drive_share_file",
  "Grants permission on a Drive file or folder. Default role 'reader' for the given email.",
  {
    fileId:       z.string().describe("Drive file or folder ID."),
    emailAddress: z.string().email().describe("Email address to grant access to."),
    role:         z.enum(["reader", "commenter", "writer", "fileOrganizer", "organizer", "owner"]).optional()
      .describe("Permission role (default 'reader')."),
    sendNotification: z.boolean().optional().describe("Whether Google should email a notification (default false)."),
  },
  async ({ fileId, emailAddress, role, sendNotification }) => {
    const params = new URLSearchParams();
    if (sendNotification === false) params.set("sendNotificationEmail", "false");
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}/permissions${
      params.toString() ? `?${params.toString()}` : ""
    }`;
    const data = await gapi(url, {
      method: "POST",
      body: JSON.stringify({
        type: "user",
        role: role ?? "reader",
        emailAddress,
      }),
    });
    return ok({ permissionId: data.id, role: data.role, type: data.type });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
//  Google Calendar
// ═════════════════════════════════════════════════════════════════════════════

server.tool(
  "google_calendar_list_events",
  "Lists upcoming events from the user's primary Google Calendar.",
  {
    timeMin: z.string().optional().describe("RFC3339 lower bound (default: now)."),
    timeMax: z.string().optional().describe("RFC3339 upper bound (default: 30 days from now)."),
    limit:   z.number().int().positive().max(250).optional().describe("Max events to return (default 25)."),
  },
  async ({ timeMin, timeMax, limit }) => {
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
    const params = new URLSearchParams({
      timeMin:      timeMin ?? now.toISOString(),
      timeMax:      timeMax ?? end.toISOString(),
      singleEvents: "true",
      orderBy:      "startTime",
      maxResults:   String(limit ?? 25),
    });
    const data = await gapi(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params.toString()}`,
    );
    const items = (data.items ?? []).map((e: any) => ({
      id:       e.id,
      summary:  e.summary,
      start:    e.start?.dateTime ?? e.start?.date ?? null,
      end:      e.end?.dateTime   ?? e.end?.date   ?? null,
      location: e.location ?? null,
      htmlLink: e.htmlLink ?? null,
    }));
    return ok({ count: items.length, events: items });
  },
);

server.tool(
  "google_calendar_create_event",
  "Creates an event in the user's primary Google Calendar.",
  {
    summary:     z.string().describe("Event title."),
    startIso:    z.string().describe("Start time, RFC3339 (e.g. '2026-05-12T09:00:00+02:00')."),
    endIso:      z.string().describe("End time, RFC3339."),
    description: z.string().optional().describe("Free-form description."),
    location:    z.string().optional().describe("Event location."),
    attendees:   z.array(z.string().email()).optional().describe("List of attendee email addresses."),
  },
  async ({ summary, startIso, endIso, description, location, attendees }) => {
    const body: Record<string, unknown> = {
      summary,
      start: { dateTime: startIso },
      end:   { dateTime: endIso },
    };
    if (description) body.description = description;
    if (location)    body.location    = location;
    if (attendees && attendees.length > 0) body.attendees = attendees.map((e) => ({ email: e }));

    const data = await gapi(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events",
      { method: "POST", body: JSON.stringify(body) },
    );
    return ok({ id: data.id, htmlLink: data.htmlLink, status: data.status });
  },
);

server.tool(
  "google_calendar_delete_event",
  "Deletes an event from the user's primary Google Calendar.",
  {
    eventId: z.string().describe("Calendar event ID."),
  },
  async ({ eventId }) => {
    await gapi(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
      { method: "DELETE" },
    );
    return ok({ deleted: true, eventId });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
//  Google Docs
// ═════════════════════════════════════════════════════════════════════════════

server.tool(
  "google_docs_get",
  "Reads a Google Docs document and returns the structured content (title + concatenated plain text).",
  {
    documentId: z.string().describe("Google Docs document ID."),
  },
  async ({ documentId }) => {
    const data = await gapi(
      `https://docs.googleapis.com/v1/documents/${encodeURIComponent(documentId)}`,
    );
    const elements = data.body?.content ?? [];
    const text: string[] = [];
    for (const el of elements) {
      const para = el?.paragraph;
      if (!para) continue;
      for (const run of para.elements ?? []) {
        if (run.textRun?.content) text.push(run.textRun.content);
      }
    }
    return ok({
      documentId,
      title:   data.title ?? null,
      revision: data.revisionId ?? null,
      text:    text.join(""),
    });
  },
);

server.tool(
  "google_docs_create",
  "Creates a new (empty) Google Docs document with the given title.",
  {
    title: z.string().describe("Document title."),
  },
  async ({ title }) => {
    const data = await gapi(
      "https://docs.googleapis.com/v1/documents",
      { method: "POST", body: JSON.stringify({ title }) },
    );
    return ok({
      documentId: data.documentId,
      title:      data.title,
      revisionId: data.revisionId ?? null,
    });
  },
);

// ═════════════════════════════════════════════════════════════════════════════
//  Google Sheets
// ═════════════════════════════════════════════════════════════════════════════

server.tool(
  "google_sheets_get_values",
  "Reads cell values from a Google Sheets range (A1 notation).",
  {
    spreadsheetId: z.string().describe("Spreadsheet ID."),
    range:         z.string().describe("A1 notation range, e.g. 'Sheet1!A1:D20'."),
    majorDimension: z.enum(["ROWS", "COLUMNS"]).optional().describe("Orientation of the values returned (default ROWS)."),
  },
  async ({ spreadsheetId, range, majorDimension }) => {
    const params = new URLSearchParams();
    if (majorDimension) params.set("majorDimension", majorDimension);
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}${
      params.toString() ? `?${params.toString()}` : ""
    }`;
    const data = await gapi(url);
    return ok({
      spreadsheetId,
      range:          data.range ?? range,
      majorDimension: data.majorDimension ?? "ROWS",
      values:         data.values ?? [],
      rowCount:       (data.values ?? []).length,
    });
  },
);

server.tool(
  "google_sheets_update_values",
  "Overwrites cell values in a Google Sheets range (USER_ENTERED — formulas evaluated, dates parsed).",
  {
    spreadsheetId: z.string().describe("Spreadsheet ID."),
    range:         z.string().describe("A1 notation range, e.g. 'Sheet1!A1:B2'."),
    values:        z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
      .describe("2D array of cell values aligned to the range (rows × columns)."),
  },
  async ({ spreadsheetId, range, values }) => {
    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
    const data = await gapi(url, {
      method: "PUT",
      body:   JSON.stringify({ range, values, majorDimension: "ROWS" }),
    });
    return ok({
      spreadsheetId,
      updatedRange:   data.updatedRange  ?? range,
      updatedRows:    data.updatedRows   ?? null,
      updatedColumns: data.updatedColumns ?? null,
      updatedCells:   data.updatedCells  ?? null,
    });
  },
);

server.tool(
  "google_sheets_append_values",
  "Appends rows at the end of an existing Google Sheets range (auto-extends the table).",
  {
    spreadsheetId: z.string().describe("Spreadsheet ID."),
    range:         z.string().describe("A1 notation anchor range, e.g. 'Sheet1!A:D'."),
    values:        z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
      .describe("2D array of rows to append."),
    insertDataOption: z.enum(["OVERWRITE", "INSERT_ROWS"]).optional()
      .describe("Whether to overwrite existing rows or insert (default INSERT_ROWS)."),
  },
  async ({ spreadsheetId, range, values, insertDataOption }) => {
    const params = new URLSearchParams({ valueInputOption: "USER_ENTERED" });
    if (insertDataOption) params.set("insertDataOption", insertDataOption);
    else                  params.set("insertDataOption", "INSERT_ROWS");

    const url = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}:append?${params.toString()}`;
    const data = await gapi(url, {
      method: "POST",
      body:   JSON.stringify({ range, values, majorDimension: "ROWS" }),
    });
    return ok({
      spreadsheetId,
      updatedRange:   data.updates?.updatedRange   ?? null,
      updatedRows:    data.updates?.updatedRows    ?? null,
      updatedCells:   data.updates?.updatedCells   ?? null,
    });
  },
);

server.tool(
  "google_sheets_create",
  "Creates a new (empty) Google Sheets spreadsheet with the given title.",
  {
    title: z.string().describe("Spreadsheet title."),
    sheetTitle: z.string().optional().describe("Optional title for the first sheet (default 'Sheet1')."),
  },
  async ({ title, sheetTitle }) => {
    const body: Record<string, unknown> = {
      properties: { title },
    };
    if (sheetTitle) {
      body.sheets = [{ properties: { title: sheetTitle } }];
    }
    const data = await gapi(
      "https://sheets.googleapis.com/v4/spreadsheets",
      { method: "POST", body: JSON.stringify(body) },
    );
    return ok({
      spreadsheetId: data.spreadsheetId,
      title:         data.properties?.title,
      sheets:        (data.sheets ?? []).map((s: any) => ({
        sheetId: s.properties?.sheetId,
        title:   s.properties?.title,
      })),
      url:           data.spreadsheetUrl ?? null,
    });
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-google] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
