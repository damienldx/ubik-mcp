#!/usr/bin/env node
/**
 * UBIK LinkedIn — standalone MCP stdio server.
 *
 * Tools (4):
 *   - linkedin_get_profile   Profile of the authenticated LinkedIn user.
 *   - linkedin_create_post   Publish a text post on LinkedIn.
 *   - linkedin_search_people Search LinkedIn profiles (limited by API scopes).
 *   - linkedin_send_message  Send a LinkedIn message (limited by API scopes).
 *
 * Auth: LINKEDIN_ACCESS_TOKEN read from process.env (or .env via dotenv).
 * Imports: @modelcontextprotocol/sdk, zod, dotenv, node:* only.
 */

import { z } from "zod";
import { config } from "dotenv";
import { createMcpServer, runServer } from "../lib/server.js";

config();

const TOKEN = process.env.LINKEDIN_ACCESS_TOKEN || "";
if (!TOKEN) {
  process.stderr.write("[ubik-linkedin] LINKEDIN_ACCESS_TOKEN missing in env — server will fail on every call\n");
}

const LI_API = "https://api.linkedin.com";

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function liApi(endpoint: string, method = "GET", body?: any): Promise<any> {
  const res = await fetch(`${LI_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "LinkedIn-Version": "202401",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const err = await res.text();
    const safeErr = err
      .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
      .replace(/token[=:]\s*\S+/gi, "token=[REDACTED]")
      .replace(/key[=:]\s*\S+/gi, "key=[REDACTED]");
    throw new Error(`LinkedIn API ${res.status}: ${safeErr}`);
  }
  return res.json();
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = createMcpServer("ubik-linkedin");

server.tool(
  "linkedin_get_profile",
  "Returns the profile of the authenticated LinkedIn user (name, email, headline, vanity name, picture URL).",
  {},
  async () => {
    try {
      const userinfo = await liApi("/v2/userinfo");
      let meData: any = null;
      try {
        meData = await liApi("/v2/me");
      } catch {
        // /v2/me may fail without r_liteprofile — that's fine
      }

      const name = userinfo.name || `${userinfo.given_name || ""} ${userinfo.family_name || ""}`.trim() || "Unknown";
      const email = userinfo.email || "N/A";
      const picture = userinfo.picture || "N/A";
      const sub = userinfo.sub || "N/A";
      const headline = meData?.localizedHeadline || "N/A";
      const vanityName = meData?.vanityName || "N/A";

      const lines = [
        `Name: ${name}`,
        `Email: ${email}`,
        `LinkedIn ID (sub): ${sub}`,
        `Headline: ${headline}`,
        `Vanity Name: ${vanityName}`,
        `Profile Picture: ${picture}`,
      ];

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error fetching profile: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "linkedin_create_post",
  "Publishes a text post on LinkedIn under the authenticated user.",
  {
    text: z.string().describe("Post content (plain text, supports line breaks)."),
    visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC").describe("PUBLIC = visible to anyone; CONNECTIONS = visible only to your connections."),
  },
  async ({ text, visibility }) => {
    try {
      const userinfo = await liApi("/v2/userinfo");
      const personId = userinfo.sub;
      if (!personId) throw new Error("Could not determine LinkedIn person ID from userinfo");

      const postBody = {
        author: `urn:li:person:${personId}`,
        lifecycleState: "PUBLISHED",
        specificContent: {
          "com.linkedin.ugc.ShareContent": {
            shareCommentary: { text },
            shareMediaCategory: "NONE",
          },
        },
        visibility: {
          "com.linkedin.ugc.MemberNetworkVisibility": visibility,
        },
      };

      const result = await liApi("/v2/ugcPosts", "POST", postBody);
      const postId = result.id || "unknown";

      return {
        content: [{
          type: "text",
          text: `Post published successfully!\nPost ID: ${postId}\nVisibility: ${visibility}\nContent: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}`,
        }],
      };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error creating post: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "linkedin_search_people",
  "Searches LinkedIn profiles by keyword (name, company, title). LIMITATION: returns 403 for most users — requires r_1st_connections or Sales Navigator API scopes. Only call if the user explicitly asks.",
  {
    query: z.string().describe("Free-text search query (name, company, job title, etc.)."),
  },
  async ({ query }) => {
    try {
      const result = await liApi(`/v2/search/blended?q=people&keywords=${encodeURIComponent(query)}&count=10`);
      const elements = result.elements || [];
      if (!elements.length) {
        return { content: [{ type: "text", text: "No results found." }] };
      }
      const lines = elements.map((el: any, i: number) => {
        const name = el.title?.text || el.name || "Unknown";
        const headline = el.headline?.text || "";
        return `${i + 1}. ${name} — ${headline}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      if (err.message.includes("403") || err.message.includes("401")) {
        return {
          content: [{
            type: "text",
            text:
              "Search is not available with current LinkedIn scopes (openid, profile, email, w_member_social). " +
              "LinkedIn People Search requires additional scopes like r_1st_connections or a LinkedIn Marketing/Sales Navigator API subscription. " +
              "You can still use get_my_profile and create_post.",
          }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: `Error searching: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "linkedin_send_message",
  "Sends a direct message to one LinkedIn user. LIMITATION: requires LinkedIn Messaging API product access beyond w_member_social — returns 403 for most users.",
  {
    recipientUrn: z.string().describe("Recipient URN in the form 'urn:li:person:<id>'."),
    text: z.string().describe("Message body (plain text)."),
  },
  async ({ recipientUrn, text }) => {
    try {
      const userinfo = await liApi("/v2/userinfo");
      const personId = userinfo.sub;
      if (!personId) throw new Error("Could not determine LinkedIn person ID");

      await liApi("/v2/messages", "POST", {
        mailboxUrn: `urn:li:person:${personId}`,
        recipients: [recipientUrn],
        subject: "Message",
        body: { text },
      });

      return {
        content: [{
          type: "text",
          text: `Message sent to ${recipientUrn}\nContent: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}`,
        }],
      };
    } catch (err: any) {
      if (err.message.includes("403") || err.message.includes("401")) {
        return {
          content: [{
            type: "text",
            text:
              `Messaging failed: ${err.message}\n\nNote: LinkedIn messaging API access may be restricted. ` +
              "The w_member_social scope grants posting ability but messaging may require additional API products. " +
              "Check your LinkedIn app's API product access.",
          }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: `Error sending message: ${err.message}` }], isError: true };
    }
  }
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-linkedin] Fatal: ${err}\n`);
  process.exit(1);
});
