#!/usr/bin/env node
/**
 * UBIK Google Workspace — MCP Server (stdio transport)
 *
 * Leverages OAuth tokens stored by UBIK's connector system
 * to expose Google Workspace APIs as MCP tools.
 *
 * Tools:
 *   - gmail_search        → Search emails
 *   - gmail_read          → Read a specific email
 *   - gmail_send          → Send an email
 *   - gmail_labels        → List all labels/folders
 *   - gmail_trash         → Move email to trash
 *   - gmail_archive       → Archive email (remove from inbox)
 *   - gmail_mark_read     → Mark email as read or unread
 *   - gmail_move          → Move email to a label/folder
 *   - gmail_draft         → Create a draft email
 *   - gmail_label_create  → Create a custom label
 *   - calendar_list       → List upcoming events
 *   - calendar_create     → Create a calendar event
 *   - drive_search        → Search files in Drive
 *   - drive_deep_search   → Deep search across all folders with path resolution
 *   - drive_read          → Read a document's content
 *   - docs_get            → Get Google Doc content
 *   - sheets_read         → Read spreadsheet data
 *   - sheets_write        → Write to a spreadsheet
 *   - slides_get          → Get presentation info
 *   - tasks_list          → List tasks
 *   - tasks_create        → Create a task
 *   - tasks_update        → Update a task
 *   - tasks_delete        → Delete a task
 *   - chat_list_spaces    → List Chat spaces
 *   - chat_send           → Send a Chat message
 *   - chat_read_messages  → Read Chat messages
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "dotenv";
import { join } from "node:path";
import { createMcpAuth, wrapTransportWithAuth } from "../lib/mcp-auth";

// Load .env from project root (cwd is set to UBIK root by .mcp.json)
config({ path: join(process.cwd(), ".env") });

// ─── Secure per-request auth (AsyncLocalStorage + HMAC) ───

const auth = createMcpAuth("ubik-google");

// ─── Token helper ───

async function getToken(service: string): Promise<string> {
  return auth.fetchToken(service, "google");
}

async function gapi(service: string, url: string, options?: RequestInit, _retries = 3): Promise<any> {
  const token = await getToken(service);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < _retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...options?.headers,
        },
      });
      clearTimeout(timeout);

      if (res.ok) return res.json();

      // Retry on 429 (rate limit) and 5xx (server errors)
      if (res.status === 429 || res.status >= 500) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }

      const err = await res.text();
      const safeErr = err
        .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
        .replace(/token[=:]\s*\S+/gi, "token=[REDACTED]")
        .replace(/key[=:]\s*\S+/gi, "key=[REDACTED]");
      throw new Error(`Google API error (${res.status}): ${safeErr}`);
    } catch (e: any) {
      lastError = e;
      if (e.name === "AbortError" || e.message?.includes("ETIMEDOUT") || e.message?.includes("fetch failed")) {
        const delay = Math.min(1000 * 2 ** attempt, 8000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      throw e;
    }
  }

  throw lastError || new Error("Google API: max retries exceeded");
}

// ─── MCP Server ───

const server = new McpServer({
  name: "ubik-google",
  version: "1.0.0",
});

// ═══════════════════════════════════════════════
//  Gmail
// ═══════════════════════════════════════════════

server.tool(
  "gmail_search",
  "Search emails in Gmail. Leave query empty to list latest received emails.",
  {
    query: z.string().default("").describe("Gmail search query (e.g. 'from:someone subject:hello'). Leave empty to list latest emails."),
    labelId: z.string().optional().describe("Gmail label ID to filter by (e.g. 'INBOX', 'TRASH', or a custom label ID from gmail_labels)"),
    maxResults: z.number().default(10),
  },
  async ({ query, labelId, maxResults }) => {
    let q = query && query.trim().length > 0 ? query : "in:inbox";
    if (labelId) {
      q = `label:${labelId} ${q}`;
    }
    let data: any;
    try {
      data = await gapi("gmail", `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(q)}&maxResults=${maxResults}`);
    } catch (err: any) {
      // If the query is too complex / malformed, retry with a simplified version
      const simplified = q.replace(/['"()]/g, "").replace(/\bOR\b/gi, " ").replace(/\s+/g, " ").trim();
      if (simplified !== q) {
        data = await gapi("gmail", `https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(simplified)}&maxResults=${maxResults}`);
      } else {
        return { content: [{ type: "text", text: `Gmail search error: ${err.message}` }], isError: true };
      }
    }
    if (!data.messages?.length) return { content: [{ type: "text", text: "No messages found." }] };

    const ids: string[] = [];
    const summaries = await Promise.all(
      data.messages.slice(0, maxResults).map(async (m: any, i: number) => {
        const msg = await gapi("gmail", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=METADATA&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`);
        const headers = msg.payload?.headers || [];
        const get = (n: string) => headers.find((h: any) => h.name === n)?.value || "";
        const labels = msg.labelIds || [];
        const unread = labels.includes("UNREAD") ? " ★" : "";
        ids.push(`#${i + 1}=${m.id}`);
        return `${i + 1}. ${get("From")} — ${get("Subject")}${unread} (${get("Date")})`;
      })
    );
    // IDs at the end for tool use (gmail_read), not for display
    return { content: [{ type: "text", text: summaries.join("\n") + "\n\n[IDs pour gmail_read: " + ids.join(", ") + "]" }] };
  }
);

server.tool(
  "gmail_read",
  "Read a specific email by ID",
  { messageId: z.string().describe("Gmail message ID") },
  async ({ messageId }) => {
    const msg = await gapi("gmail", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=FULL`);
    const headers = msg.payload?.headers || [];
    const get = (n: string) => headers.find((h: any) => h.name === n)?.value || "";

    let body = "";
    const parts = msg.payload?.parts || [msg.payload];
    for (const part of parts) {
      if (part?.mimeType === "text/plain" && part.body?.data) {
        body = Buffer.from(part.body.data, "base64url").toString("utf-8");
        break;
      }
    }
    if (!body) {
      for (const part of parts) {
        if (part?.mimeType === "text/html" && part.body?.data) {
          body = "[HTML content] " + Buffer.from(part.body.data, "base64url").toString("utf-8").replace(/<[^>]+>/g, " ").substring(0, 2000);
          break;
        }
      }
    }

    return { content: [{ type: "text", text: `From: ${get("From")}\nTo: ${get("To")}\nDate: ${get("Date")}\nSubject: ${get("Subject")}\n\n${body || "(empty body)"}` }] };
  }
);

server.tool(
  "gmail_send",
  "Send an email via Gmail",
  {
    to: z.string().describe("Recipient email"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body (plain text or HTML)"),
    isHtml: z.boolean().optional().describe("True if body is HTML"),
    attachments: z.array(z.string()).optional().describe("List of absolute paths to local files to attach"),
  },
  async ({ to, subject, body, isHtml, attachments }) => {
    let raw = "";

    if (attachments && attachments.length > 0) {
      const { readFile } = await import("node:fs/promises");
      const { basename, extname } = await import("node:path");
      const boundary = "UBIK_MIXED_BOUNDARY_" + Date.now();
      
      let message = `To: ${to}\r\nSubject: =?utf-8?B?${Buffer.from(subject).toString("base64")}?=\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
      message += `--${boundary}\r\nContent-Type: ${isHtml ? "text/html" : "text/plain"}; charset="utf-8"\r\n\r\n${body}\r\n\r\n`;

      for (const filePath of attachments) {
        try {
          const fileBuffer = await readFile(filePath);
          const base64Data = fileBuffer.toString("base64");
          const filename = basename(filePath);
          const ext = extname(filePath).toLowerCase();
          
          let mimeType = "application/octet-stream";
          if (ext === ".pdf") mimeType = "application/pdf";
          else if (ext === ".png") mimeType = "image/png";
          else if (ext === ".jpg" || ext === ".jpeg") mimeType = "image/jpeg";
          else if (ext === ".html") mimeType = "text/html";
          else if (ext === ".txt") mimeType = "text/plain";
          else if (ext === ".csv") mimeType = "text/csv";
          else if (ext === ".zip") mimeType = "application/zip";
          else if (ext === ".json") mimeType = "application/json";

          message += `--${boundary}\r\n`;
          message += `Content-Type: ${mimeType}; name="${filename}"\r\n`;
          message += `Content-Disposition: attachment; filename="${filename}"\r\n`;
          message += `Content-Transfer-Encoding: base64\r\n\r\n`;
          
          const chunkedData = base64Data.match(/.{1,76}/g)?.join("\r\n") || base64Data;
          message += `${chunkedData}\r\n\r\n`;
        } catch (err: any) {
          throw new Error(`Failed to attach ${filePath}: ${err.message}`);
        }
      }
      message += `--${boundary}--\r\n`;
      raw = Buffer.from(message).toString("base64url");
    } else {
      const contentType = isHtml ? "text/html" : "text/plain";
      raw = Buffer.from(
        `To: ${to}\r\nSubject: =?utf-8?B?${Buffer.from(subject).toString("base64")}?=\r\nContent-Type: ${contentType}; charset=utf-8\r\n\r\n${body}`
      ).toString("base64url");
    }

    const result = await gapi("gmail", "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
      method: "POST",
      body: JSON.stringify({ raw }),
    });
    return { content: [{ type: "text", text: `Email sent (ID: ${result.id})` }] };
  }
);

server.tool(
  "gmail_labels",
  "List all Gmail labels (folders, categories, custom labels). Optionally filter for labels with unread messages.",
  {
    includeUnreadOnly: z.boolean().default(false).describe("If true, only show labels that have unread messages"),
  },
  async ({ includeUnreadOnly }) => {
    const data = await gapi("gmail", "https://gmail.googleapis.com/gmail/v1/users/me/labels");
    if (!data.labels?.length) return { content: [{ type: "text", text: "No labels found." }] };

    const system: string[] = [];
    const user: string[] = [];
    for (const label of data.labels) {
      // Get full details for unread counts if requested
      let labelInfo = label;
      if (includeUnreadOnly) {
        labelInfo = await gapi("gmail", `https://gmail.googleapis.com/gmail/v1/users/me/labels/${label.id}`);
      }

      const unreadCount = labelInfo.messagesUnread || 0;
      if (includeUnreadOnly && unreadCount === 0) continue;

      const line = `[${label.id}] ${label.name} (${label.type})${unreadCount > 0 ? ` - ${unreadCount} unread` : ""}`;
      if (label.type === "system") system.push(line);
      else user.push(line);
    }

    let output = "";
    if (system.length) output += "── System labels ──\n" + system.join("\n");
    if (user.length) output += (output ? "\n\n" : "") + "── Custom labels ──\n" + user.join("\n");
    return { content: [{ type: "text", text: output || "No labels matching criteria found." }] };
  }
);

server.tool(
  "gmail_trash",
  "Move an email to trash",
  { messageId: z.string().describe("Gmail message ID") },
  async ({ messageId }) => {
    await gapi("gmail", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/trash`, {
      method: "POST",
    });
    return { content: [{ type: "text", text: `Message ${messageId} moved to trash.` }] };
  }
);

server.tool(
  "gmail_archive",
  "Archive an email (remove INBOX label)",
  { messageId: z.string().describe("Gmail message ID") },
  async ({ messageId }) => {
    await gapi("gmail", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
      method: "POST",
      body: JSON.stringify({ removeLabelIds: ["INBOX"] }),
    });
    return { content: [{ type: "text", text: `Message ${messageId} archived.` }] };
  }
);

server.tool(
  "gmail_mark_read",
  "Mark an email as read or unread",
  {
    messageId: z.string().describe("Gmail message ID"),
    unread: z.boolean().default(false).describe("Set to true to mark as unread, false for read"),
  },
  async ({ messageId, unread }) => {
    const body = unread
      ? { addLabelIds: ["UNREAD"], removeLabelIds: [] }
      : { addLabelIds: [], removeLabelIds: ["UNREAD"] };
    await gapi("gmail", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: `Message ${messageId} marked as ${unread ? "unread" : "read"}.` }] };
  }
);

server.tool(
  "gmail_move",
  "Move an email to a label/folder (add label and optionally remove another)",
  {
    messageId: z.string().describe("Gmail message ID"),
    addLabelIds: z.array(z.string()).describe("Label IDs to add (e.g. ['STARRED', 'Label_123'])"),
    removeLabelIds: z.array(z.string()).default([]).describe("Label IDs to remove"),
  },
  async ({ messageId, addLabelIds, removeLabelIds }) => {
    await gapi("gmail", `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}/modify`, {
      method: "POST",
      body: JSON.stringify({ addLabelIds, removeLabelIds }),
    });
    return { content: [{ type: "text", text: `Message ${messageId} updated: +[${addLabelIds.join(",")}] -[${removeLabelIds.join(",")}]` }] };
  }
);

server.tool(
  "gmail_draft",
  "Create a draft email in Gmail",
  {
    to: z.string().describe("Recipient email"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body (plain text)"),
    cc: z.string().optional().describe("CC recipient(s)"),
    bcc: z.string().optional().describe("BCC recipient(s)"),
  },
  async ({ to, subject, body, cc, bcc }) => {
    let headers = `To: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8`;
    if (cc) headers += `\r\nCc: ${cc}`;
    if (bcc) headers += `\r\nBcc: ${bcc}`;
    const raw = Buffer.from(`${headers}\r\n\r\n${body}`).toString("base64url");

    const result = await gapi("gmail", "https://gmail.googleapis.com/gmail/v1/users/me/drafts", {
      method: "POST",
      body: JSON.stringify({ message: { raw } }),
    });
    return { content: [{ type: "text", text: `Draft created (ID: ${result.id})` }] };
  }
);

server.tool(
  "gmail_label_create",
  "Create a custom Gmail label",
  {
    name: z.string().describe("Label name (use '/' for nesting, e.g. 'Projects/UBIK')"),
    backgroundColor: z.string().optional().describe("Background color hex (e.g. '#16a765')"),
    textColor: z.string().optional().describe("Text color hex (e.g. '#ffffff')"),
  },
  async ({ name, backgroundColor, textColor }) => {
    const payload: any = {
      name,
      labelListVisibility: "labelShow",
      messageListVisibility: "show",
    };
    if (backgroundColor || textColor) {
      payload.color = {};
      if (backgroundColor) payload.color.backgroundColor = backgroundColor;
      if (textColor) payload.color.textColor = textColor;
    }

    const result = await gapi("gmail", "https://gmail.googleapis.com/gmail/v1/users/me/labels", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    return { content: [{ type: "text", text: `Label created: "${result.name}" (ID: ${result.id})` }] };
  }
);

// ═══════════════════════════════════════════════
//  Calendar
// ═══════════════════════════════════════════════

server.tool(
  "calendar_list",
  "List upcoming calendar events",
  { maxResults: z.number().default(10), daysAhead: z.number().default(7) },
  async ({ maxResults, daysAhead }) => {
    const now = new Date().toISOString();
    const minUntil = new Date();
    minUntil.setHours(23, 59, 59, 999);
    const computedUntil = new Date(Date.now() + daysAhead * 86400000);
    const until = (daysAhead === 0 ? minUntil : computedUntil).toISOString();
    const data = await gapi("calendar", `https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=${now}&timeMax=${until}&maxResults=${maxResults}&singleEvents=true&orderBy=startTime`);

    if (!data.items?.length) return { content: [{ type: "text", text: "Google Calendar connected — no upcoming events in the next " + daysAhead + " day(s)." }] };

    const lines = data.items.map((e: any) => {
      const start = e.start?.dateTime || e.start?.date || "?";
      return `[${e.id}] ${start} — ${e.summary || "(no title)"}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "calendar_create",
  "Create a calendar event",
  {
    summary: z.string().describe("Event title"),
    start: z.string().describe("Start datetime (ISO 8601, e.g. 2026-03-16T10:00:00+01:00)"),
    end: z.string().describe("End datetime (ISO 8601)"),
    description: z.string().optional().describe("Event description"),
    attendees: z.array(z.string()).optional().describe("List of attendee emails"),
  },
  async ({ summary, start, end, description, attendees }) => {
    const event: any = {
      summary,
      start: { dateTime: start },
      end: { dateTime: end },
    };
    if (description) event.description = description;
    if (attendees?.length) event.attendees = attendees.map((e) => ({ email: e }));

    const result = await gapi("calendar", "https://www.googleapis.com/calendar/v3/calendars/primary/events", {
      method: "POST",
      body: JSON.stringify(event),
    });
    return { content: [{ type: "text", text: `Event created: "${result.summary}" (${result.htmlLink})` }] };
  }
);

// ═══════════════════════════════════════════════
//  Drive
// ═══════════════════════════════════════════════

server.tool(
  "drive_search",
  "Search files in Google Drive",
  { query: z.string().describe("Drive search query (e.g. 'name contains report')"), maxResults: z.number().default(10) },
  async ({ query, maxResults }) => {
    const data = await gapi("drive", `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&pageSize=${maxResults}&fields=files(id,name,mimeType,modifiedTime,webViewLink)`);

    if (!data.files?.length) return { content: [{ type: "text", text: "No files found." }] };

    const lines = data.files.map((f: any) =>
      `[${f.id}] ${f.name} (${f.mimeType}) — modified ${f.modifiedTime} — ${f.webViewLink || ""}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "drive_deep_search",
  "Deep search across all Google Drive folders — finds files by keyword in name or content, returns full folder path. Use for finding files buried in subfolders.",
  {
    keyword: z.string().describe("Search keyword (e.g. 'bulletin de salaire', 'facture', 'contrat')"),
    fileType: z.enum(["any", "pdf", "doc", "sheet", "image", "video", "audio", "folder"]).default("any").describe("Filter by file type"),
    maxResults: z.number().default(30).describe("Max results (up to 100)"),
  },
  async ({ keyword, fileType, maxResults }) => {
    // Build query: search in name AND fullText, exclude trash
    const escapedKeyword = keyword.replace(/'/g, "\\'");
    const conditions: string[] = [
      `(name contains '${escapedKeyword}' or fullText contains '${escapedKeyword}')`,
      "trashed = false",
    ];

    // File type filter
    const mimeFilters: Record<string, string> = {
      pdf: "mimeType = 'application/pdf'",
      doc: "(mimeType = 'application/vnd.google-apps.document' or mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType = 'application/msword')",
      sheet: "(mimeType = 'application/vnd.google-apps.spreadsheet' or mimeType = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')",
      image: "mimeType contains 'image/'",
      video: "mimeType contains 'video/'",
      audio: "mimeType contains 'audio/'",
      folder: "mimeType = 'application/vnd.google-apps.folder'",
    };
    if (fileType !== "any" && mimeFilters[fileType]) {
      conditions.push(mimeFilters[fileType]);
    }

    const q = conditions.join(" and ");
    const cap = Math.min(maxResults, 100);
    const fields = "files(id,name,mimeType,modifiedTime,size,parents,webViewLink)";
    const data = await gapi("drive", `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${cap}&fields=${fields}&orderBy=modifiedTime desc`);

    if (!data.files?.length) return { content: [{ type: "text", text: `No files found for "${keyword}".` }] };

    // Resolve immediate parent folder names (single level only — fast, 1 API call per unique parent)
    const parentIds = new Set<string>();
    for (const f of data.files) {
      if (f.parents?.length) parentIds.add(f.parents[0]);
    }

    const parentNames: Record<string, string> = {};
    // Resolve parent names in parallel with a 5s safety timeout
    await Promise.race([
      Promise.all([...parentIds].map(async (pid) => {
        try {
          const folder = await gapi("drive", `https://www.googleapis.com/drive/v3/files/${pid}?fields=name`);
          parentNames[pid] = folder.name;
        } catch {
          parentNames[pid] = "/";
        }
      })),
      new Promise<void>((resolve) => setTimeout(resolve, 5000)),
    ]);

    // Format results
    const lines = data.files.map((f: any) => {
      const parent = f.parents?.length ? (parentNames[f.parents[0]] || "/") : "/";
      const sizeKB = f.size ? `${(Number(f.size) / 1024).toFixed(1)} KB` : "";
      const link = f.webViewLink || "";
      return `[${f.id}] ${f.name}\n   📁 ${parent}/ — ${f.mimeType} ${sizeKB} — ${f.modifiedTime || ""}\n   ${link}`;
    });

    return {
      content: [{
        type: "text",
        text: `Found ${data.files.length} result(s) for "${keyword}":\n\n${lines.join("\n\n")}`,
      }],
    };
  }
);

server.tool(
  "drive_read",
  "Read/export a file from Google Drive (text content)",
  { fileId: z.string().describe("Drive file ID") },
  async ({ fileId }) => {
    const meta = await gapi("drive", `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name,mimeType`);

    let content: string;
    if (meta.mimeType === "application/vnd.google-apps.document") {
      content = await gapi("docs", `https://docs.googleapis.com/v1/documents/${fileId}`).then((d: any) =>
        d.body?.content?.map((e: any) => e.paragraph?.elements?.map((el: any) => el.textRun?.content || "").join("") || "").join("") || "(empty)"
      );
    } else if (meta.mimeType === "application/vnd.google-apps.spreadsheet") {
      content = `Use sheets_read tool with spreadsheetId="${fileId}" for spreadsheet data.`;
    } else {
      // Try plain text export
      const token = await getToken("drive");
      const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      content = await res.text();
      if (content.length > 10000) content = content.substring(0, 10000) + "\n... (truncated)";
    }

    return { content: [{ type: "text", text: `File: ${meta.name} (${meta.mimeType})\n\n${content}` }] };
  }
);

server.tool(
  "drive_create_folder",
  "Create a folder in Google Drive",
  {
    name: z.string().describe("Folder name"),
    parentId: z.string().default("root").describe("Parent folder ID (default: root)"),
  },
  async ({ name, parentId }) => {
    const result = await gapi("drive", "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink", {
      method: "POST",
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    });
    return { content: [{ type: "text", text: `Folder created: "${result.name}" (ID: ${result.id}) — ${result.webViewLink || ""}` }] };
  }
);

server.tool(
  "drive_create_doc",
  "Create a Google Doc with text content",
  {
    title: z.string().describe("Document title"),
    content: z.string().describe("Text content to write into the document"),
    parentId: z.string().default("root").describe("Parent folder ID (default: root)"),
  },
  async ({ title, content, parentId }) => {
    // Step 1: Create the Doc
    const doc = await gapi("drive", "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink", {
      method: "POST",
      body: JSON.stringify({
        name: title,
        mimeType: "application/vnd.google-apps.document",
        parents: [parentId],
      }),
    });

    // Step 2: Insert text content via Docs API
    if (content) {
      await gapi("docs", `https://docs.googleapis.com/v1/documents/${doc.id}:batchUpdate`, {
        method: "POST",
        body: JSON.stringify({
          requests: [{
            insertText: {
              location: { index: 1 },
              text: content,
            },
          }],
        }),
      });
    }

    return { content: [{ type: "text", text: `Doc created: "${doc.name}" (ID: ${doc.id}) — ${doc.webViewLink || ""}` }] };
  }
);

server.tool(
  "drive_create_sheet",
  "Create a Google Spreadsheet with optional data",
  {
    title: z.string().describe("Spreadsheet title"),
    data: z.array(z.array(z.string())).optional().describe("2D array of initial data (rows x cols)"),
    parentId: z.string().default("root").describe("Parent folder ID (default: root)"),
  },
  async ({ title, data, parentId }) => {
    // Create the spreadsheet
    const file = await gapi("drive", "https://www.googleapis.com/drive/v3/files?fields=id,name,webViewLink", {
      method: "POST",
      body: JSON.stringify({
        name: title,
        mimeType: "application/vnd.google-apps.spreadsheet",
        parents: [parentId],
      }),
    });

    // Write initial data if provided
    if (data?.length) {
      await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${file.id}/values/Sheet1!A1?valueInputOption=USER_ENTERED`, {
        method: "PUT",
        body: JSON.stringify({ values: data }),
      });
    }

    return { content: [{ type: "text", text: `Spreadsheet created: "${file.name}" (ID: ${file.id}) — ${file.webViewLink || ""}` }] };
  }
);

server.tool(
  "drive_upload",
  "Upload a text file to Google Drive (code, markdown, JSON, CSV, HTML, etc.)",
  {
    name: z.string().describe("File name with extension (e.g. 'report.html', 'data.csv', 'app.py')"),
    content: z.string().describe("File text content"),
    mimeType: z.string().default("auto").describe("MIME type — use 'auto' to detect from file extension, or specify explicitly"),
    parentId: z.string().default("root").describe("Parent folder ID (default: root)"),
  },
  async ({ name, content, mimeType, parentId }) => {
    // Auto-detect mimeType from file extension
    if (mimeType === "auto" || mimeType === "text/plain") {
      const ext = name.split(".").pop()?.toLowerCase() || "";
      const EXT_MIME: Record<string, string> = {
        html: "text/html", htm: "text/html", css: "text/css",
        js: "application/javascript", json: "application/json",
        csv: "text/csv", tsv: "text/tab-separated-values",
        md: "text/markdown", xml: "application/xml", svg: "image/svg+xml",
        py: "text/x-python", sh: "text/x-shellscript", yaml: "text/yaml", yml: "text/yaml",
      };
      mimeType = EXT_MIME[ext] || "text/plain";
    }
    const metadata = JSON.stringify({ name, parents: [parentId] });
    const boundary = "ubik_upload_boundary";
    const body = [
      `--${boundary}`,
      "Content-Type: application/json; charset=UTF-8",
      "",
      metadata,
      `--${boundary}`,
      `Content-Type: ${mimeType}`,
      "",
      content,
      `--${boundary}--`,
    ].join("\r\n");

    const token = await getToken("drive");
    const res = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body,
    });
    if (!res.ok) {
      const errText = (await res.text()).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/token[=:]\s*\S+/gi, "token=[REDACTED]");
      throw new Error(`Upload error: ${errText}`);
    }
    const result = await res.json();

    return { content: [{ type: "text", text: `File uploaded: "${result.name}" (ID: ${result.id}) — ${result.webViewLink || ""}` }] };
  }
);

server.tool(
  "drive_update_doc",
  "Replace the entire content of an existing Google Doc",
  {
    documentId: z.string().describe("Google Doc ID"),
    content: z.string().describe("New text content (replaces all existing content)"),
  },
  async ({ documentId, content }) => {
    // Get current doc to find end index
    const doc = await gapi("docs", `https://docs.googleapis.com/v1/documents/${documentId}`);
    const endIndex = doc.body?.content?.slice(-1)?.[0]?.endIndex || 1;

    const requests: any[] = [];
    // Delete existing content (if any beyond the initial newline)
    if (endIndex > 2) {
      requests.push({
        deleteContentRange: {
          range: { startIndex: 1, endIndex: endIndex - 1 },
        },
      });
    }
    // Insert new content
    requests.push({
      insertText: {
        location: { index: 1 },
        text: content,
      },
    });

    await gapi("docs", `https://docs.googleapis.com/v1/documents/${documentId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests }),
    });

    return { content: [{ type: "text", text: `Doc "${doc.title}" updated (${content.length} chars written)` }] };
  }
);

server.tool(
  "drive_list_folder",
  "List files in a Google Drive folder",
  {
    folderId: z.string().default("root").describe("Folder ID (default: root)"),
    maxResults: z.number().default(20),
  },
  async ({ folderId, maxResults }) => {
    const q = `'${folderId}' in parents and trashed = false`;
    const data = await gapi("drive", `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&pageSize=${maxResults}&fields=files(id,name,mimeType,modifiedTime,webViewLink)&orderBy=folder,name`);

    if (!data.files?.length) return { content: [{ type: "text", text: "Empty folder." }] };

    const lines = data.files.map((f: any) =>
      `[${f.id}] ${f.mimeType === "application/vnd.google-apps.folder" ? "📁" : "📄"} ${f.name} (${f.mimeType}) — ${f.modifiedTime}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "drive_move",
  "Move a file or folder to a different Google Drive folder",
  {
    fileId: z.string().describe("ID of the file or folder to move"),
    newParentId: z.string().describe("ID of the destination folder"),
  },
  async ({ fileId, newParentId }) => {
    // Get current parents to remove them
    const file = await gapi("drive", `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,parents`);
    const previousParents = (file.parents || []).join(",");

    const moved = await gapi("drive", `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${newParentId}&removeParents=${previousParents}&fields=id,name,parents`, {
      method: "PATCH",
    });

    return { content: [{ type: "text", text: `Moved "${moved.name}" to folder ${newParentId}` }] };
  }
);

server.tool(
  "drive_delete",
  "Move a file or folder to Google Drive trash (recoverable) or permanently delete it",
  {
    fileId: z.string().describe("ID of the file or folder to delete"),
    permanent: z.boolean().default(false).describe("If true, permanently delete (skip trash)"),
  },
  async ({ fileId, permanent }) => {
    if (permanent) {
      await gapi("drive", `https://www.googleapis.com/drive/v3/files/${fileId}`, { method: "DELETE" });
      return { content: [{ type: "text", text: `Permanently deleted file ${fileId}` }] };
    } else {
      const trashed = await gapi("drive", `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name`, {
        method: "PATCH",
        body: JSON.stringify({ trashed: true }),
      });
      return { content: [{ type: "text", text: `Moved "${trashed.name}" to trash` }] };
    }
  }
);

server.tool(
  "drive_empty_trash",
  "Vider la corbeille Google Drive de l'utilisateur. Supprime definitivement tous les fichiers dans la corbeille.",
  {},
  async () => {
    await gapi("drive", "https://www.googleapis.com/drive/v3/files/trash", { method: "DELETE" });
    return { content: [{ type: "text", text: "Corbeille Google Drive videe avec succes." }] };
  }
);

server.tool(
  "drive_rename",
  "Rename a file or folder in Google Drive",
  {
    fileId: z.string().describe("ID of the file or folder to rename"),
    newName: z.string().describe("New name for the file or folder"),
  },
  async ({ fileId, newName }) => {
    const renamed = await gapi("drive", `https://www.googleapis.com/drive/v3/files/${fileId}?fields=id,name`, {
      method: "PATCH",
      body: JSON.stringify({ name: newName }),
    });
    return { content: [{ type: "text", text: `Renamed to "${renamed.name}"` }] };
  }
);

// ═══════════════════════════════════════════════
//  Docs
// ═══════════════════════════════════════════════

server.tool(
  "docs_get",
  "Get the text content of a Google Doc",
  { documentId: z.string().describe("Google Doc ID") },
  async ({ documentId }) => {
    const doc = await gapi("docs", `https://docs.googleapis.com/v1/documents/${documentId}`);
    const text = doc.body?.content
      ?.map((e: any) => e.paragraph?.elements?.map((el: any) => el.textRun?.content || "").join("") || "")
      .join("") || "(empty document)";

    return { content: [{ type: "text", text: `Title: ${doc.title}\n\n${text}` }] };
  }
);

// ═══════════════════════════════════════════════
//  Sheets
// ═══════════════════════════════════════════════

server.tool(
  "sheets_read",
  "Read data from a Google Spreadsheet",
  {
    spreadsheetId: z.string().describe("Spreadsheet ID"),
    range: z.string().default("Sheet1").describe("A1 range (e.g. 'Sheet1!A1:D10')"),
  },
  async ({ spreadsheetId, range }) => {
    const data = await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`);
    const rows = data.values || [];
    if (!rows.length) return { content: [{ type: "text", text: "No data in range." }] };

    const table = rows.map((r: string[]) => r.join("\t")).join("\n");
    return { content: [{ type: "text", text: `Range: ${data.range}\nRows: ${rows.length}\n\n${table}` }] };
  }
);

server.tool(
  "sheets_write",
  "Write data to a Google Spreadsheet",
  {
    spreadsheetId: z.string().describe("Spreadsheet ID"),
    range: z.string().describe("A1 range (e.g. 'Sheet1!A1')"),
    values: z.array(z.array(z.string())).describe("2D array of values"),
  },
  async ({ spreadsheetId, range, values }) => {
    const result = await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`, {
      method: "PUT",
      body: JSON.stringify({ values }),
    });
    return { content: [{ type: "text", text: `Updated ${result.updatedCells} cells in ${result.updatedRange}` }] };
  }
);

server.tool(
  "sheets_add_sheet",
  "Add one or more new tabs/sheets to an existing Google Spreadsheet. Use this to create onglets like 'Catalogue', 'Clients', etc.",
  {
    spreadsheetId: z.string().describe("Spreadsheet ID"),
    sheetNames: z.array(z.string()).describe("List of tab/sheet names to create (e.g. ['Catalogue', 'Clients', 'Historique'])"),
  },
  async ({ spreadsheetId, sheetNames }) => {
    const requests = sheetNames.map(name => ({
      addSheet: { properties: { title: name } },
    }));
    const result = await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests }),
    });
    const created = result.replies?.map((r: any) => r.addSheet?.properties?.title).filter(Boolean) || sheetNames;
    return { content: [{ type: "text", text: `Created ${created.length} sheets: ${created.join(", ")}` }] };
  }
);

server.tool(
  "sheets_delete_sheet",
  "Delete a tab/sheet from a Google Spreadsheet by name. Useful to remove the default 'Sheet1' after creating custom tabs.",
  {
    spreadsheetId: z.string().describe("Spreadsheet ID"),
    sheetName: z.string().describe("Name of the sheet/tab to delete"),
  },
  async ({ spreadsheetId, sheetName }) => {
    // First get the sheetId from the name
    const meta = await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`);
    const sheet = meta.sheets?.find((s: any) => s.properties?.title === sheetName);
    if (!sheet) {
      return { content: [{ type: "text", text: `Sheet "${sheetName}" not found` }], isError: true };
    }
    await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({ requests: [{ deleteSheet: { sheetId: sheet.properties.sheetId } }] }),
    });
    return { content: [{ type: "text", text: `Deleted sheet "${sheetName}"` }] };
  }
);

server.tool(
  "sheets_list_sheets",
  "List all tabs/sheets in a Google Spreadsheet with their names and row counts.",
  {
    spreadsheetId: z.string().describe("Spreadsheet ID"),
  },
  async ({ spreadsheetId }) => {
    const meta = await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`);
    const sheets = meta.sheets?.map((s: any) => ({
      name: s.properties?.title,
      sheetId: s.properties?.sheetId,
      rows: s.properties?.gridProperties?.rowCount,
      cols: s.properties?.gridProperties?.columnCount,
    })) || [];
    return { content: [{ type: "text", text: `${sheets.length} sheets:\n${sheets.map((s: any) => `- ${s.name} (${s.rows}×${s.cols})`).join("\n")}` }] };
  }
);

server.tool(
  "sheets_append",
  "Append rows to the end of existing data in a Google Spreadsheet sheet. No need to specify the exact row — data is appended after the last row with content.",
  {
    spreadsheetId: z.string().describe("Spreadsheet ID"),
    sheet: z.string().default("Sheet1").describe("Sheet/tab name (e.g. 'Catalogue', 'Clients')"),
    values: z.array(z.array(z.string())).describe("2D array of rows to append"),
  },
  async ({ spreadsheetId, sheet, values }) => {
    const range = encodeURIComponent(sheet);
    const result = await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: "POST",
      body: JSON.stringify({ values }),
    });
    const updates = result.updates || {};
    return { content: [{ type: "text", text: `Appended ${updates.updatedRows || values.length} rows (${updates.updatedCells || "?"} cells) to ${sheet}. Range: ${updates.updatedRange || "?"}` }] };
  }
);

server.tool(
  "sheets_clear",
  "Clear all data from a specific sheet/tab in a Google Spreadsheet. Useful before a bulk reimport.",
  {
    spreadsheetId: z.string().describe("Spreadsheet ID"),
    range: z.string().describe("Range to clear (e.g. 'Catalogue!A1:Z10000' or 'Catalogue' for entire sheet)"),
  },
  async ({ spreadsheetId, range }) => {
    await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    return { content: [{ type: "text", text: `Cleared range: ${range}` }] };
  }
);

server.tool(
  "sheets_bulk_import",
  "Import a CSV or TSV file from Google Drive directly into a Google Spreadsheet tab. Reads the file content from Drive and writes all rows at once — much faster than line-by-line. Can optionally clear the target sheet first.",
  {
    spreadsheetId: z.string().describe("Target spreadsheet ID"),
    sheet: z.string().default("Sheet1").describe("Target sheet/tab name"),
    fileId: z.string().describe("Drive file ID of the CSV/TSV source file"),
    separator: z.string().default(",").describe("Field separator: ',' for CSV, '\\t' for TSV"),
    clearFirst: z.boolean().default(false).describe("If true, clear the target sheet before importing"),
    skipHeader: z.boolean().default(false).describe("If true, skip the first row of the source file (useful if target already has headers)"),
  },
  async ({ spreadsheetId, sheet, fileId, separator, clearFirst, skipHeader }) => {
    // 1. Read the file from Drive
    const token = await getToken("drive");
    const res = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      return { content: [{ type: "text", text: `Failed to read file from Drive: ${res.status} ${res.statusText}` }], isError: true };
    }
    const text = await res.text();

    // 2. Parse CSV/TSV
    const lines = text.split("\n").filter(l => l.trim());
    const startIdx = skipHeader ? 1 : 0;
    const values = lines.slice(startIdx).map(line => {
      // Handle quoted CSV fields
      if (separator === "," && line.includes('"')) {
        const fields: string[] = [];
        let current = "";
        let inQuotes = false;
        for (const char of line) {
          if (char === '"') { inQuotes = !inQuotes; }
          else if (char === separator && !inQuotes) { fields.push(current.trim()); current = ""; }
          else { current += char; }
        }
        fields.push(current.trim());
        return fields;
      }
      return line.split(separator).map(f => f.trim());
    });

    if (values.length === 0) {
      return { content: [{ type: "text", text: "No data rows found in the source file." }], isError: true };
    }

    // 3. Optionally clear target sheet
    if (clearFirst) {
      await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(sheet)}:clear`, {
        method: "POST",
        body: JSON.stringify({}),
      });
    }

    // 4. Write all rows at once
    const range = clearFirst ? `${sheet}!A1` : sheet;
    const endpoint = clearFirst
      ? `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`
      : `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`;
    const method = clearFirst ? "PUT" : "POST";

    const result = await gapi("sheets", endpoint, {
      method,
      body: JSON.stringify({ values }),
    });

    const updates = clearFirst ? result : (result.updates || {});
    return { content: [{ type: "text", text: `Imported ${values.length} rows (${updates.updatedCells || "?"} cells) into ${sheet}. Source file: ${fileId}. ${clearFirst ? "Sheet was cleared first." : "Appended to existing data."}` }] };
  }
);

server.tool(
  "sheets_rename_sheet",
  "Rename a tab/sheet in a Google Spreadsheet.",
  {
    spreadsheetId: z.string().describe("Spreadsheet ID"),
    oldName: z.string().describe("Current name of the sheet"),
    newName: z.string().describe("New name for the sheet"),
  },
  async ({ spreadsheetId, oldName, newName }) => {
    const meta = await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`);
    const sheet = meta.sheets?.find((s: any) => s.properties?.title === oldName);
    if (!sheet) {
      return { content: [{ type: "text", text: `Sheet "${oldName}" not found` }], isError: true };
    }
    await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, {
      method: "POST",
      body: JSON.stringify({
        requests: [{
          updateSheetProperties: {
            properties: { sheetId: sheet.properties.sheetId, title: newName },
            fields: "title",
          },
        }],
      }),
    });
    return { content: [{ type: "text", text: `Renamed "${oldName}" → "${newName}"` }] };
  }
);

server.tool(
  "sheets_format",
  "Apply formatting to cells in a Google Spreadsheet: bold, colors, freeze rows, column widths, number formats, conditional formatting. Send multiple operations in one call for efficiency.",
  {
    spreadsheetId: z.string().describe("Spreadsheet ID"),
    sheetName: z.string().describe("Sheet/tab name to format"),
    operations: z.array(z.object({
      type: z.enum(["freeze", "bold", "background", "textColor", "columnWidth", "numberFormat", "conditionalFormat", "autoResize"]).describe("Type of format operation"),
      range: z.string().optional().describe("A1 range (e.g. 'A1:H1'). Not needed for freeze/autoResize-all."),
      value: z.string().optional().describe("freeze='1' (rows), bold='true', background/textColor='#1a1a2e' (hex), columnWidth='200' (px), numberFormat='#,##0.00 €' or '0%' or 'DD/MM/YYYY', autoResize='all' or 'A'"),
      condition: z.object({
        type: z.enum(["NUMBER_LESS", "NUMBER_GREATER", "NUMBER_BETWEEN", "TEXT_EQ", "TEXT_CONTAINS", "CUSTOM_FORMULA"]).optional(),
        values: z.array(z.string()).optional().describe("Condition values"),
        bgColor: z.string().optional().describe("Background hex when true"),
        textColor: z.string().optional().describe("Text hex when true"),
      }).optional().describe("For conditionalFormat only"),
    })).describe("Array of formatting operations"),
  },
  async ({ spreadsheetId, sheetName, operations }) => {
    const meta = await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties`);
    const sheet = meta.sheets?.find((s: any) => s.properties?.title === sheetName);
    if (!sheet) return { content: [{ type: "text", text: `Sheet "${sheetName}" not found` }], isError: true };
    const sheetId = sheet.properties.sheetId;

    function parseRange(r: string): any {
      const m = r.match(/^([A-Z]+)(\d+):([A-Z]+)(\d+)$/);
      if (m) return { sheetId, startRowIndex: +m[2] - 1, endRowIndex: +m[4], startColumnIndex: m[1].charCodeAt(0) - 65, endColumnIndex: m[3].charCodeAt(0) - 64 };
      const cm = r.match(/^([A-Z]+):([A-Z]+)$/);
      if (cm) return { sheetId, startColumnIndex: cm[1].charCodeAt(0) - 65, endColumnIndex: cm[2].charCodeAt(0) - 64 };
      return { sheetId };
    }
    function hex(h: string) { const c = h.replace("#", ""); return { red: parseInt(c.substring(0, 2), 16) / 255, green: parseInt(c.substring(2, 4), 16) / 255, blue: parseInt(c.substring(4, 6), 16) / 255 }; }

    const requests: any[] = [];
    for (const op of operations) {
      switch (op.type) {
        case "freeze":
          requests.push({ updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: +(op.value || "1") } }, fields: "gridProperties.frozenRowCount" } });
          break;
        case "bold":
          requests.push({ repeatCell: { range: parseRange(op.range || "A1:Z1"), cell: { userEnteredFormat: { textFormat: { bold: op.value !== "false" } } }, fields: "userEnteredFormat.textFormat.bold" } });
          break;
        case "background":
          requests.push({ repeatCell: { range: parseRange(op.range || "A1:Z1"), cell: { userEnteredFormat: { backgroundColor: hex(op.value || "#1a1a2e") } }, fields: "userEnteredFormat.backgroundColor" } });
          break;
        case "textColor":
          requests.push({ repeatCell: { range: parseRange(op.range || "A1:Z1"), cell: { userEnteredFormat: { textFormat: { foregroundColor: hex(op.value || "#e0e0f0") } } }, fields: "userEnteredFormat.textFormat.foregroundColor" } });
          break;
        case "columnWidth": {
          const ci = (op.range?.match(/^([A-Z])/) || ["", "A"])[1].charCodeAt(0) - 65;
          const ei = (op.range?.match(/:([A-Z])/) || ["", String.fromCharCode(65 + ci)])[1].charCodeAt(0) - 64;
          requests.push({ updateDimensionProperties: { range: { sheetId, dimension: "COLUMNS", startIndex: ci, endIndex: ei }, properties: { pixelSize: +(op.value || "120") }, fields: "pixelSize" } });
          break;
        }
        case "numberFormat":
          requests.push({ repeatCell: { range: parseRange(op.range || "A:A"), cell: { userEnteredFormat: { numberFormat: { type: "NUMBER", pattern: op.value || "#,##0.00" } } }, fields: "userEnteredFormat.numberFormat" } });
          break;
        case "autoResize":
          if (op.value === "all") requests.push({ autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS" } } });
          else { const c = (op.value || "A").charCodeAt(0) - 65; requests.push({ autoResizeDimensions: { dimensions: { sheetId, dimension: "COLUMNS", startIndex: c, endIndex: c + 1 } } }); }
          break;
        case "conditionalFormat":
          if (!op.condition) break;
          const fmt: any = {};
          if (op.condition.bgColor) fmt.backgroundColor = hex(op.condition.bgColor);
          if (op.condition.textColor) fmt.textFormat = { foregroundColor: hex(op.condition.textColor) };
          requests.push({ addConditionalFormatRule: { rule: { ranges: [parseRange(op.range || "A:A")], booleanRule: { condition: { type: op.condition.type || "TEXT_EQ", values: (op.condition.values || []).map(v => ({ userEnteredValue: v })) }, format: fmt } }, index: 0 } });
          break;
      }
    }
    if (!requests.length) return { content: [{ type: "text", text: "No valid operations." }], isError: true };
    await gapi("sheets", `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}:batchUpdate`, { method: "POST", body: JSON.stringify({ requests }) });
    return { content: [{ type: "text", text: `Applied ${requests.length} format operations to "${sheetName}"` }] };
  }
);

// ═══════════════════════════════════════════════
//  Drive extras
// ═══════════════════════════════════════════════

server.tool(
  "drive_copy",
  "Duplicate a file in Google Drive. Returns the new file ID.",
  {
    fileId: z.string().describe("ID of the file to copy"),
    name: z.string().optional().describe("Name for the copy (default: 'Copy of ...')"),
    folderId: z.string().optional().describe("Destination folder ID (default: same location)"),
  },
  async ({ fileId, name, folderId }) => {
    const body: any = {};
    if (name) body.name = name;
    if (folderId) body.parents = [folderId];
    const result = await gapi("drive", `https://www.googleapis.com/drive/v3/files/${fileId}/copy`, {
      method: "POST",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: `Copied → ${result.name || "file"} (ID: ${result.id})` }] };
  }
);

server.tool(
  "drive_share",
  "Share a Google Drive file or folder with a user (reader, writer, or commenter).",
  {
    fileId: z.string().describe("ID of the file or folder to share"),
    email: z.string().describe("Email address of the person to share with"),
    role: z.enum(["reader", "writer", "commenter"]).default("reader").describe("Permission level"),
    notify: z.boolean().default(true).describe("Send notification email"),
  },
  async ({ fileId, email, role, notify }) => {
    await gapi("drive", `https://www.googleapis.com/drive/v3/files/${fileId}/permissions?sendNotificationEmail=${notify}`, {
      method: "POST",
      body: JSON.stringify({ type: "user", role, emailAddress: email }),
    });
    return { content: [{ type: "text", text: `Shared with ${email} as ${role}` }] };
  }
);

// ═══════════════════════════════════════════════
//  Calendar extras
// ═══════════════════════════════════════════════

server.tool(
  "calendar_update",
  "Update an existing Google Calendar event (title, time, description, location).",
  {
    eventId: z.string().describe("Event ID to update"),
    title: z.string().optional().describe("New title"),
    start: z.string().optional().describe("New start time (ISO 8601)"),
    end: z.string().optional().describe("New end time (ISO 8601)"),
    description: z.string().optional().describe("New description"),
    location: z.string().optional().describe("New location"),
  },
  async ({ eventId, title, start, end, description, location }) => {
    const body: any = {};
    if (title) body.summary = title;
    if (description) body.description = description;
    if (location) body.location = location;
    if (start) body.start = { dateTime: start, timeZone: "Europe/Paris" };
    if (end) body.end = { dateTime: end, timeZone: "Europe/Paris" };
    const result = await gapi("calendar", `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    return { content: [{ type: "text", text: `Updated event: ${result.summary || title} (${result.start?.dateTime || result.start?.date})` }] };
  }
);

server.tool(
  "calendar_delete",
  "Delete/cancel a Google Calendar event.",
  {
    eventId: z.string().describe("Event ID to delete"),
  },
  async ({ eventId }) => {
    await gapi("calendar", `https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, {
      method: "DELETE",
    });
    return { content: [{ type: "text", text: `Event ${eventId} deleted` }] };
  }
);

// ═══════════════════════════════════════════════
//  Contacts extras
// ═══════════════════════════════════════════════

server.tool(
  "contacts_update",
  "Update an existing Google Contact (name, email, phone, company, notes).",
  {
    resourceName: z.string().describe("Contact resource name (e.g. 'people/c1234567890')"),
    givenName: z.string().optional(),
    familyName: z.string().optional(),
    email: z.string().optional(),
    phone: z.string().optional(),
    company: z.string().optional(),
    notes: z.string().optional(),
  },
  async ({ resourceName, givenName, familyName, email, phone, company, notes }) => {
    // Get current etag first
    const current = await gapi("contacts", `https://people.googleapis.com/v1/${resourceName}?personFields=names,emailAddresses,phoneNumbers,organizations,biographies`);
    const body: any = { etag: current.etag };
    const updateFields: string[] = [];

    if (givenName || familyName) {
      body.names = [{ givenName: givenName || current.names?.[0]?.givenName, familyName: familyName || current.names?.[0]?.familyName }];
      updateFields.push("names");
    }
    if (email) { body.emailAddresses = [{ value: email }]; updateFields.push("emailAddresses"); }
    if (phone) { body.phoneNumbers = [{ value: phone }]; updateFields.push("phoneNumbers"); }
    if (company) { body.organizations = [{ name: company }]; updateFields.push("organizations"); }
    if (notes) { body.biographies = [{ value: notes }]; updateFields.push("biographies"); }

    const result = await gapi("contacts", `https://people.googleapis.com/v1/${resourceName}:updateContact?updatePersonFields=${updateFields.join(",")}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    });
    const name = result.names?.[0];
    return { content: [{ type: "text", text: `Updated contact: ${name?.givenName || ""} ${name?.familyName || ""} (${updateFields.join(", ")})` }] };
  }
);

server.tool(
  "contacts_search",
  "Search Google Contacts by name, email, or phone number.",
  {
    query: z.string().describe("Search query (name, email, or phone)"),
    maxResults: z.number().default(10).describe("Max results"),
  },
  async ({ query, maxResults }) => {
    const result = await gapi("contacts", `https://people.googleapis.com/v1/people:searchContacts?query=${encodeURIComponent(query)}&readMask=names,emailAddresses,phoneNumbers,organizations&pageSize=${maxResults}`);
    const contacts = result.results?.map((r: any) => {
      const p = r.person;
      const name = p.names?.[0];
      return {
        resourceName: p.resourceName,
        name: `${name?.givenName || ""} ${name?.familyName || ""}`.trim(),
        email: p.emailAddresses?.[0]?.value,
        phone: p.phoneNumbers?.[0]?.value,
        company: p.organizations?.[0]?.name,
      };
    }) || [];
    if (!contacts.length) return { content: [{ type: "text", text: `No contacts found for "${query}"` }] };
    const table = contacts.map((c: any) => `${c.name} | ${c.email || "-"} | ${c.phone || "-"} | ${c.company || "-"}`).join("\n");
    return { content: [{ type: "text", text: `Found ${contacts.length} contacts:\nName | Email | Phone | Company\n${table}` }] };
  }
);

// ═══════════════════════════════════════════════
//  Slides
// ═══════════════════════════════════════════════

server.tool(
  "slides_get",
  "Get info about a Google Slides presentation",
  { presentationId: z.string().describe("Presentation ID") },
  async ({ presentationId }) => {
    const pres = await gapi("slides", `https://slides.googleapis.com/v1/presentations/${presentationId}`);
    const slides = pres.slides || [];
    const info = slides.map((s: any, i: number) => {
      const title = s.slideProperties?.title || `Slide ${i + 1}`;
      const textParts = s.pageElements
        ?.filter((e: any) => e.shape?.text)
        .map((e: any) => e.shape.text.textElements?.map((te: any) => te.textRun?.content || "").join("") || "")
        || [];
      return `[${i + 1}] ${title}: ${textParts.join(" ").substring(0, 200)}`;
    });
    return { content: [{ type: "text", text: `Title: ${pres.title}\nSlides: ${slides.length}\n\n${info.join("\n")}` }] };
  }
);

// ═══════════════════════════════════════════════
//  Tasks
// ═══════════════════════════════════════════════

server.tool(
  "tasks_list",
  "List Google Tasks",
  { maxResults: z.number().default(20) },
  async ({ maxResults }) => {
    // Get default task list
    const lists = await gapi("tasks", "https://tasks.googleapis.com/tasks/v1/users/@me/lists");
    const listId = lists.items?.[0]?.id;
    if (!listId) return { content: [{ type: "text", text: "No task lists found." }] };

    const data = await gapi("tasks", `https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks?maxResults=${maxResults}`);
    if (!data.items?.length) return { content: [{ type: "text", text: "No tasks." }] };

    const lines = data.items.map((t: any) =>
      `[${t.id}] [${t.status === "completed" ? "x" : " "}] ${t.title}${t.due ? ` (due: ${t.due})` : ""}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "tasks_create",
  "Create a Google Task",
  {
    title: z.string().describe("Task title"),
    notes: z.string().optional().describe("Task notes"),
    due: z.string().optional().describe("Due date (ISO 8601, e.g. 2026-03-20T00:00:00Z)"),
  },
  async ({ title, notes, due }) => {
    const lists = await gapi("tasks", "https://tasks.googleapis.com/tasks/v1/users/@me/lists");
    const listId = lists.items?.[0]?.id;
    if (!listId) return { content: [{ type: "text", text: "No task lists found." }] };

    const task: any = { title };
    if (notes) task.notes = notes;
    if (due) task.due = due;

    const result = await gapi("tasks", `https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks`, {
      method: "POST",
      body: JSON.stringify(task),
    });
    return { content: [{ type: "text", text: `Task created: "${result.title}" (${result.id})` }] };
  }
);

server.tool(
  "tasks_update",
  "Update a Google Task. Use tasks_list first to get the task ID.",
  {
    taskId: z.string().describe("Task ID to update"),
    title: z.string().optional().describe("New task title"),
    notes: z.string().optional().describe("New task notes"),
    due: z.string().optional().describe("New due date (ISO 8601)"),
    status: z.enum(["needsAction", "completed"]).optional().describe("Task status"),
  },
  async ({ taskId, title, notes, due, status }) => {
    const lists = await gapi("tasks", "https://tasks.googleapis.com/tasks/v1/users/@me/lists");
    const listId = lists.items?.[0]?.id;
    if (!listId) return { content: [{ type: "text", text: "No task lists found." }] };

    const patch: any = {};
    if (title) patch.title = title;
    if (notes) patch.notes = notes;
    if (due) patch.due = due;
    if (status) patch.status = status;

    const result = await gapi("tasks", `https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return { content: [{ type: "text", text: `Task updated: "${result.title}" (${result.status})` }] };
  }
);

server.tool(
  "tasks_delete",
  "Delete a Google Task. Use tasks_list first to get the task ID.",
  {
    taskId: z.string().describe("Task ID to delete"),
  },
  async ({ taskId }) => {
    const lists = await gapi("tasks", "https://tasks.googleapis.com/tasks/v1/users/@me/lists");
    const listId = lists.items?.[0]?.id;
    if (!listId) return { content: [{ type: "text", text: "No task lists found." }] };

    await gapi("tasks", `https://tasks.googleapis.com/tasks/v1/lists/${listId}/tasks/${taskId}`, {
      method: "DELETE",
    });
    return { content: [{ type: "text", text: `Task ${taskId} deleted successfully.` }] };
  }
);

// ═══════════════════════════════════════════════
//  Chat
// ═══════════════════════════════════════════════

server.tool(
  "chat_list_spaces",
  "List Google Chat spaces the user is a member of",
  { maxResults: z.number().default(20) },
  async ({ maxResults }) => {
    const data = await gapi("chat", `https://chat.googleapis.com/v1/spaces?pageSize=${maxResults}`);
    if (!data.spaces?.length) return { content: [{ type: "text", text: "No Chat spaces found." }] };

    const lines = data.spaces.map((s: any) =>
      `[${s.name}] ${s.displayName || "(unnamed)"} — type: ${s.type || "unknown"}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "chat_send",
  "Send a message to a Google Chat space",
  {
    space: z.string().describe("Chat space name (e.g. 'spaces/AAAA...')"),
    text: z.string().describe("Message text"),
  },
  async ({ space, text }) => {
    const result = await gapi("chat", `https://chat.googleapis.com/v1/${space}/messages`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    return { content: [{ type: "text", text: `Message sent (${result.name})` }] };
  }
);

server.tool(
  "chat_read_messages",
  "Read recent messages from a Google Chat space",
  {
    space: z.string().describe("Chat space name (e.g. 'spaces/AAAA...')"),
    maxResults: z.number().default(20),
  },
  async ({ space, maxResults }) => {
    const data = await gapi("chat", `https://chat.googleapis.com/v1/${space}/messages?pageSize=${maxResults}`);
    if (!data.messages?.length) return { content: [{ type: "text", text: "No messages found." }] };

    const lines = data.messages.map((m: any) =>
      `[${m.createTime}] ${m.sender?.displayName || "Unknown"}: ${m.text || "(no text)"}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

// ─── Start ───

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  wrapTransportWithAuth(transport, auth);
  console.error("[ubik-google] MCP server started (25 tools)");
}

main().catch((err) => {
  console.error("[ubik-google] Fatal:", err);
  process.exit(1);
});
