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

// ─── New tools (issue #14 enrich) ────────────────────────────────────────────

server.tool(
  "linkedin_get_company",
  "Returns details for a LinkedIn organization (company) by ID or vanity name. Requires r_organization_social or r_basicprofile scope.",
  {
    id:          z.string().optional().describe("Organization numeric ID (e.g. '1441')"),
    vanity_name: z.string().optional().describe("Organization vanity name (e.g. 'google')"),
  },
  async ({ id, vanity_name }) => {
    try {
      if (!id && !vanity_name) {
        return { content: [{ type: "text", text: "Provide either id or vanity_name." }], isError: true };
      }
      const endpoint = id
        ? `/v2/organizations/${encodeURIComponent(id)}`
        : `/v2/organizations?q=vanityName&vanityName=${encodeURIComponent(vanity_name!)}`;
      const data = await liApi(endpoint);
      const org = id ? data : data.elements?.[0] ?? null;
      if (!org) return { content: [{ type: "text", text: `Organization not found: ${id ?? vanity_name}` }], isError: true };
      const lines = [
        `ID: ${org.id ?? "?"}`,
        `Vanity Name: ${org.vanityName ?? "N/A"}`,
        `Name: ${org.localizedName ?? org.name?.localized?.en_US ?? "?"}`,
        `Website: ${org.websiteUrl ?? "N/A"}`,
        `Industry: ${(org.industries ?? []).join(", ") || "N/A"}`,
        `Staff range: ${org.staffCountRange ?? "N/A"}`,
        `Founded: ${org.foundedOn?.year ?? "N/A"}`,
        `Description: ${(org.localizedDescription ?? "").substring(0, 500)}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error fetching company: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "linkedin_search_companies",
  "Search LinkedIn organizations by keyword. LIMITATION: requires r_organization_social or LinkedIn Marketing API access — returns 403 for most personal tokens.",
  {
    query:       z.string().describe("Free-text search (company name, industry)"),
    max_results: z.number().int().positive().max(50).default(10).describe("Maximum results to return"),
  },
  async ({ query, max_results }) => {
    try {
      const result = await liApi(`/v2/search/blended?q=organizations&keywords=${encodeURIComponent(query)}&count=${max_results}`);
      const elements = result.elements ?? [];
      if (!elements.length) return { content: [{ type: "text", text: "No companies found." }] };
      const lines = elements.map((el: any, i: number) => {
        const name      = el.title?.text ?? el.name ?? "Unknown";
        const headline  = el.headline?.text ?? "";
        const id        = el.id ?? el.entityUrn ?? "";
        return `${i + 1}. ${name} — ${headline} ${id ? `(${id})` : ""}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      if (err.message.includes("403") || err.message.includes("401")) {
        return {
          content: [{
            type: "text",
            text:
              "Companies search not available with current LinkedIn scopes. " +
              "Requires r_organization_social or LinkedIn Marketing/Sales Navigator API.",
          }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: `Error searching companies: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "linkedin_list_connections",
  "List 1st-degree connections of the authenticated user. LIMITATION: requires r_1st_connections scope — returns 403 for openid/profile tokens (default scope set).",
  {
    start: z.number().int().min(0).default(0).describe("Pagination offset"),
    count: z.number().int().positive().max(50).default(10).describe("Page size"),
  },
  async ({ start, count }) => {
    try {
      const result = await liApi(`/v2/connections?q=viewer&start=${start}&count=${count}`);
      const elements = result.elements ?? [];
      if (!elements.length) return { content: [{ type: "text", text: "No connections returned (or scope not granted)." }] };
      const lines = elements.map((el: any, i: number) => {
        const name = el.firstName?.localized?.en_US ?? el.firstName ?? "?";
        const last = el.lastName?.localized?.en_US ?? el.lastName ?? "";
        const head = el.headline?.localized?.en_US ?? el.headline ?? "";
        return `${start + i + 1}. ${name} ${last} — ${head}`;
      });
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      if (err.message.includes("403") || err.message.includes("401")) {
        return {
          content: [{
            type: "text",
            text:
              "Connections list not available — requires r_1st_connections scope, not granted by openid/profile/email.",
          }],
          isError: true,
        };
      }
      return { content: [{ type: "text", text: `Error listing connections: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "linkedin_get_post_stats",
  "Returns engagement stats for a UGC post (likes, comments, shares). Requires r_member_social or organization social scope.",
  {
    post_urn: z.string().describe("Full post URN, e.g. 'urn:li:share:1234' or 'urn:li:ugcPost:1234'"),
  },
  async ({ post_urn }) => {
    try {
      const encoded = encodeURIComponent(post_urn);
      const stats = await liApi(`/v2/socialActions/${encoded}`);
      const out = {
        post_urn,
        likes:    stats.likesSummary?.totalLikes ?? 0,
        comments: stats.commentsSummary?.aggregatedTotalComments ?? 0,
        shares:   stats.sharesSummary?.aggregatedTotalShares ?? 0,
        unique_actors: stats.likesSummary?.aggregatedTotalLikes ?? 0,
      };
      return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error fetching post stats: ${err.message}` }], isError: true };
    }
  },
);

server.tool(
  "linkedin_create_article",
  "Publishes a long-form article on LinkedIn under the authenticated user. LIMITATION: native article API access is limited; falls back to a UGC post containing title + body if the v2/originalArticles endpoint returns 403.",
  {
    title:      z.string().min(1).describe("Article title"),
    body:       z.string().min(1).describe("Article body (plain text, supports line breaks)"),
    visibility: z.enum(["PUBLIC", "CONNECTIONS"]).default("PUBLIC").describe("Article visibility"),
  },
  async ({ title, body, visibility }) => {
    try {
      const userinfo = await liApi("/v2/userinfo");
      const personId = userinfo.sub;
      if (!personId) throw new Error("Could not determine LinkedIn person ID from userinfo");
      const author   = `urn:li:person:${personId}`;

      try {
        const articleBody = {
          author,
          firstPublishedAt: Date.now(),
          state:            "PUBLISHED",
          title,
          content:          { text: body },
          visibility:       { "com.linkedin.ugc.MemberNetworkVisibility": visibility },
        };
        const result = await liApi("/v2/originalArticles", "POST", articleBody);
        return {
          content: [{
            type: "text",
            text: `Article published natively!\nID: ${result.id ?? "unknown"}\nTitle: ${title}\nVisibility: ${visibility}`,
          }],
        };
      } catch (nativeErr: any) {
        // Fall back to UGC post if native articles aren't accessible.
        const fallbackText = `# ${title}\n\n${body}`;
        const postBody = {
          author,
          lifecycleState: "PUBLISHED",
          specificContent: {
            "com.linkedin.ugc.ShareContent": {
              shareCommentary: { text: fallbackText },
              shareMediaCategory: "ARTICLE",
            },
          },
          visibility: { "com.linkedin.ugc.MemberNetworkVisibility": visibility },
        };
        const result = await liApi("/v2/ugcPosts", "POST", postBody);
        return {
          content: [{
            type: "text",
            text:
              `Native article API failed (${nativeErr.message}); fallback UGC post created.\n` +
              `Post ID: ${result.id ?? "unknown"}\nTitle: ${title}\nVisibility: ${visibility}`,
          }],
        };
      }
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error creating article: ${err.message}` }], isError: true };
    }
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-linkedin] Fatal: ${err}\n`);
  process.exit(1);
});
