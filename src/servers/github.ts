#!/usr/bin/env node
/**
 * UBIK GitHub — standalone MCP stdio server.
 *
 * Tools (6):
 *   - github_me            Get the authenticated user profile
 *   - github_list_repos    List repos for user/org
 *   - github_get_repo      Get repository details
 *   - github_create_repo   Create a new repository
 *   - github_list_prs      List pull requests
 *   - github_create_pr     Create a pull request
 *
 * Auth: GITHUB_TOKEN read from process.env (or .env via dotenv).
 * Imports: @modelcontextprotocol/sdk, zod, dotenv, node:* only.
 */

import { z } from "zod";
import { config } from "dotenv";
import { createMcpServer, runServer } from "../lib/server.js";

config();

const TOKEN = process.env.GITHUB_TOKEN || "";
if (!TOKEN) {
  process.stderr.write("[ubik-github] GITHUB_TOKEN missing in env — server will fail on every call\n");
}

const GH_API = "https://api.github.com";

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function ghApi(endpoint: string, method = "GET", body?: any): Promise<any> {
  const res = await fetch(`${GH_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "UBIK",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 204) return { ok: true };
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub API ${res.status}: ${err.substring(0, 500)}`);
  }
  return res.json();
}

// ─── Formatters ──────────────────────────────────────────────────────────────

function formatRepo(r: any): string {
  return [
    `${r.full_name}${r.private ? " (private)" : ""}${r.fork ? " (fork)" : ""}`,
    r.description ? `  ${r.description}` : null,
    `  ★ ${r.stargazers_count}  🍴 ${r.forks_count}  lang: ${r.language || "N/A"}`,
    `  default: ${r.default_branch}  updated: ${r.updated_at?.slice(0, 10)}`,
  ].filter(Boolean).join("\n");
}

function formatPr(p: any): string {
  return `#${p.number} [${p.state}${p.draft ? "/draft" : ""}] ${p.title} (${p.head?.ref} → ${p.base?.ref})${p.user ? ` by @${p.user.login}` : ""}`;
}

// ─── Server ──────────────────────────────────────────────────────────────────

const server = createMcpServer("ubik-github");

server.tool(
  "github_me",
  "Get the authenticated GitHub user profile",
  {},
  async () => {
    try {
      const user = await ghApi("/user");
      const lines = [
        `Login: @${user.login}`,
        `Node ID: ${user.node_id}`,
        `Name: ${user.name || "N/A"}`,
        `Email: ${user.email || "N/A"}`,
        `Bio: ${user.bio || "N/A"}`,
        `Public repos: ${user.public_repos}`,
        `Private repos: ${user.total_private_repos || "N/A"}`,
        `Followers: ${user.followers} | Following: ${user.following}`,
        `URL: ${user.html_url}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_list_repos",
  "List repositories for the authenticated user or a specific owner",
  {
    owner: z.string().optional().describe("Owner (user or org). Omit for authenticated user's repos"),
    type: z.enum(["all", "owner", "public", "private", "member"]).default("all").describe("Filter type"),
    sort: z.enum(["created", "updated", "pushed", "full_name"]).default("updated"),
    per_page: z.number().default(30).describe("Results per page (max 100)"),
  },
  async ({ owner, type, sort, per_page }) => {
    try {
      const endpoint = owner
        ? `/users/${owner}/repos?type=${type}&sort=${sort}&per_page=${per_page}`
        : `/user/repos?type=${type}&sort=${sort}&per_page=${per_page}`;
      const repos = await ghApi(endpoint);
      if (!repos.length) return { content: [{ type: "text", text: "No repositories found." }] };
      const text = repos.map(formatRepo).join("\n\n");
      return { content: [{ type: "text", text }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_get_repo",
  "Get detailed info about a repository",
  {
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
  },
  async ({ owner, repo }) => {
    try {
      const r = await ghApi(`/repos/${owner}/${repo}`);
      const lines = [
        formatRepo(r),
        `  node_id: ${r.node_id}`,
        `  open issues: ${r.open_issues_count}`,
        `  license: ${r.license?.spdx_id || "none"}`,
        `  topics: ${r.topics?.join(", ") || "none"}`,
        `  clone: ${r.clone_url}`,
      ];
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_create_repo",
  "Create a new repository",
  {
    name: z.string().describe("Repository name"),
    description: z.string().optional().describe("Repository description"),
    private: z.boolean().default(false).describe("Whether the repo is private"),
    auto_init: z.boolean().default(true).describe("Initialize with a README"),
    org: z.string().optional().describe("Organization name (omit for personal repo)"),
  },
  async (args) => {
    try {
      const endpoint = args.org ? `/orgs/${args.org}/repos` : "/user/repos";
      const r = await ghApi(endpoint, "POST", {
        name: args.name,
        description: args.description,
        private: args.private,
        auto_init: args.auto_init,
      });
      return { content: [{ type: "text", text: `Repository created: ${r.full_name}\nURL: ${r.html_url}\nClone: ${r.clone_url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_list_prs",
  "List pull requests for a repository",
  {
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).default("open"),
    per_page: z.number().default(30),
  },
  async ({ owner, repo, state, per_page }) => {
    try {
      const prs = await ghApi(`/repos/${owner}/${repo}/pulls?state=${state}&per_page=${per_page}`);
      if (!prs.length) return { content: [{ type: "text", text: `No ${state} pull requests found.` }] };
      const text = prs.map(formatPr).join("\n");
      return { content: [{ type: "text", text }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_create_pr",
  "Create a pull request",
  {
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string().optional().describe("PR description (markdown)"),
    head: z.string().describe("Source branch (e.g. 'feature/my-feature')"),
    base: z.string().default("main").describe("Target branch"),
    draft: z.boolean().default(false),
  },
  async ({ owner, repo, title, body, head, base, draft }) => {
    try {
      const pr = await ghApi(`/repos/${owner}/${repo}/pulls`, "POST", { title, body, head, base, draft });
      return { content: [{ type: "text", text: `PR created: ${formatPr(pr)}\nURL: ${pr.html_url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-github] Fatal: ${err}\n`);
  process.exit(1);
});
