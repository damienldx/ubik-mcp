#!/usr/bin/env node
/**
 * UBIK LinkedIn — MCP Server (stdio transport)
 *
 * Leverages OAuth tokens stored by UBIK's connector system
 * to expose LinkedIn APIs as MCP tools.
 *
 * Tools:
 *   - get_my_profile      → Get current user's LinkedIn profile
 *   - create_post          → Publish a LinkedIn post
 *   - search_people        → Search LinkedIn profiles (limited)
 *   - get_network_stats    → Get network statistics
 *   - send_message         → Send a LinkedIn message
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "dotenv";
import { join } from "node:path";
import { createMcpAuth, wrapTransportWithAuth } from "../lib/mcp-auth";

// Load .env from project root (cwd is set to UBIK root by .mcp.json)
config({ path: join(process.cwd(), ".env") });

const auth = createMcpAuth("ubik-linkedin");

// ─── LinkedIn API helper ───

async function liApi(endpoint: string, method = "GET", body?: any): Promise<any> {
  const token = await auth.fetchToken("linkedin", "linkedin");
  const res = await fetch(`https://api.linkedin.com${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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

// ─── MCP Server ───

const server = new McpServer({
  name: "ubik-linkedin",
  version: "1.0.0",
});

// ═══════════════════════════════════════════════
//  Profile
// ═══════════════════════════════════════════════

server.tool(
  "get_my_profile",
  "Get current user's LinkedIn profile (name, email, picture, headline)",
  {},
  async () => {
    try {
      // Use OpenID Connect userinfo endpoint (works with openid+profile+email scopes)
      const userinfo = await liApi("/v2/userinfo");

      // Also try /v2/me for headline and vanity name
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

// ═══════════════════════════════════════════════
//  Posts
// ═══════════════════════════════════════════════

server.tool(
  "create_post",
  "Publish a post on LinkedIn",
  {
    text: z.string().describe("The post content/text"),
    visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC").describe("Post visibility: PUBLIC or CONNECTIONS"),
  },
  async ({ text, visibility }) => {
    try {
      // First, get the person ID from userinfo
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

      return { content: [{ type: "text", text: `Post published successfully!\nPost ID: ${postId}\nVisibility: ${visibility}\nContent: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error creating post: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════
//  Search People
// ═══════════════════════════════════════════════

server.tool(
  "search_people",
  "Search LinkedIn profiles. LIMITATION: fails with 403 for most users (requires r_1st_connections or Sales Navigator scopes). Only use if the user explicitly asks.",
  {
    query: z.string().describe("Search query (name, company, title, etc.)"),
  },
  async ({ query }) => {
    try {
      // LinkedIn People Search API requires r_1st_connections or other premium scopes.
      // With our current scopes (openid, profile, email, w_member_social), this will likely fail.
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
            text: "Search is not available with current LinkedIn scopes (openid, profile, email, w_member_social). " +
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

// ═══════════════════════════════════════════════
//  Network Stats
// ═══════════════════════════════════════════════

server.tool(
  "get_network_stats",
  "Get LinkedIn network statistics. Note: connection/follower counts may return N/A due to scope limitations (r_network required).",
  {},
  async () => {
    try {
      // Get person URN first
      const userinfo = await liApi("/v2/userinfo");
      const personId = userinfo.sub;
      if (!personId) throw new Error("Could not determine LinkedIn person ID");

      const urn = encodeURIComponent(`urn:li:person:${personId}`);

      // Try to get network size
      let connectionsCount = "N/A";
      let followersCount = "N/A";

      try {
        const networkSize = await liApi(`/v2/networkSizes/${urn}?edgeType=CompanyFollowedByMember`);
        followersCount = String(networkSize.firstDegreeSize || networkSize.followerCount || "N/A");
      } catch {
        // May require additional scopes
      }

      try {
        const connections = await liApi(`/v2/connections?q=viewer&start=0&count=0`);
        connectionsCount = String(connections._total || connections.paging?.total || "N/A");
      } catch {
        // May require r_1st_connections scope
      }

      const lines = [
        `LinkedIn ID: ${personId}`,
        `Name: ${userinfo.name || "N/A"}`,
        `Connections: ${connectionsCount}`,
        `Followers: ${followersCount}`,
      ];

      if (connectionsCount === "N/A" && followersCount === "N/A") {
        lines.push(
          "",
          "Note: Network statistics may not be fully available with current scopes (openid, profile, email, w_member_social).",
          "Some stats require r_1st_connections or r_network scopes.",
        );
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error fetching network stats: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════
//  Messaging
// ═══════════════════════════════════════════════

server.tool(
  "linkedin_send_message",
  "Send a LinkedIn message. LIMITATION: requires LinkedIn Messaging API product access beyond w_member_social. Will fail with 403 for most users.",
  {
    recipientUrn: z.string().describe("Recipient URN (e.g. 'urn:li:person:ABC123')"),
    text: z.string().describe("Message text"),
  },
  async ({ recipientUrn, text }) => {
    try {
      // Get sender URN
      const userinfo = await liApi("/v2/userinfo");
      const personId = userinfo.sub;
      if (!personId) throw new Error("Could not determine LinkedIn person ID");

      const messageBody = {
        recipients: [recipientUrn],
        subject: "Message",
        body: text,
        messageType: "MEMBER_TO_MEMBER",
        senderUrn: `urn:li:person:${personId}`,
      };

      // Try the messaging API (requires w_member_social)
      // LinkedIn has moved to the messaging REST API
      const result = await liApi("/v2/messages", "POST", {
        mailboxUrn: `urn:li:person:${personId}`,
        recipients: [recipientUrn],
        subject: "Message",
        body: {
          text,
        },
      });

      return { content: [{ type: "text", text: `Message sent to ${recipientUrn}\nContent: ${text.substring(0, 100)}${text.length > 100 ? "..." : ""}` }] };
    } catch (err: any) {
      if (err.message.includes("403") || err.message.includes("401")) {
        return {
          content: [{
            type: "text",
            text: `Messaging failed: ${err.message}\n\nNote: LinkedIn messaging API access may be restricted. ` +
              "The w_member_social scope grants posting ability but messaging may require additional API products (LinkedIn Marketing API or LinkedIn Messaging API). " +
              "Check your LinkedIn app's API product access.",
          }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: `Error sending message: ${err.message}` }], isError: true };
    }
  }
);

// ─── Start ───

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  wrapTransportWithAuth(transport, auth);

  console.error("[ubik-linkedin] MCP server started (5 tools)");
}

main().catch((err) => {
  console.error("[ubik-linkedin] Fatal:", err);
  process.exit(1);
});
