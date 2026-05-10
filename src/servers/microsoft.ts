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

// ─── Calendar tools ──────────────────────────────────────────────────────────

server.tool(
  "microsoft_list_events",
  "Lists Outlook calendar events for the current user, optionally bounded by time window.",
  {
    top:           z.number().int().positive().max(100).default(20).describe("Max events returned"),
    startDateTime: z.string().optional().describe("ISO 8601 lower bound (e.g. '2026-05-10T00:00:00Z')"),
    endDateTime:   z.string().optional().describe("ISO 8601 upper bound"),
  },
  async ({ top, startDateTime, endDateTime }) => {
    const params = new URLSearchParams({
      $top:    String(top),
      $select: "id,subject,start,end,location,organizer",
      $orderby: "start/dateTime",
    });
    let endpoint = "/me/events";
    if (startDateTime && endDateTime) {
      endpoint = "/me/calendarView";
      params.set("startDateTime", startDateTime);
      params.set("endDateTime", endDateTime);
    }
    const data = await graph(`${endpoint}?${params.toString()}`);
    const events = data?.value ?? [];
    if (!events.length) return { content: [{ type: "text", text: "No events found." }] };
    const lines = events.map((e: any, i: number) => {
      const subject = e.subject || "(no subject)";
      const start   = e.start?.dateTime || "?";
      const end     = e.end?.dateTime || "?";
      const loc     = e.location?.displayName ? ` @ ${e.location.displayName}` : "";
      return `${i + 1}. ${subject}${loc} — ${start} → ${end} (id: ${e.id})`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.tool(
  "microsoft_create_event",
  "Creates a calendar event in the current user's default calendar.",
  {
    subject:   z.string().describe("Event title"),
    start:     z.string().describe("ISO 8601 start datetime (e.g. '2026-05-10T14:00:00')"),
    end:       z.string().describe("ISO 8601 end datetime"),
    timeZone:  z.string().optional().describe("IANA timezone (default 'UTC')"),
    body:      z.string().optional().describe("Event body / description"),
    isHtml:    z.boolean().optional().describe("True if body is HTML"),
    attendees: z.string().optional().describe("Attendee email(s), comma-separated"),
  },
  async ({ subject, start, end, timeZone, body, isHtml, attendees }) => {
    const tz = timeZone || "UTC";
    const event: any = {
      subject,
      start: { dateTime: start, timeZone: tz },
      end:   { dateTime: end,   timeZone: tz },
    };
    if (body) {
      event.body = { contentType: isHtml ? "HTML" : "Text", content: body };
    }
    if (attendees) {
      event.attendees = attendees
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean)
        .map((a) => ({ emailAddress: { address: a }, type: "required" }));
    }
    const result = await graph("/me/events", { method: "POST", body: JSON.stringify(event) });
    return { content: [{ type: "text", text: `Event created (id: ${result.id})\n${subject} — ${start} → ${end}` }] };
  },
);

server.tool(
  "microsoft_delete_event",
  "Deletes a calendar event by id.",
  {
    eventId: z.string().describe("Event id from microsoft_list_events"),
  },
  async ({ eventId }) => {
    await graph(`/me/events/${encodeURIComponent(eventId)}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Event ${eventId} deleted.` }] };
  },
);

// ─── OneDrive tools ──────────────────────────────────────────────────────────

server.tool(
  "microsoft_drive_list_files",
  "Lists files and folders in OneDrive at a given path (default: root).",
  {
    path:  z.string().optional().describe("Folder path relative to drive root (e.g. 'Documents/Reports'). Empty = root."),
    limit: z.number().int().positive().max(200).default(50).describe("Max items returned"),
  },
  async ({ path, limit }) => {
    const trimmed = (path || "").trim().replace(/^\/+|\/+$/g, "");
    const endpoint = trimmed
      ? `/me/drive/root:/${encodeURIComponent(trimmed).replace(/%2F/g, "/")}:/children`
      : `/me/drive/root/children`;
    const data = await graph(`${endpoint}?$top=${limit}&$select=id,name,size,folder,file,lastModifiedDateTime`);
    const items = data?.value ?? [];
    if (!items.length) return { content: [{ type: "text", text: "No items found." }] };
    const lines = items.map((it: any, i: number) => {
      const kind = it.folder ? "📁" : "📄";
      const size = it.size ? ` (${it.size} bytes)` : "";
      const date = it.lastModifiedDateTime ? ` — ${it.lastModifiedDateTime.slice(0, 10)}` : "";
      return `${i + 1}. ${kind} ${it.name}${size}${date} (id: ${it.id})`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.tool(
  "microsoft_drive_get_file",
  "Downloads a OneDrive file as text by path. Use only for text files (md, txt, json, csv, code).",
  {
    path:    z.string().describe("File path relative to drive root (e.g. 'Documents/notes.md')"),
    maxBytes: z.number().int().positive().max(500_000).default(80_000).describe("Cap on bytes returned (default 80KB)"),
  },
  async ({ path, maxBytes }) => {
    const trimmed = path.trim().replace(/^\/+/, "");
    const token   = await getAccessToken();
    const url     = `${GRAPH}/me/drive/root:/${encodeURIComponent(trimmed).replace(/%2F/g, "/")}:/content`;
    const res     = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Microsoft Graph error (${res.status}): ${redact(err)}`);
    }
    const buf  = Buffer.from(await res.arrayBuffer());
    const slice = buf.subarray(0, maxBytes);
    const text  = slice.toString("utf-8");
    const truncated = buf.length > maxBytes;
    return { content: [{ type: "text", text: `# ${path} (${buf.length} bytes${truncated ? ", truncated" : ""})\n\n${text}` }] };
  },
);

server.tool(
  "microsoft_drive_upload_file",
  "Uploads or overwrites a file in OneDrive (small files only, max ~4MB).",
  {
    path:        z.string().describe("Target path relative to drive root (e.g. 'Documents/upload.txt')"),
    content:     z.string().describe("File content as string (UTF-8)"),
    contentType: z.string().optional().describe("MIME type (default 'text/plain')"),
  },
  async ({ path, content, contentType }) => {
    const trimmed = path.trim().replace(/^\/+/, "");
    const token   = await getAccessToken();
    const url     = `${GRAPH}/me/drive/root:/${encodeURIComponent(trimmed).replace(/%2F/g, "/")}:/content`;
    const res     = await fetch(url, {
      method:  "PUT",
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": contentType || "text/plain",
      },
      body: content,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      throw new Error(`Microsoft Graph error (${res.status}): ${redact(err)}`);
    }
    const data = await res.json();
    return { content: [{ type: "text", text: `Uploaded ${trimmed} (id: ${data.id}, size: ${data.size} bytes)` }] };
  },
);

server.tool(
  "microsoft_drive_create_folder",
  "Creates a new folder in OneDrive at a given parent path.",
  {
    parentPath: z.string().optional().describe("Parent folder path (empty = root)"),
    name:       z.string().describe("New folder name"),
  },
  async ({ parentPath, name }) => {
    const trimmed = (parentPath || "").trim().replace(/^\/+|\/+$/g, "");
    const endpoint = trimmed
      ? `/me/drive/root:/${encodeURIComponent(trimmed).replace(/%2F/g, "/")}:/children`
      : `/me/drive/root/children`;
    const result = await graph(endpoint, {
      method: "POST",
      body: JSON.stringify({ name, folder: {}, "@microsoft.graph.conflictBehavior": "rename" }),
    });
    return { content: [{ type: "text", text: `Folder created: ${result.name} (id: ${result.id})` }] };
  },
);

// ─── Teams chats tools ───────────────────────────────────────────────────────

server.tool(
  "microsoft_list_chats",
  "Lists Teams chats (1:1, group, meeting) the current user participates in.",
  {
    top: z.number().int().positive().max(50).default(20).describe("Max chats returned"),
  },
  async ({ top }) => {
    const data = await graph(`/me/chats?$top=${top}&$select=id,topic,chatType,lastUpdatedDateTime`);
    const chats = data?.value ?? [];
    if (!chats.length) return { content: [{ type: "text", text: "No chats found." }] };
    const lines = chats.map((c: any, i: number) => {
      const topic = c.topic || `(${c.chatType || "chat"})`;
      const date  = c.lastUpdatedDateTime?.slice(0, 19) || "?";
      return `${i + 1}. ${topic} — last update ${date} (id: ${c.id})`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.tool(
  "microsoft_list_chat_messages",
  "Lists messages in a Teams chat by chat id.",
  {
    chatId: z.string().describe("Chat id from microsoft_list_chats"),
    top:    z.number().int().positive().max(50).default(20).describe("Max messages returned"),
  },
  async ({ chatId, top }) => {
    const data = await graph(`/me/chats/${encodeURIComponent(chatId)}/messages?$top=${top}`);
    const messages = data?.value ?? [];
    if (!messages.length) return { content: [{ type: "text", text: "No messages in this chat." }] };
    const lines = messages.map((m: any, i: number) => {
      const from    = m.from?.user?.displayName || "(system)";
      const date    = m.createdDateTime?.slice(0, 19) || "?";
      const content = m.body?.content
        ? m.body.content.replace(/<[^>]+>/g, " ").trim().substring(0, 200)
        : "(empty)";
      return `${i + 1}. [${date}] ${from}: ${content}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.tool(
  "microsoft_send_chat_message",
  "Sends a message into a Teams chat.",
  {
    chatId: z.string().describe("Chat id from microsoft_list_chats"),
    body:   z.string().describe("Message body (plain text)"),
    isHtml: z.boolean().optional().describe("True if body is HTML"),
  },
  async ({ chatId, body, isHtml }) => {
    const result = await graph(`/me/chats/${encodeURIComponent(chatId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ body: { contentType: isHtml ? "html" : "text", content: body } }),
    });
    return { content: [{ type: "text", text: `Message sent (id: ${result.id})` }] };
  },
);

// ─── Contacts tools ──────────────────────────────────────────────────────────

server.tool(
  "microsoft_list_contacts",
  "Lists Outlook contacts for the current user, optionally filtered by free-text search.",
  {
    top:    z.number().int().positive().max(100).default(50).describe("Max contacts returned"),
    search: z.string().optional().describe("Free-text search across name, email, company"),
  },
  async ({ top, search }) => {
    const params = new URLSearchParams({
      $top:    String(top),
      $select: "id,displayName,emailAddresses,companyName,jobTitle",
    });
    if (search?.trim()) {
      params.set("$search", `"${search.trim()}"`);
    } else {
      params.set("$orderby", "displayName");
    }
    const data = await graph(`/me/contacts?${params.toString()}`);
    const contacts = data?.value ?? [];
    if (!contacts.length) return { content: [{ type: "text", text: "No contacts found." }] };
    const lines = contacts.map((c: any, i: number) => {
      const name    = c.displayName || "(no name)";
      const email   = c.emailAddresses?.[0]?.address || "(no email)";
      const company = c.companyName ? ` — ${c.companyName}` : "";
      return `${i + 1}. ${name} <${email}>${company} (id: ${c.id})`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.tool(
  "microsoft_create_contact",
  "Creates a new contact in the current user's Outlook contacts.",
  {
    displayName: z.string().describe("Contact display name"),
    email:       z.string().describe("Primary email address"),
    company:     z.string().optional().describe("Company name"),
    jobTitle:    z.string().optional().describe("Job title"),
    mobilePhone: z.string().optional().describe("Mobile phone number"),
  },
  async ({ displayName, email, company, jobTitle, mobilePhone }) => {
    const body: any = {
      displayName,
      emailAddresses: [{ address: email, name: displayName }],
    };
    if (company) body.companyName = company;
    if (jobTitle) body.jobTitle = jobTitle;
    if (mobilePhone) body.mobilePhone = mobilePhone;
    const result = await graph("/me/contacts", { method: "POST", body: JSON.stringify(body) });
    return { content: [{ type: "text", text: `Contact created: ${displayName} <${email}> (id: ${result.id})` }] };
  },
);

// ─── Outlook complements ─────────────────────────────────────────────────────

server.tool(
  "microsoft_list_folders",
  "Lists Outlook mail folders for the current user (Inbox, Sent, custom folders, etc.).",
  {
    top: z.number().int().positive().max(100).default(50).describe("Max folders returned"),
  },
  async ({ top }) => {
    const data = await graph(`/me/mailFolders?$top=${top}&$select=id,displayName,unreadItemCount,totalItemCount`);
    const folders = data?.value ?? [];
    if (!folders.length) return { content: [{ type: "text", text: "No folders found." }] };
    const lines = folders.map((f: any, i: number) => {
      const unread = f.unreadItemCount ? ` (${f.unreadItemCount} unread)` : "";
      return `${i + 1}. ${f.displayName} — ${f.totalItemCount} items${unread} (id: ${f.id})`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  },
);

server.tool(
  "microsoft_move_email",
  "Moves an Outlook email to another folder by id.",
  {
    messageId:        z.string().describe("Message id to move"),
    destinationFolder: z.string().describe("Destination folder id (from microsoft_list_folders) or well-known name (e.g. 'archive', 'deleteditems')"),
  },
  async ({ messageId, destinationFolder }) => {
    const result = await graph(`/me/messages/${encodeURIComponent(messageId)}/move`, {
      method: "POST",
      body: JSON.stringify({ destinationId: destinationFolder }),
    });
    return { content: [{ type: "text", text: `Message moved (new id: ${result.id})` }] };
  },
);

server.tool(
  "microsoft_reply_email",
  "Sends a reply to an Outlook email by id.",
  {
    messageId: z.string().describe("Message id to reply to"),
    comment:   z.string().describe("Reply text (added on top of the quoted thread)"),
    replyAll:  z.boolean().optional().describe("Reply to all recipients (default false)"),
  },
  async ({ messageId, comment, replyAll }) => {
    const endpoint = replyAll
      ? `/me/messages/${encodeURIComponent(messageId)}/replyAll`
      : `/me/messages/${encodeURIComponent(messageId)}/reply`;
    await graph(endpoint, { method: "POST", body: JSON.stringify({ comment }) });
    return { content: [{ type: "text", text: `Reply sent for message ${messageId}.` }] };
  },
);


runServer(server).catch((err) => {
  process.stderr.write(`[ubik-microsoft] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
