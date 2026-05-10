#!/usr/bin/env node
/**
 * UBIK Microsoft 365 — MCP Server (stdio transport)
 *
 * Leverages OAuth tokens stored by UBIK's connector system
 * to expose Microsoft Graph API as MCP tools.
 *
 * Tools:
 *   - outlook_search       → Search emails
 *   - outlook_read         → Read a specific email
 *   - outlook_send         → Send an email
 *   - outlook_draft        → Create a draft email
 *   - outlook_folders       → List mail folders
 *   - outlook_move         → Move email to folder
 *   - outlook_trash        → Move email to trash
 *   - outlook_mark_read    → Mark email as read/unread
 *   - ms_calendar_list     → List upcoming events
 *   - ms_calendar_create   → Create a calendar event
 *   - ms_calendar_delete   → Delete a calendar event by ID
 *   - ms_calendar_update   → Update a calendar event
 *   - onedrive_search      → Search files in OneDrive
 *   - onedrive_deep_search → Deep search across all folders with path resolution
 *   - onedrive_read        → Read file content
 *   - teams_chats          → List Teams chats
 *   - teams_read_messages  → Read messages from a Teams chat
 *   - teams_send           → Send a Teams message
 *   - teams_send_file      → Send a file in a Teams chat
 *   - todo_list            → List To Do tasks
 *   - todo_create          → Create a To Do task
 *   - todo_update          → Update a To Do task
 *   - todo_delete          → Delete a To Do task
 *   - onenote_notebooks    → List OneNote notebooks
 *   - onenote_sections     → List sections in a notebook
 *   - onenote_pages        → List pages in a section
 *   - onenote_read_page    → Read OneNote page content
 *   - onenote_write_page   → Create a OneNote page
 *   - onenote_update_page  → Append content to a page
 *   - contacts_list        → List contacts
 *   - ms_contacts_search   → Search contacts
 *   - contacts_create      → Create a contact
 *   - ms_contacts_update   → Update a contact
 *   - ms_contacts_delete   → Delete a contact
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "dotenv";
import { join } from "node:path";
import { createMcpAuth, wrapTransportWithAuth } from "../lib/mcp-auth";

// Load .env from project root (cwd is set to UBIK root by .mcp.json)
config({ path: join(process.cwd(), ".env") });

const auth = createMcpAuth("ubik-microsoft");

// ─── Constants ───

const GRAPH = "https://graph.microsoft.com/v1.0";

// ─── Token helper ───

async function getToken(service: string): Promise<string> {
  return auth.fetchToken(service, "microsoft");
}

async function graph(service: string, endpoint: string, options?: RequestInit, _retries = 3): Promise<any> {
  const token = await getToken(service);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < _retries; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);

      const res = await fetch(`${GRAPH}${endpoint}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          ...options?.headers,
        },
      });
      clearTimeout(timeout);

      if (res.ok) {
        if (res.status === 204) return null;
        return res.json();
      }

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
      throw new Error(`Microsoft Graph error (${res.status}): ${safeErr}`);
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

  throw lastError || new Error("Microsoft Graph: max retries exceeded");
}

// ─── MCP Server ───

const server = new McpServer({
  name: "ubik-microsoft",
  version: "1.0.0",
});

// ═══════════════════════════════════════════════
//  Outlook Mail
// ═══════════════════════════════════════════════

server.tool(
  "outlook_search",
  "Search emails in Outlook. Leave query empty to list latest received emails.",
  {
    query: z.string().default("").describe("Search query (e.g. 'from:someone subject:hello'). Leave empty to list latest emails."),
    maxResults: z.number().default(10),
  },
  async ({ query, maxResults }) => {
    // When query is empty, list latest emails. When searching, $orderby is NOT supported with $search on Graph API.
    const url = query && query.trim().length > 0
      ? `/me/messages?$search="${encodeURIComponent(query)}"&$top=${maxResults}&$select=id,subject,from,receivedDateTime,isRead`
      : `/me/messages?$top=${maxResults}&$select=id,subject,from,receivedDateTime,isRead&$orderby=receivedDateTime desc`;
    const data = await graph("outlook", url);
    if (!data.value?.length) return { content: [{ type: "text", text: "No messages found." }] };

    const lines = data.value.map((m: any, i: number) => {
      const from = m.from?.emailAddress?.name || m.from?.emailAddress?.address || "?";
      const date = m.receivedDateTime ? new Date(m.receivedDateTime).toLocaleString("fr-FR", { dateStyle: "short", timeStyle: "short" }) : "?";
      const unread = m.isRead ? "" : " ★";
      return `${i + 1}. ${from} — ${m.subject}${unread} (${date})`;
    });
    // IDs at the end for tool use (outlook_read), not for display
    const idMap = data.value.map((m: any, i: number) => `#${i + 1}=${m.id}`);
    return { content: [{ type: "text", text: lines.join("\n") + "\n\n[IDs pour outlook_read: " + idMap.join(", ") + "]" }] };
  }
);

server.tool(
  "outlook_read",
  "Read a specific email by ID",
  { messageId: z.string().describe("Outlook message ID") },
  async ({ messageId }) => {
    const msg = await graph("outlook", `/me/messages/${messageId}?$select=subject,from,toRecipients,receivedDateTime,body`);
    const body = msg.body?.contentType === "text"
      ? msg.body.content
      : (msg.body?.content || "").replace(/<[^>]+>/g, " ").substring(0, 5000);

    return {
      content: [{
        type: "text",
        text: `From: ${msg.from?.emailAddress?.address}\nTo: ${msg.toRecipients?.map((r: any) => r.emailAddress?.address).join(", ")}\nDate: ${msg.receivedDateTime}\nSubject: ${msg.subject}\n\n${body || "(empty body)"}`,
      }],
    };
  }
);

server.tool(
  "outlook_send",
  "Send an email via Outlook",
  {
    to: z.string().describe("Recipient email"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body (plain text)"),
    cc: z.string().optional().describe("CC recipient(s), comma-separated"),
  },
  async ({ to, subject, body, cc }) => {
    const message: any = {
      subject,
      body: { contentType: "Text", content: body },
      toRecipients: to.split(",").map((e) => ({ emailAddress: { address: e.trim() } })),
    };
    if (cc) {
      message.ccRecipients = cc.split(",").map((e) => ({ emailAddress: { address: e.trim() } }));
    }

    await graph("outlook", "/me/sendMail", {
      method: "POST",
      body: JSON.stringify({ message }),
    });
    return { content: [{ type: "text", text: `Email sent to ${to}` }] };
  }
);

server.tool(
  "outlook_draft",
  "Create a draft email in Outlook",
  {
    to: z.string().describe("Recipient email"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Email body (plain text)"),
  },
  async ({ to, subject, body }) => {
    const result = await graph("outlook", "/me/messages", {
      method: "POST",
      body: JSON.stringify({
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: [{ emailAddress: { address: to } }],
        isDraft: true,
      }),
    });
    return { content: [{ type: "text", text: `Draft created (ID: ${result.id})` }] };
  }
);

server.tool(
  "outlook_folders",
  "List Outlook mail folders",
  {},
  async () => {
    const data = await graph("outlook", "/me/mailFolders?$top=50");
    if (!data.value?.length) return { content: [{ type: "text", text: "No folders found." }] };

    const lines = data.value.map((f: any) =>
      `[${f.id}] ${f.displayName} (${f.totalItemCount} items, ${f.unreadItemCount} unread)`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "outlook_move",
  "Move an email to a folder",
  {
    messageId: z.string().describe("Message ID"),
    folderId: z.string().describe("Destination folder ID"),
  },
  async ({ messageId, folderId }) => {
    await graph("outlook", `/me/messages/${messageId}/move`, {
      method: "POST",
      body: JSON.stringify({ destinationId: folderId }),
    });
    return { content: [{ type: "text", text: `Message moved.` }] };
  }
);

server.tool(
  "outlook_trash",
  "Move an email to trash",
  { messageId: z.string().describe("Message ID") },
  async ({ messageId }) => {
    await graph("outlook", `/me/messages/${messageId}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Message ${messageId} deleted.` }] };
  }
);

server.tool(
  "outlook_mark_read",
  "Mark an email as read or unread",
  {
    messageId: z.string().describe("Message ID"),
    unread: z.boolean().default(false).describe("true = mark unread, false = mark read"),
  },
  async ({ messageId, unread }) => {
    await graph("outlook", `/me/messages/${messageId}`, {
      method: "PATCH",
      body: JSON.stringify({ isRead: !unread }),
    });
    return { content: [{ type: "text", text: `Message marked as ${unread ? "unread" : "read"}.` }] };
  }
);

// ═══════════════════════════════════════════════
//  Calendar
// ═══════════════════════════════════════════════

server.tool(
  "ms_calendar_list",
  "List upcoming calendar events",
  { maxResults: z.number().default(10), daysAhead: z.number().default(7) },
  async ({ maxResults, daysAhead }) => {
    const now = new Date().toISOString();
    // daysAhead: 0 means "rest of today" — use at least end of current day
    const minUntil = new Date();
    minUntil.setHours(23, 59, 59, 999);
    const computedUntil = new Date(Date.now() + daysAhead * 86400000);
    const until = (daysAhead === 0 ? minUntil : computedUntil).toISOString();
    const data = await graph("calendar", `/me/calendarView?startDateTime=${now}&endDateTime=${until}&$top=${maxResults}&$orderby=start/dateTime&$select=id,subject,start,end,organizer`);

    if (!data.value?.length) return { content: [{ type: "text", text: "Microsoft Calendar connected — no upcoming events in the next " + daysAhead + " day(s)." }] };

    const lines = data.value.map((e: any) =>
      `[${e.id}] ${e.start?.dateTime || "?"} — ${e.subject || "(no title)"}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "ms_calendar_create",
  "Create a calendar event",
  {
    subject: z.string().describe("Event title"),
    start: z.string().describe("Start datetime (ISO 8601)"),
    end: z.string().describe("End datetime (ISO 8601)"),
    body: z.string().optional().describe("Event description"),
    attendees: z.array(z.string()).optional().describe("List of attendee emails"),
    timeZone: z.string().default("Europe/Paris").describe("Time zone"),
  },
  async ({ subject, start, end, body, attendees, timeZone }) => {
    const event: any = {
      subject,
      start: { dateTime: start, timeZone },
      end: { dateTime: end, timeZone },
    };
    if (body) event.body = { contentType: "Text", content: body };
    if (attendees?.length) {
      event.attendees = attendees.map((e) => ({
        emailAddress: { address: e },
        type: "required",
      }));
    }

    const result = await graph("calendar", "/me/events", {
      method: "POST",
      body: JSON.stringify(event),
    });
    return { content: [{ type: "text", text: `Event created: "${result.subject}" (${result.webLink})` }] };
  }
);

server.tool(
  "ms_calendar_delete",
  "Delete a calendar event by ID. Use ms_calendar_list first to get the event ID.",
  {
    eventId: z.string().describe("Event ID to delete (from ms_calendar_list)"),
  },
  async ({ eventId }) => {
    await graph("calendar", `/me/events/${eventId}`, {
      method: "DELETE",
    });
    return { content: [{ type: "text", text: `Event ${eventId} deleted successfully.` }] };
  }
);

server.tool(
  "ms_calendar_update",
  "Update an existing calendar event. Use ms_calendar_list first to get the event ID.",
  {
    eventId: z.string().describe("Event ID to update (from ms_calendar_list)"),
    subject: z.string().optional().describe("New event title"),
    start: z.string().optional().describe("New start datetime (ISO 8601)"),
    end: z.string().optional().describe("New end datetime (ISO 8601)"),
    body: z.string().optional().describe("New event description"),
    timeZone: z.string().default("Europe/Paris").describe("Time zone"),
  },
  async ({ eventId, subject, start, end, body, timeZone }) => {
    const patch: any = {};
    if (subject) patch.subject = subject;
    if (start) patch.start = { dateTime: start, timeZone };
    if (end) patch.end = { dateTime: end, timeZone };
    if (body) patch.body = { contentType: "Text", content: body };

    const result = await graph("calendar", `/me/events/${eventId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return { content: [{ type: "text", text: `Event updated: "${result.subject}" (${result.webLink})` }] };
  }
);

// ═══════════════════════════════════════════════
//  OneDrive
// ═══════════════════════════════════════════════

server.tool(
  "onedrive_search",
  "Search files in OneDrive",
  { query: z.string().describe("Search query"), maxResults: z.number().default(10) },
  async ({ query, maxResults }) => {
    const data = await graph("onedrive", `/me/drive/root/search(q='${encodeURIComponent(query)}')?$top=${maxResults}&$select=id,name,size,lastModifiedDateTime,webUrl`);

    if (!data.value?.length) return { content: [{ type: "text", text: "No files found." }] };

    const lines = data.value.map((f: any) =>
      `[${f.id}] ${f.name} (${(f.size / 1024).toFixed(1)} KB) — modified ${f.lastModifiedDateTime} — ${f.webUrl || ""}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "onedrive_deep_search",
  "Deep search across all OneDrive folders — finds files by keyword in name or content, returns full folder path. Use for finding files buried in subfolders.",
  {
    keyword: z.string().describe("Search keyword (e.g. 'bulletin de salaire', 'facture', 'contrat')"),
    fileType: z.enum(["any", "pdf", "doc", "sheet", "image", "video", "audio", "folder"]).default("any").describe("Filter by file type"),
    maxResults: z.number().default(30).describe("Max results (up to 100)"),
  },
  async ({ keyword, fileType, maxResults }) => {
    const cap = Math.min(maxResults, 100);

    // OneDrive search is recursive by default from root
    const data = await graph(
      "onedrive",
      `/me/drive/root/search(q='${encodeURIComponent(keyword)}')?$top=${cap}&$select=id,name,size,file,folder,lastModifiedDateTime,webUrl,parentReference`
    );

    if (!data.value?.length) return { content: [{ type: "text", text: `No files found for "${keyword}".` }] };

    // Filter by file type if needed
    let results = data.value;
    if (fileType !== "any") {
      const typeFilters: Record<string, (f: any) => boolean> = {
        pdf: (f) => f.file?.mimeType === "application/pdf",
        doc: (f) => /word|document/i.test(f.file?.mimeType || ""),
        sheet: (f) => /spreadsheet|excel/i.test(f.file?.mimeType || ""),
        image: (f) => /^image\//i.test(f.file?.mimeType || ""),
        video: (f) => /^video\//i.test(f.file?.mimeType || ""),
        audio: (f) => /^audio\//i.test(f.file?.mimeType || ""),
        folder: (f) => !!f.folder,
      };
      if (typeFilters[fileType]) {
        results = results.filter(typeFilters[fileType]);
      }
    }

    if (!results.length) return { content: [{ type: "text", text: `No ${fileType} files found for "${keyword}".` }] };

    // Format results with folder path from parentReference
    const lines = results.map((f: any) => {
      const folderPath = f.parentReference?.path
        ? f.parentReference.path.replace(/^\/drive\/root:?\/?/, "/") || "/"
        : "/";
      const sizeKB = f.size ? `${(f.size / 1024).toFixed(1)} KB` : "";
      const mime = f.file?.mimeType || (f.folder ? "folder" : "unknown");
      return `[${f.id}] 📄 ${f.name}\n   📁 ${folderPath}\n   ${mime} ${sizeKB} — ${f.lastModifiedDateTime || ""}`;
    });

    return {
      content: [{
        type: "text",
        text: `Found ${results.length} result(s) for "${keyword}":\n\n${lines.join("\n\n")}`,
      }],
    };
  }
);

server.tool(
  "onedrive_read",
  "Read/download text content from a OneDrive file",
  { fileId: z.string().describe("OneDrive file ID") },
  async ({ fileId }) => {
    const meta = await graph("onedrive", `/me/drive/items/${fileId}?$select=id,name,size,file`);
    const token = await getToken("onedrive");
    const res = await fetch(`${GRAPH}/me/drive/items/${fileId}/content`, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "follow",
    });

    let content: string;
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("text") || ct.includes("json") || ct.includes("xml")) {
      content = await res.text();
      if (content.length > 10000) content = content.substring(0, 10000) + "\n... (truncated)";
    } else {
      content = `(Binary file: ${meta.file?.mimeType || ct}, ${(meta.size / 1024).toFixed(1)} KB — use webUrl to download)`;
    }

    return { content: [{ type: "text", text: `File: ${meta.name}\n\n${content}` }] };
  }
);

server.tool(
  "onedrive_create_folder",
  "Create a folder in OneDrive",
  {
    name: z.string().describe("Folder name"),
    parentId: z.string().default("root").describe("Parent folder ID (default: root)"),
  },
  async ({ name, parentId }) => {
    const parentPath = parentId === "root" ? "/me/drive/root" : `/me/drive/items/${parentId}`;
    const result = await graph("onedrive", `${parentPath}/children`, {
      method: "POST",
      body: JSON.stringify({
        name,
        folder: {},
        "@microsoft.graph.conflictBehavior": "rename",
      }),
    });
    return { content: [{ type: "text", text: `Folder created: "${result.name}" (ID: ${result.id}) — ${result.webUrl || ""}` }] };
  }
);

server.tool(
  "onedrive_upload",
  "Upload/create a text file in OneDrive (code, markdown, JSON, CSV, etc.)",
  {
    name: z.string().describe("File name with extension (e.g. 'report.md', 'data.csv', 'app.py')"),
    content: z.string().describe("File text content"),
    parentId: z.string().default("root").describe("Parent folder ID (default: root)"),
  },
  async ({ name, content, parentId }) => {
    const parentPath = parentId === "root" ? "/me/drive/root" : `/me/drive/items/${parentId}`;
    const token = await getToken("onedrive");
    const res = await fetch(`${GRAPH}${parentPath}:/${encodeURIComponent(name)}:/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: content,
    });
    if (!res.ok) {
      const errText = (await res.text()).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/token[=:]\s*\S+/gi, "token=[REDACTED]");
      throw new Error(`OneDrive upload error: ${errText}`);
    }
    const result = await res.json();
    return { content: [{ type: "text", text: `File created: "${result.name}" (ID: ${result.id}) — ${result.webUrl || ""}` }] };
  }
);

server.tool(
  "onedrive_update",
  "Update/overwrite an existing file in OneDrive",
  {
    fileId: z.string().describe("OneDrive file ID"),
    content: z.string().describe("New file content (replaces existing)"),
  },
  async ({ fileId, content }) => {
    const token = await getToken("onedrive");
    const res = await fetch(`${GRAPH}/me/drive/items/${fileId}/content`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/octet-stream",
      },
      body: content,
    });
    if (!res.ok) {
      const errText = (await res.text()).replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]").replace(/token[=:]\s*\S+/gi, "token=[REDACTED]");
      throw new Error(`OneDrive update error: ${errText}`);
    }
    const result = await res.json();
    return { content: [{ type: "text", text: `File updated: "${result.name}" (ID: ${result.id})` }] };
  }
);

server.tool(
  "onedrive_list_folder",
  "List files in a OneDrive folder",
  {
    folderId: z.string().default("root").describe("Folder ID (default: root)"),
    maxResults: z.number().default(20),
  },
  async ({ folderId, maxResults }) => {
    const endpoint = folderId === "root"
      ? `/me/drive/root/children?$select=id,name,folder,file,lastModifiedDateTime,size,webUrl&$top=${maxResults}&$orderby=name`
      : `/me/drive/items/${folderId}/children?$select=id,name,folder,file,lastModifiedDateTime,size,webUrl&$top=${maxResults}&$orderby=name`;

    const data = await graph("onedrive", endpoint);
    if (!data.value?.length) return { content: [{ type: "text", text: "Empty folder." }] };

    const lines = data.value.map((f: any) =>
      `[${f.id}] ${f.folder ? "📁" : "📄"} ${f.name} (${f.folder ? "folder" : f.file?.mimeType || "file"}) — ${f.lastModifiedDateTime}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "onedrive_move",
  "Move a file or folder to a different OneDrive folder",
  {
    fileId: z.string().describe("ID of the file or folder to move"),
    newParentId: z.string().describe("ID of the destination folder (use 'root' for root)"),
  },
  async ({ fileId, newParentId }) => {
    const parentRef = newParentId === "root"
      ? { path: "/drive/root" }
      : { id: newParentId };

    const result = await graph("onedrive", `/me/drive/items/${fileId}`, {
      method: "PATCH",
      body: JSON.stringify({ parentReference: parentRef }),
    });
    return { content: [{ type: "text", text: `Moved "${result.name}" to ${newParentId}` }] };
  }
);

server.tool(
  "onedrive_delete",
  "Delete a file or folder from OneDrive (moves to recycle bin)",
  {
    fileId: z.string().describe("ID of the file or folder to delete"),
  },
  async ({ fileId }) => {
    await graph("onedrive", `/me/drive/items/${fileId}`, { method: "DELETE" });
    return { content: [{ type: "text", text: `Deleted item ${fileId} (moved to recycle bin)` }] };
  }
);

server.tool(
  "onedrive_rename",
  "Rename a file or folder in OneDrive",
  {
    fileId: z.string().describe("ID of the file or folder to rename"),
    newName: z.string().describe("New name for the file or folder"),
  },
  async ({ fileId, newName }) => {
    const result = await graph("onedrive", `/me/drive/items/${fileId}`, {
      method: "PATCH",
      body: JSON.stringify({ name: newName }),
    });
    return { content: [{ type: "text", text: `Renamed to "${result.name}"` }] };
  }
);

// ═══════════════════════════════════════════════
//  Teams
// ═══════════════════════════════════════════════

server.tool(
  "teams_chats",
  "List recent Teams chats",
  { maxResults: z.number().default(10) },
  async ({ maxResults }) => {
    const data = await graph("teams", `/me/chats?$top=${maxResults}&$expand=members`);
    if (!data.value?.length) return { content: [{ type: "text", text: "No chats found." }] };

    const lines = data.value.map((c: any) => {
      const members = c.members?.map((m: any) => m.displayName || m.email).join(", ") || "?";
      return `[${c.id}] ${c.topic || "(no topic)"} — ${c.chatType} — ${members}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "teams_read_messages",
  "Read/get messages from a Teams chat. Use this to read chat messages, get conversation content, or see what someone sent in Teams.",
  {
    chatId: z.string().describe("Teams chat ID"),
    maxResults: z.number().default(15).describe("Number of messages to retrieve"),
  },
  async ({ chatId, maxResults }) => {
    const data = await graph("teams", `/me/chats/${chatId}/messages?$top=${maxResults}&$orderby=createdDateTime desc`);
    if (!data.value?.length) return { content: [{ type: "text", text: "No messages in this chat." }] };

    const lines = data.value
      .filter((m: any) => m.body?.content)
      .map((m: any) => {
        const from = m.from?.user?.displayName || m.from?.application?.displayName || "Unknown";
        const date = m.createdDateTime ? new Date(m.createdDateTime).toLocaleString("fr-FR") : "";
        // Strip HTML tags from body content
        const text = (m.body.content || "").replace(/<[^>]*>/g, "").trim();
        return `[${date}] ${from}: ${text}`;
      });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "teams_send",
  "Send a message in a Teams chat",
  {
    chatId: z.string().describe("Teams chat ID"),
    text: z.string().describe("Message text"),
  },
  async ({ chatId, text }) => {
    const result = await graph("teams", `/me/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        body: { contentType: "text", content: text },
      }),
    });
    return { content: [{ type: "text", text: `Message sent (${result.id})` }] };
  }
);

server.tool(
  "teams_send_file",
  "Send a file (image, document) as a hosted content attachment in a Teams chat. Reads file from local path.",
  {
    chatId: z.string().describe("Teams chat ID"),
    filePath: z.string().describe("Absolute local path to the file to send"),
    fileName: z.string().optional().describe("Display name for the file (defaults to filename from path)"),
  },
  async ({ chatId, filePath, fileName }) => {
    const fs = await import("node:fs");
    const path = await import("node:path");

    if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);
    const fileBuffer = fs.readFileSync(filePath);
    const name = fileName || path.basename(filePath);
    const ext = path.extname(filePath).toLowerCase();

    // Detect MIME type
    const mimeMap: Record<string, string> = {
      ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
      ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      ".txt": "text/plain", ".csv": "text/csv", ".html": "text/html",
    };
    const contentType = mimeMap[ext] || "application/octet-stream";

    // Step 1: Upload as hosted content
    const token = await getToken("teams");
    const uploadRes = await fetch(`${GRAPH}/me/chats/${chatId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body: { contentType: "html", content: `<attachment id="file"></attachment>` },
        attachments: [{
          id: "file",
          contentType: "reference",
          contentUrl: `file:///${name}`,
          name,
        }],
        hostedContents: [{
          "@microsoft.graph.temporaryId": "file",
          contentBytes: fileBuffer.toString("base64"),
          contentType,
        }],
      }),
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      const safeErr = err.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
      throw new Error(`Teams file send error (${uploadRes.status}): ${safeErr.substring(0, 200)}`);
    }

    const result = await uploadRes.json();
    return { content: [{ type: "text", text: `File "${name}" sent in Teams chat (${result.id})` }] };
  }
);

// ═══════════════════════════════════════════════
//  To Do
// ═══════════════════════════════════════════════

server.tool(
  "todo_list",
  "List Microsoft To Do tasks",
  { maxResults: z.number().default(20) },
  async ({ maxResults }) => {
    // Get default task list
    const lists = await graph("todo", "/me/todo/lists");
    const listId = lists.value?.[0]?.id;
    if (!listId) return { content: [{ type: "text", text: "No task lists found." }] };

    const data = await graph("todo", `/me/todo/lists/${listId}/tasks?$top=${maxResults}`);
    if (!data.value?.length) return { content: [{ type: "text", text: "No tasks." }] };

    const lines = data.value.map((t: any) =>
      `[${t.id}] [${t.status === "completed" ? "x" : " "}] ${t.title}${t.dueDateTime ? ` (due: ${t.dueDateTime.dateTime})` : ""}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "todo_create",
  "Create a Microsoft To Do task",
  {
    title: z.string().describe("Task title"),
    body: z.string().optional().describe("Task notes"),
    dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
  },
  async ({ title, body, dueDate }) => {
    const lists = await graph("todo", "/me/todo/lists");
    const listId = lists.value?.[0]?.id;
    if (!listId) return { content: [{ type: "text", text: "No task lists found." }] };

    const task: any = { title };
    if (body) task.body = { content: body, contentType: "text" };
    if (dueDate) task.dueDateTime = { dateTime: `${dueDate}T00:00:00`, timeZone: "Europe/Paris" };

    const result = await graph("todo", `/me/todo/lists/${listId}/tasks`, {
      method: "POST",
      body: JSON.stringify(task),
    });
    return { content: [{ type: "text", text: `Task created: "${result.title}" (${result.id})` }] };
  }
);

server.tool(
  "todo_update",
  "Update a Microsoft To Do task. Use todo_list first to get the task ID.",
  {
    taskId: z.string().describe("Task ID to update"),
    title: z.string().optional().describe("New task title"),
    body: z.string().optional().describe("New task notes"),
    dueDate: z.string().optional().describe("New due date (YYYY-MM-DD)"),
    status: z.enum(["notStarted", "inProgress", "completed"]).optional().describe("Task status"),
  },
  async ({ taskId, title, body, dueDate, status }) => {
    const lists = await graph("todo", "/me/todo/lists");
    const listId = lists.value?.[0]?.id;
    if (!listId) return { content: [{ type: "text", text: "No task lists found." }] };

    const patch: any = {};
    if (title) patch.title = title;
    if (body) patch.body = { content: body, contentType: "text" };
    if (dueDate) patch.dueDateTime = { dateTime: `${dueDate}T00:00:00`, timeZone: "Europe/Paris" };
    if (status) patch.status = status;

    const result = await graph("todo", `/me/todo/lists/${listId}/tasks/${taskId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return { content: [{ type: "text", text: `Task updated: "${result.title}" (${result.status})` }] };
  }
);

server.tool(
  "todo_delete",
  "Delete a Microsoft To Do task. Use todo_list first to get the task ID.",
  {
    taskId: z.string().describe("Task ID to delete"),
  },
  async ({ taskId }) => {
    const lists = await graph("todo", "/me/todo/lists");
    const listId = lists.value?.[0]?.id;
    if (!listId) return { content: [{ type: "text", text: "No task lists found." }] };

    await graph("todo", `/me/todo/lists/${listId}/tasks/${taskId}`, {
      method: "DELETE",
    });
    return { content: [{ type: "text", text: `Task ${taskId} deleted successfully.` }] };
  }
);

// ═══════════════════════════════════════════════
//  OneNote
// ═══════════════════════════════════════════════

server.tool(
  "onenote_notebooks",
  "List OneNote notebooks",
  {},
  async () => {
    const data = await graph("onenote", "/me/onenote/notebooks?$select=id,displayName,lastModifiedDateTime");
    if (!data.value?.length) return { content: [{ type: "text", text: "No notebooks found." }] };

    const lines = data.value.map((n: any) =>
      `[${n.id}] ${n.displayName} — modified ${n.lastModifiedDateTime}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "onenote_sections",
  "List sections in a OneNote notebook. Use onenote_notebooks first to get the notebook ID.",
  { notebookId: z.string().describe("OneNote notebook ID (from onenote_notebooks)") },
  async ({ notebookId }) => {
    const data = await graph("onenote", `/me/onenote/notebooks/${notebookId}/sections?$select=id,displayName,createdDateTime`);
    if (!data.value?.length) return { content: [{ type: "text", text: "No sections found in this notebook." }] };

    const lines = data.value.map((s: any) =>
      `[${s.id}] ${s.displayName} — created ${s.createdDateTime}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "onenote_pages",
  "List pages in a OneNote section",
  { sectionId: z.string().describe("OneNote section ID") },
  async ({ sectionId }) => {
    const data = await graph("onenote", `/me/onenote/sections/${sectionId}/pages?$select=id,title,createdDateTime`);
    if (!data.value?.length) return { content: [{ type: "text", text: "No pages found." }] };

    const lines = data.value.map((p: any) =>
      `[${p.id}] ${p.title} — created ${p.createdDateTime}`
    );
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "onenote_read_page",
  "Read the content of a OneNote page. Returns HTML content.",
  {
    pageId: z.string().describe("OneNote page ID (from onenote_pages)"),
  },
  async ({ pageId }) => {
    const token = await getToken("onenote");
    const res = await fetch(`${GRAPH}/me/onenote/pages/${pageId}/content`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OneNote read error (${res.status}): ${err.substring(0, 200)}`);
    }
    let html = await res.text();
    if (html.length > 10000) html = html.substring(0, 10000) + "\n... (truncated)";
    return { content: [{ type: "text", text: html }] };
  }
);

server.tool(
  "onenote_write_page",
  "Create a new page in a OneNote section. Content is HTML.",
  {
    sectionId: z.string().describe("OneNote section ID"),
    title: z.string().describe("Page title"),
    htmlContent: z.string().describe("Page content in HTML format"),
  },
  async ({ sectionId, title, htmlContent }) => {
    const token = await getToken("onenote");
    const html = `<!DOCTYPE html><html><head><title>${title}</title></head><body>${htmlContent}</body></html>`;
    const res = await fetch(`${GRAPH}/me/onenote/sections/${sectionId}/pages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/xhtml+xml",
      },
      body: html,
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OneNote write error (${res.status}): ${err.substring(0, 200)}`);
    }
    const result = await res.json();
    return { content: [{ type: "text", text: `Page created: "${result.title}" (${result.id})` }] };
  }
);

server.tool(
  "onenote_update_page",
  "Append content to an existing OneNote page. Use onenote_pages first to get the page ID.",
  {
    pageId: z.string().describe("OneNote page ID (from onenote_pages)"),
    htmlContent: z.string().describe("HTML content to append to the page"),
  },
  async ({ pageId, htmlContent }) => {
    const token = await getToken("onenote");
    const patchBody = [{
      target: "body",
      action: "append",
      content: htmlContent,
    }];
    const res = await fetch(`${GRAPH}/me/onenote/pages/${pageId}/content`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(patchBody),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OneNote update error (${res.status}): ${err.substring(0, 200)}`);
    }
    return { content: [{ type: "text", text: `Page ${pageId} updated successfully.` }] };
  }
);

// ═══════════════════════════════════════════════
//  Contacts
// ═══════════════════════════════════════════════

server.tool(
  "contacts_list",
  "List Microsoft contacts",
  { maxResults: z.number().default(20) },
  async ({ maxResults }) => {
    const data = await graph("contacts", `/me/contacts?$top=${maxResults}&$select=id,displayName,emailAddresses,mobilePhone,companyName`);
    if (!data.value?.length) return { content: [{ type: "text", text: "No contacts found." }] };

    const lines = data.value.map((c: any) => {
      const email = c.emailAddresses?.[0]?.address || "";
      return `[${c.id}] ${c.displayName}${email ? ` <${email}>` : ""}${c.companyName ? ` — ${c.companyName}` : ""}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "ms_contacts_search",
  "Search Microsoft contacts by name, email, or company",
  {
    query: z.string().describe("Search query (name, email, or company)"),
    maxResults: z.number().default(10),
  },
  async ({ query, maxResults }) => {
    const data = await graph("contacts", `/me/contacts?$filter=contains(displayName,'${query}') or contains(companyName,'${query}')&$top=${maxResults}&$select=id,displayName,emailAddresses,mobilePhone,companyName`);
    if (!data.value?.length) return { content: [{ type: "text", text: `No contacts found for "${query}".` }] };

    const lines = data.value.map((c: any) => {
      const email = c.emailAddresses?.[0]?.address || "";
      return `[${c.id}] ${c.displayName}${email ? ` <${email}>` : ""}${c.companyName ? ` — ${c.companyName}` : ""}`;
    });
    return { content: [{ type: "text", text: lines.join("\n") }] };
  }
);

server.tool(
  "contacts_create",
  "Create a Microsoft contact",
  {
    givenName: z.string().describe("First name"),
    surname: z.string().describe("Last name"),
    email: z.string().optional().describe("Email address"),
    phone: z.string().optional().describe("Phone number"),
    company: z.string().optional().describe("Company name"),
  },
  async ({ givenName, surname, email, phone, company }) => {
    const contact: any = { givenName, surname };
    if (email) contact.emailAddresses = [{ address: email }];
    if (phone) contact.mobilePhone = phone;
    if (company) contact.companyName = company;

    const result = await graph("contacts", "/me/contacts", {
      method: "POST",
      body: JSON.stringify(contact),
    });
    return { content: [{ type: "text", text: `Contact created: "${result.displayName}" (${result.id})` }] };
  }
);

server.tool(
  "ms_contacts_update",
  "Update an existing Microsoft contact",
  {
    contactId: z.string().describe("Contact ID to update"),
    givenName: z.string().optional().describe("First name"),
    surname: z.string().optional().describe("Last name"),
    email: z.string().optional().describe("Email address"),
    phone: z.string().optional().describe("Phone number"),
    company: z.string().optional().describe("Company name"),
  },
  async ({ contactId, givenName, surname, email, phone, company }) => {
    const patch: any = {};
    if (givenName) patch.givenName = givenName;
    if (surname) patch.surname = surname;
    if (email) patch.emailAddresses = [{ address: email }];
    if (phone) patch.mobilePhone = phone;
    if (company) patch.companyName = company;

    const result = await graph("contacts", `/me/contacts/${contactId}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    });
    return { content: [{ type: "text", text: `Contact updated: "${result.displayName}" (${result.id})` }] };
  }
);

server.tool(
  "ms_contacts_delete",
  "Delete a Microsoft contact",
  {
    contactId: z.string().describe("Contact ID to delete"),
  },
  async ({ contactId }) => {
    await graph("contacts", `/me/contacts/${contactId}`, {
      method: "DELETE",
    });
    return { content: [{ type: "text", text: `Contact ${contactId} deleted successfully.` }] };
  }
);

// ─── Start ───

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  wrapTransportWithAuth(transport, auth);

  console.error("[ubik-microsoft] MCP server started (31 tools)");
}

main().catch((err) => {
  console.error("[ubik-microsoft] Fatal:", err);
  process.exit(1);
});
