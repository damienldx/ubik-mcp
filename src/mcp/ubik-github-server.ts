#!/usr/bin/env node
/**
 * UBIK GitHub — MCP Server (stdio transport)
 *
 * Leverages OAuth tokens stored by UBIK's connector system
 * to expose GitHub APIs as MCP tools.
 *
 * Tools (37):
 *   Repos:       github_list_repos, github_create_repo, github_get_repo
 *   Branches:    github_list_branches, github_create_branch
 *   Files:       github_get_file, github_create_or_update_file
 *   Commits:     github_list_commits
 *   Issues:      github_list_issues, github_create_issue, github_update_issue
 *   PRs:         github_list_prs, github_create_pr, github_merge_pr, github_review_pr
 *   Workflows:   github_list_workflows, github_list_workflow_runs, github_trigger_workflow
 *   User:        github_me
 *   Search:      github_search_code, github_search_issues
 *   Comments:    github_create_comment
 *   Projects v2: github_list_projects, github_get_project, github_create_project,
 *                github_list_project_items, github_add_project_item, github_add_project_draft_item,
 *                github_update_project_item_field, github_remove_project_item,
 *                github_update_project, github_create_project_field
 *   Discussions: github_list_discussion_categories, github_list_discussions,
 *                github_get_discussion, github_create_discussion, github_comment_discussion
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { config } from "dotenv";
import { join } from "node:path";
import { createMcpAuth, wrapTransportWithAuth } from "../lib/mcp-auth";

config({ path: join(process.cwd(), ".env") });

const auth = createMcpAuth("ubik-github");

// ─── Constants ───

const GH_API = "https://api.github.com";

// ─── Token helper ───

async function getToken(): Promise<string> {
  return auth.fetchToken("github", "github");
}

// ─── GitHub API helper ───

async function ghApi(endpoint: string, method = "GET", body?: any): Promise<any> {
  const token = await getToken();
  const res = await fetch(`${GH_API}${endpoint}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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

// ─── GitHub GraphQL helper ───

const GH_GRAPHQL = "https://api.github.com/graphql";

async function ghGraphQL(query: string, variables?: Record<string, any>): Promise<any> {
  const token = await getToken();
  const res = await fetch(GH_GRAPHQL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "User-Agent": "UBIK",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`GitHub GraphQL ${res.status}: ${err.substring(0, 500)}`);
  }
  const data = await res.json();
  if (data.errors?.length) {
    throw new Error(`GraphQL errors: ${data.errors.map((e: any) => e.message).join("; ")}`);
  }
  return data.data;
}

// ─── Helpers ───

function formatRepo(r: any): string {
  return [
    `${r.full_name}${r.private ? " (private)" : ""}${r.fork ? " (fork)" : ""}`,
    r.description ? `  ${r.description}` : null,
    `  ★ ${r.stargazers_count}  🍴 ${r.forks_count}  lang: ${r.language || "N/A"}`,
    `  default: ${r.default_branch}  updated: ${r.updated_at?.slice(0, 10)}`,
  ].filter(Boolean).join("\n");
}

function formatIssue(i: any): string {
  const labels = i.labels?.map((l: any) => l.name).join(", ") || "";
  return `#${i.number} [${i.state}] ${i.title}${labels ? ` (${labels})` : ""}${i.assignee ? ` → @${i.assignee.login}` : ""}`;
}

function formatPr(p: any): string {
  return `#${p.number} [${p.state}${p.draft ? "/draft" : ""}] ${p.title} (${p.head?.ref} → ${p.base?.ref})${p.user ? ` by @${p.user.login}` : ""}`;
}

// ─── MCP Server ───

const server = new McpServer({
  name: "ubik-github",
  version: "1.0.0",
});

// ═══════════════════════════════════════════════
//  User
// ═══════════════════════════════════════════════

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

// ═══════════════════════════════════════════════
//  Repos
// ═══════════════════════════════════════════════

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
      const endpoint = owner ? `/users/${owner}/repos?type=${type}&sort=${sort}&per_page=${per_page}` : `/user/repos?type=${type}&sort=${sort}&per_page=${per_page}`;
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

// ═══════════════════════════════════════════════
//  Branches
// ═══════════════════════════════════════════════

server.tool(
  "github_list_branches",
  "List branches of a repository",
  {
    owner: z.string(),
    repo: z.string(),
    per_page: z.number().default(30),
  },
  async ({ owner, repo, per_page }) => {
    try {
      const branches = await ghApi(`/repos/${owner}/${repo}/branches?per_page=${per_page}`);
      const lines = branches.map((b: any) => `${b.name}${b.protected ? " (protected)" : ""} — ${b.commit?.sha?.slice(0, 7)}`);
      return { content: [{ type: "text", text: lines.join("\n") || "No branches found." }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_create_branch",
  "Create a new branch from an existing ref",
  {
    owner: z.string(),
    repo: z.string(),
    branch: z.string().describe("New branch name"),
    from: z.string().default("main").describe("Source branch or SHA to branch from"),
  },
  async ({ owner, repo, branch, from }) => {
    try {
      // Get the SHA of the source
      const ref = await ghApi(`/repos/${owner}/${repo}/git/ref/heads/${from}`);
      const sha = ref.object.sha;
      // Create the new branch
      await ghApi(`/repos/${owner}/${repo}/git/refs`, "POST", {
        ref: `refs/heads/${branch}`,
        sha,
      });
      return { content: [{ type: "text", text: `Branch '${branch}' created from '${from}' (${sha.slice(0, 7)})` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════
//  Files
// ═══════════════════════════════════════════════

server.tool(
  "github_get_file",
  "Get the content of a file from a repository",
  {
    owner: z.string(),
    repo: z.string(),
    path: z.string().describe("File path (e.g. 'src/index.ts')"),
    ref: z.string().optional().describe("Branch, tag, or commit SHA (default: repo default branch)"),
  },
  async ({ owner, repo, path, ref }) => {
    try {
      const endpoint = `/repos/${owner}/${repo}/contents/${path}${ref ? `?ref=${ref}` : ""}`;
      const file = await ghApi(endpoint);
      if (file.type !== "file") {
        // It's a directory — list contents
        if (Array.isArray(file)) {
          const entries = file.map((f: any) => `${f.type === "dir" ? "📁" : "📄"} ${f.name}`);
          return { content: [{ type: "text", text: `Directory: ${path}\n\n${entries.join("\n")}` }] };
        }
        return { content: [{ type: "text", text: `Not a file: ${path} (type: ${file.type})` }] };
      }
      const content = Buffer.from(file.content, "base64").toString("utf-8");
      return { content: [{ type: "text", text: `File: ${path} (${file.size} bytes, SHA: ${file.sha})\n\n${content}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_create_or_update_file",
  "Create or update a file in a repository (creates a commit)",
  {
    owner: z.string(),
    repo: z.string(),
    path: z.string().describe("File path"),
    content: z.string().describe("File content (plain text, will be base64 encoded)"),
    message: z.string().describe("Commit message"),
    branch: z.string().optional().describe("Branch (default: repo default branch)"),
    sha: z.string().optional().describe("SHA of the file being replaced (required for updates, omit for creation)"),
  },
  async ({ owner, repo, path, content, message, branch, sha }) => {
    try {
      const encoded = Buffer.from(content, "utf-8").toString("base64");
      const body: any = { message, content: encoded };
      if (branch) body.branch = branch;
      if (sha) body.sha = sha;

      const result = await ghApi(`/repos/${owner}/${repo}/contents/${path}`, "PUT", body);
      const action = sha ? "Updated" : "Created";
      return { content: [{ type: "text", text: `${action}: ${path}\nCommit: ${result.commit?.sha?.slice(0, 7)} — ${message}\nURL: ${result.content?.html_url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════
//  Commits
// ═══════════════════════════════════════════════

server.tool(
  "github_list_commits",
  "List recent commits on a repository branch",
  {
    owner: z.string(),
    repo: z.string(),
    sha: z.string().optional().describe("Branch name or commit SHA (default: default branch)"),
    per_page: z.number().default(20),
  },
  async ({ owner, repo, sha, per_page }) => {
    try {
      const endpoint = `/repos/${owner}/${repo}/commits?per_page=${per_page}${sha ? `&sha=${sha}` : ""}`;
      const commits = await ghApi(endpoint);
      const lines = commits.map((c: any) =>
        `${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0]} — @${c.author?.login || c.commit.author?.name} (${c.commit.author?.date?.slice(0, 10)})`
      );
      return { content: [{ type: "text", text: lines.join("\n") || "No commits found." }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════
//  Issues
// ═══════════════════════════════════════════════

server.tool(
  "github_list_issues",
  "List issues for a repository",
  {
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).default("open"),
    labels: z.string().optional().describe("Comma-separated label names"),
    per_page: z.number().default(30),
  },
  async ({ owner, repo, state, labels, per_page }) => {
    try {
      let endpoint = `/repos/${owner}/${repo}/issues?state=${state}&per_page=${per_page}`;
      if (labels) endpoint += `&labels=${labels}`;
      const issues = await ghApi(endpoint);
      // Filter out PRs (GitHub API returns PRs in issues endpoint)
      const filtered = issues.filter((i: any) => !i.pull_request);
      if (!filtered.length) return { content: [{ type: "text", text: `No ${state} issues found.` }] };
      const text = filtered.map(formatIssue).join("\n");
      return { content: [{ type: "text", text }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_create_issue",
  "Create a new issue in a repository",
  {
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string().optional().describe("Issue body (markdown)"),
    labels: z.array(z.string()).optional().describe("Label names"),
    assignees: z.array(z.string()).optional().describe("Assignee logins"),
  },
  async ({ owner, repo, title, body, labels, assignees }) => {
    try {
      const issue = await ghApi(`/repos/${owner}/${repo}/issues`, "POST", { title, body, labels, assignees });
      return { content: [{ type: "text", text: `Issue created: #${issue.number} ${issue.title}\nURL: ${issue.html_url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_update_issue",
  "Update an existing issue (close, reopen, change labels, assign, etc.)",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number(),
    title: z.string().optional(),
    body: z.string().optional(),
    state: z.enum(["open", "closed"]).optional(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
  },
  async ({ owner, repo, issue_number, ...updates }) => {
    try {
      const clean = Object.fromEntries(Object.entries(updates).filter(([, v]) => v !== undefined));
      const issue = await ghApi(`/repos/${owner}/${repo}/issues/${issue_number}`, "PATCH", clean);
      return { content: [{ type: "text", text: `Issue updated: ${formatIssue(issue)}\nURL: ${issue.html_url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════
//  Pull Requests
// ═══════════════════════════════════════════════

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

server.tool(
  "github_merge_pr",
  "Merge a pull request",
  {
    owner: z.string(),
    repo: z.string(),
    pull_number: z.number(),
    merge_method: z.enum(["merge", "squash", "rebase"]).default("squash"),
    commit_title: z.string().optional(),
    commit_message: z.string().optional(),
  },
  async ({ owner, repo, pull_number, merge_method, commit_title, commit_message }) => {
    try {
      const result = await ghApi(`/repos/${owner}/${repo}/pulls/${pull_number}/merge`, "PUT", {
        merge_method,
        commit_title,
        commit_message,
      });
      return { content: [{ type: "text", text: `PR #${pull_number} merged (${merge_method})\nSHA: ${result.sha?.slice(0, 7)}\nMessage: ${result.message}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_review_pr",
  "Submit a review on a pull request (approve, request changes, or comment)",
  {
    owner: z.string(),
    repo: z.string(),
    pull_number: z.number(),
    event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).describe("Review action"),
    body: z.string().describe("Review body/comment"),
  },
  async ({ owner, repo, pull_number, event, body }) => {
    try {
      const review = await ghApi(`/repos/${owner}/${repo}/pulls/${pull_number}/reviews`, "POST", { event, body });
      return { content: [{ type: "text", text: `Review submitted on PR #${pull_number}: ${event}\nURL: ${review.html_url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════
//  Workflows (GitHub Actions)
// ═══════════════════════════════════════════════

server.tool(
  "github_list_workflows",
  "List GitHub Actions workflows for a repository",
  {
    owner: z.string(),
    repo: z.string(),
  },
  async ({ owner, repo }) => {
    try {
      const data = await ghApi(`/repos/${owner}/${repo}/actions/workflows`);
      const lines = data.workflows.map((w: any) =>
        `${w.name} (${w.state}) — ${w.path}`
      );
      return { content: [{ type: "text", text: lines.join("\n") || "No workflows found." }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_list_workflow_runs",
  "List recent workflow runs for a repository",
  {
    owner: z.string(),
    repo: z.string(),
    workflow_id: z.string().optional().describe("Workflow ID or filename (e.g. 'ci.yml')"),
    status: z.enum(["completed", "action_required", "cancelled", "failure", "neutral", "skipped", "stale", "success", "timed_out", "in_progress", "queued", "requested", "waiting", "pending"]).optional(),
    per_page: z.number().default(10),
  },
  async ({ owner, repo, workflow_id, status, per_page }) => {
    try {
      let endpoint = workflow_id
        ? `/repos/${owner}/${repo}/actions/workflows/${workflow_id}/runs?per_page=${per_page}`
        : `/repos/${owner}/${repo}/actions/runs?per_page=${per_page}`;
      if (status) endpoint += `&status=${status}`;
      const data = await ghApi(endpoint);
      const lines = data.workflow_runs.map((r: any) =>
        `#${r.run_number} ${r.name} [${r.status}/${r.conclusion || "—"}] ${r.head_branch} — ${r.created_at?.slice(0, 16)} ${r.html_url}`
      );
      return { content: [{ type: "text", text: `${data.total_count} total runs\n\n${lines.join("\n")}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_trigger_workflow",
  "Trigger a GitHub Actions workflow dispatch",
  {
    owner: z.string(),
    repo: z.string(),
    workflow_id: z.string().describe("Workflow ID or filename (e.g. 'deploy.yml')"),
    ref: z.string().default("main").describe("Branch or tag to run on"),
    inputs: z.record(z.string()).optional().describe("Workflow input parameters"),
  },
  async ({ owner, repo, workflow_id, ref, inputs }) => {
    try {
      await ghApi(`/repos/${owner}/${repo}/actions/workflows/${workflow_id}/dispatches`, "POST", { ref, inputs });
      return { content: [{ type: "text", text: `Workflow '${workflow_id}' triggered on ${ref}${inputs ? ` with inputs: ${JSON.stringify(inputs)}` : ""}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════
//  Search
// ═══════════════════════════════════════════════

server.tool(
  "github_search_code",
  "Search for code across GitHub repositories",
  {
    query: z.string().describe("Search query (e.g. 'className repo:owner/repo language:typescript')"),
    per_page: z.number().default(20),
  },
  async ({ query, per_page }) => {
    try {
      const data = await ghApi(`/search/code?q=${encodeURIComponent(query)}&per_page=${per_page}`);
      const lines = data.items.map((item: any) =>
        `${item.repository.full_name}/${item.path} (score: ${item.score?.toFixed(1)})`
      );
      return { content: [{ type: "text", text: `${data.total_count} results\n\n${lines.join("\n")}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_search_issues",
  "Search issues and pull requests across GitHub",
  {
    query: z.string().describe("Search query (e.g. 'bug label:bug repo:owner/repo is:open')"),
    per_page: z.number().default(20),
  },
  async ({ query, per_page }) => {
    try {
      const data = await ghApi(`/search/issues?q=${encodeURIComponent(query)}&per_page=${per_page}`);
      const lines = data.items.map((item: any) => {
        const isPr = !!item.pull_request;
        return `${item.repository_url?.split("/").slice(-2).join("/")} ${isPr ? "PR" : "Issue"} #${item.number} [${item.state}] ${item.title}`;
      });
      return { content: [{ type: "text", text: `${data.total_count} results\n\n${lines.join("\n")}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════
//  Projects v2 (GraphQL)
// ═══════════════════════════════════════════════

server.tool(
  "github_list_projects",
  "List GitHub Projects v2 for a user or organization. Returns project IDs needed for other project tools.",
  {
    owner: z.string().describe("GitHub user or organization login"),
    owner_type: z.enum(["user", "organization"]).default("user"),
    first: z.number().default(20).describe("Number of projects to return (max 100)"),
  },
  async ({ owner, owner_type, first }) => {
    try {
      const ownerField = owner_type === "organization" ? "organization" : "user";
      const data = await ghGraphQL(`
        query($owner: String!, $first: Int!) {
          ${ownerField}(login: $owner) {
            projectsV2(first: $first, orderBy: {field: UPDATED_AT, direction: DESC}) {
              nodes { id number title shortDescription closed url updatedAt }
            }
          }
        }
      `, { owner, first });
      const projects = data[ownerField]?.projectsV2?.nodes || [];
      if (!projects.length) return { content: [{ type: "text", text: "No projects found." }] };
      const lines = projects.map((p: any) =>
        `#${p.number} ${p.closed ? "[CLOSED] " : ""}${p.title}\n  ID: ${p.id}\n  ${p.shortDescription || "No description"}\n  ${p.url}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_get_project",
  "Get detailed info about a GitHub Project v2 including all fields (Status, Priority, custom fields). Use this to get field IDs for update_project_item_field.",
  {
    owner: z.string().describe("GitHub user or organization login"),
    project_number: z.number().describe("Project number (visible in URL)"),
    owner_type: z.enum(["user", "organization"]).default("user"),
  },
  async ({ owner, project_number, owner_type }) => {
    try {
      const ownerField = owner_type === "organization" ? "organization" : "user";
      const data = await ghGraphQL(`
        query($owner: String!, $number: Int!) {
          ${ownerField}(login: $owner) {
            projectV2(number: $number) {
              id number title shortDescription closed url
              fields(first: 50) {
                nodes {
                  ... on ProjectV2Field { id name dataType }
                  ... on ProjectV2SingleSelectField { id name dataType options { id name description color } }
                  ... on ProjectV2IterationField { id name dataType configuration { iterations { id title startDate duration } } }
                }
              }
            }
          }
        }
      `, { owner, number: project_number });
      const p = data[ownerField]?.projectV2;
      if (!p) return { content: [{ type: "text", text: "Project not found." }], isError: true };
      const header = `#${p.number} ${p.closed ? "[CLOSED] " : ""}${p.title}\nID: ${p.id}\n${p.shortDescription || ""}\n${p.url}`;
      const fields = p.fields?.nodes?.map((f: any) => {
        let line = `  ${f.name} (${f.dataType}) — ID: ${f.id}`;
        if (f.options) line += `\n    Options: ${f.options.map((o: any) => `${o.name} [${o.id}]`).join(", ")}`;
        if (f.configuration?.iterations) line += `\n    Iterations: ${f.configuration.iterations.map((i: any) => `${i.title} [${i.id}]`).join(", ")}`;
        return line;
      }) || [];
      return { content: [{ type: "text", text: `${header}\n\nFields:\n${fields.join("\n")}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_create_project",
  "Create a new GitHub Project v2. Requires the owner's node ID (get it from github_me or GitHub API).",
  {
    owner_id: z.string().describe("Node ID of the user or organization (e.g. from github_me)"),
    title: z.string().describe("Project title"),
  },
  async ({ owner_id, title }) => {
    try {
      const data = await ghGraphQL(`
        mutation($ownerId: ID!, $title: String!) {
          createProjectV2(input: { ownerId: $ownerId, title: $title }) {
            projectV2 { id number title url }
          }
        }
      `, { ownerId: owner_id, title });
      const p = data.createProjectV2.projectV2;
      return { content: [{ type: "text", text: `Project created: #${p.number} ${p.title}\nID: ${p.id}\nURL: ${p.url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_list_project_items",
  "List items in a GitHub Project v2 board with their field values (status, priority, etc.)",
  {
    project_id: z.string().describe("Project node ID (from github_list_projects or github_get_project)"),
    first: z.number().default(50).describe("Number of items (max 100)"),
    after: z.string().optional().describe("Cursor for pagination"),
  },
  async ({ project_id, first, after }) => {
    try {
      const data = await ghGraphQL(`
        query($projectId: ID!, $first: Int!, $after: String) {
          node(id: $projectId) {
            ... on ProjectV2 {
              items(first: $first, after: $after) {
                pageInfo { hasNextPage endCursor }
                nodes {
                  id
                  content {
                    ... on Issue { number title state repository { nameWithOwner } }
                    ... on PullRequest { number title state repository { nameWithOwner } }
                    ... on DraftIssue { title body }
                  }
                  fieldValues(first: 20) {
                    nodes {
                      ... on ProjectV2ItemFieldTextValue { text field { ... on ProjectV2Field { name } } }
                      ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2SingleSelectField { name } } }
                      ... on ProjectV2ItemFieldDateValue { date field { ... on ProjectV2Field { name } } }
                      ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2Field { name } } }
                      ... on ProjectV2ItemFieldIterationValue { title field { ... on ProjectV2IterationField { name } } }
                    }
                  }
                }
              }
            }
          }
        }
      `, { projectId: project_id, first, after });
      const items = data.node?.items;
      if (!items?.nodes?.length) return { content: [{ type: "text", text: "No items in project." }] };
      const lines = items.nodes.map((item: any) => {
        const c = item.content || {};
        const contentLine = c.number
          ? `${c.repository?.nameWithOwner || ""}#${c.number} [${c.state}] ${c.title}`
          : `[Draft] ${c.title || "Untitled"}`;
        const fields = item.fieldValues?.nodes
          ?.filter((f: any) => f.field?.name)
          ?.map((f: any) => `${f.field.name}: ${f.name || f.text || f.date || f.number || f.title || "—"}`)
          ?.join(" | ") || "";
        return `${contentLine}\n  Item ID: ${item.id}${fields ? `\n  ${fields}` : ""}`;
      });
      const pagination = items.pageInfo?.hasNextPage ? `\n\n[Next page cursor: ${items.pageInfo.endCursor}]` : "";
      return { content: [{ type: "text", text: lines.join("\n\n") + pagination }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_add_project_item",
  "Add an existing issue or PR to a GitHub Project v2 board",
  {
    project_id: z.string().describe("Project node ID"),
    content_id: z.string().describe("Node ID of the issue or pull request to add"),
  },
  async ({ project_id, content_id }) => {
    try {
      const data = await ghGraphQL(`
        mutation($projectId: ID!, $contentId: ID!) {
          addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) {
            item { id }
          }
        }
      `, { projectId: project_id, contentId: content_id });
      return { content: [{ type: "text", text: `Item added to project.\nItem ID: ${data.addProjectV2ItemById.item.id}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_add_project_draft_item",
  "Add a draft item (no backing issue/PR) to a GitHub Project v2. Perfect for non-code tasks like research, design, content writing.",
  {
    project_id: z.string().describe("Project node ID"),
    title: z.string().describe("Draft item title"),
    body: z.string().optional().describe("Draft item body (markdown)"),
  },
  async ({ project_id, title, body }) => {
    try {
      const data = await ghGraphQL(`
        mutation($projectId: ID!, $title: String!, $body: String) {
          addProjectV2DraftIssue(input: { projectId: $projectId, title: $title, body: $body }) {
            projectItem { id }
          }
        }
      `, { projectId: project_id, title, body });
      return { content: [{ type: "text", text: `Draft item created: "${title}"\nItem ID: ${data.addProjectV2DraftIssue.projectItem.id}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_update_project_item_field",
  "Update a field value on a project item (e.g. move Status to 'Done', set Priority). Get field IDs from github_get_project.",
  {
    project_id: z.string().describe("Project node ID"),
    item_id: z.string().describe("Item node ID (from github_list_project_items)"),
    field_id: z.string().describe("Field node ID (from github_get_project)"),
    value: z.object({
      text: z.string().optional(),
      number: z.number().optional(),
      date: z.string().optional().describe("ISO date string"),
      singleSelectOptionId: z.string().optional().describe("Option ID for single-select fields like Status"),
      iterationId: z.string().optional().describe("Iteration ID for iteration fields"),
    }).describe("Value to set — use exactly ONE of the sub-fields matching the field type"),
  },
  async ({ project_id, item_id, field_id, value }) => {
    try {
      const data = await ghGraphQL(`
        mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $value: ProjectV2FieldValue!) {
          updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: $value }) {
            projectV2Item { id }
          }
        }
      `, { projectId: project_id, itemId: item_id, fieldId: field_id, value });
      return { content: [{ type: "text", text: `Field updated on item ${item_id}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_remove_project_item",
  "Remove an item from a GitHub Project v2 board",
  {
    project_id: z.string().describe("Project node ID"),
    item_id: z.string().describe("Item node ID to remove"),
  },
  async ({ project_id, item_id }) => {
    try {
      await ghGraphQL(`
        mutation($projectId: ID!, $itemId: ID!) {
          deleteProjectV2Item(input: { projectId: $projectId, itemId: $itemId }) {
            deletedItemId
          }
        }
      `, { projectId: project_id, itemId: item_id });
      return { content: [{ type: "text", text: `Item ${item_id} removed from project.` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_update_project",
  "Update a GitHub Project v2 (title, description, open/close)",
  {
    project_id: z.string().describe("Project node ID"),
    title: z.string().optional().describe("New title"),
    short_description: z.string().optional().describe("New description"),
    closed: z.boolean().optional().describe("Set to true to close, false to reopen"),
  },
  async ({ project_id, title, short_description, closed }) => {
    try {
      const input: any = { projectId: project_id };
      if (title !== undefined) input.title = title;
      if (short_description !== undefined) input.shortDescription = short_description;
      if (closed !== undefined) input.closed = closed;
      const data = await ghGraphQL(`
        mutation($input: UpdateProjectV2Input!) {
          updateProjectV2(input: $input) {
            projectV2 { id number title closed url }
          }
        }
      `, { input });
      const p = data.updateProjectV2.projectV2;
      return { content: [{ type: "text", text: `Project updated: #${p.number} ${p.title}${p.closed ? " [CLOSED]" : ""}\n${p.url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_create_project_field",
  "Add a custom field to a GitHub Project v2 (text, number, date, single-select, iteration)",
  {
    project_id: z.string().describe("Project node ID"),
    name: z.string().describe("Field name"),
    data_type: z.enum(["TEXT", "NUMBER", "DATE", "SINGLE_SELECT", "ITERATION"]).describe("Field type"),
    single_select_options: z.array(z.object({
      name: z.string(),
      description: z.string().optional(),
      color: z.enum(["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PINK", "PURPLE"]).optional(),
    })).optional().describe("Options for SINGLE_SELECT fields"),
  },
  async ({ project_id, name, data_type, single_select_options }) => {
    try {
      const input: any = { projectId: project_id, name, dataType: data_type };
      if (single_select_options) input.singleSelectOptions = single_select_options;
      const data = await ghGraphQL(`
        mutation($input: CreateProjectV2FieldInput!) {
          createProjectV2Field(input: $input) {
            projectV2Field {
              ... on ProjectV2Field { id name }
              ... on ProjectV2SingleSelectField { id name options { id name } }
            }
          }
        }
      `, { input });
      const f = data.createProjectV2Field.projectV2Field;
      let text = `Field created: ${f.name} (ID: ${f.id})`;
      if (f.options) text += `\nOptions: ${f.options.map((o: any) => `${o.name} [${o.id}]`).join(", ")}`;
      return { content: [{ type: "text", text }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════
//  Discussions (GraphQL)
// ═══════════════════════════════════════════════

server.tool(
  "github_list_discussion_categories",
  "List discussion categories for a repository (needed to create discussions)",
  {
    owner: z.string(),
    repo: z.string(),
  },
  async ({ owner, repo }) => {
    try {
      const data = await ghGraphQL(`
        query($owner: String!, $repo: String!) {
          repository(owner: $owner, name: $repo) {
            discussionCategories(first: 25) {
              nodes { id name description emoji }
            }
          }
        }
      `, { owner, repo });
      const cats = data.repository?.discussionCategories?.nodes || [];
      if (!cats.length) return { content: [{ type: "text", text: "No discussion categories found. Discussions may not be enabled on this repo." }] };
      const lines = cats.map((c: any) => `${c.emoji || "💬"} ${c.name} — ID: ${c.id}${c.description ? `\n  ${c.description}` : ""}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_list_discussions",
  "List discussions in a repository",
  {
    owner: z.string(),
    repo: z.string(),
    first: z.number().default(20),
    category_id: z.string().optional().describe("Filter by category node ID"),
  },
  async ({ owner, repo, first, category_id }) => {
    try {
      const catFilter = category_id ? `, categoryId: "${category_id}"` : "";
      const data = await ghGraphQL(`
        query($owner: String!, $repo: String!, $first: Int!) {
          repository(owner: $owner, name: $repo) {
            discussions(first: $first, orderBy: {field: UPDATED_AT, direction: DESC}${catFilter}) {
              nodes {
                id number title
                author { login }
                category { name }
                createdAt
                answerChosenAt
                comments { totalCount }
              }
            }
          }
        }
      `, { owner, repo, first });
      const discussions = data.repository?.discussions?.nodes || [];
      if (!discussions.length) return { content: [{ type: "text", text: "No discussions found." }] };
      const lines = discussions.map((d: any) =>
        `#${d.number} [${d.category?.name}] ${d.title}${d.answerChosenAt ? " ✅" : ""}\n  by @${d.author?.login} — ${d.createdAt?.slice(0, 10)} — ${d.comments?.totalCount || 0} comments\n  ID: ${d.id}`
      );
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_get_discussion",
  "Get a discussion with its comments",
  {
    owner: z.string(),
    repo: z.string(),
    discussion_number: z.number(),
  },
  async ({ owner, repo, discussion_number }) => {
    try {
      const data = await ghGraphQL(`
        query($owner: String!, $repo: String!, $number: Int!) {
          repository(owner: $owner, name: $repo) {
            discussion(number: $number) {
              id number title body
              author { login }
              category { name }
              createdAt
              answerChosenAt
              comments(first: 30) {
                nodes {
                  body
                  author { login }
                  createdAt
                  isAnswer
                }
              }
            }
          }
        }
      `, { owner, repo, number: discussion_number });
      const d = data.repository?.discussion;
      if (!d) return { content: [{ type: "text", text: "Discussion not found." }], isError: true };
      const header = `#${d.number} [${d.category?.name}] ${d.title}\nby @${d.author?.login} — ${d.createdAt?.slice(0, 10)}\nID: ${d.id}\n`;
      const body = d.body ? `\n${d.body}\n` : "";
      const comments = d.comments?.nodes?.map((c: any) =>
        `${c.isAnswer ? "✅ " : ""}@${c.author?.login} (${c.createdAt?.slice(0, 10)}):\n${c.body}`
      )?.join("\n---\n") || "No comments.";
      return { content: [{ type: "text", text: `${header}${body}\n--- Comments ---\n${comments}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_create_discussion",
  "Create a new discussion in a repository. Requires repo node_id (from github_get_repo) and category_id (from github_list_discussion_categories).",
  {
    repo_id: z.string().describe("Repository node ID (from github_get_repo)"),
    category_id: z.string().describe("Discussion category node ID"),
    title: z.string(),
    body: z.string().describe("Discussion body (markdown)"),
  },
  async ({ repo_id, category_id, title, body }) => {
    try {
      const data = await ghGraphQL(`
        mutation($repoId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
          createDiscussion(input: { repositoryId: $repoId, categoryId: $categoryId, title: $title, body: $body }) {
            discussion { id number url }
          }
        }
      `, { repoId: repo_id, categoryId: category_id, title, body });
      const d = data.createDiscussion.discussion;
      return { content: [{ type: "text", text: `Discussion created: #${d.number}\nURL: ${d.url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_comment_discussion",
  "Add a comment to a discussion",
  {
    discussion_id: z.string().describe("Discussion node ID (from github_list_discussions or github_get_discussion)"),
    body: z.string().describe("Comment body (markdown)"),
  },
  async ({ discussion_id, body }) => {
    try {
      const data = await ghGraphQL(`
        mutation($discussionId: ID!, $body: String!) {
          addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
            comment { id url }
          }
        }
      `, { discussionId: discussion_id, body });
      return { content: [{ type: "text", text: `Comment added.\nURL: ${data.addDiscussionComment.comment.url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ═══════════════════════════════════════════════
//  Comments (issues + PRs)
// ═══════════════════════════════════════════════

server.tool(
  "github_create_comment",
  "Add a comment to an issue or pull request",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number().describe("Issue or PR number"),
    body: z.string().describe("Comment body (markdown)"),
  },
  async ({ owner, repo, issue_number, body }) => {
    try {
      const comment = await ghApi(`/repos/${owner}/${repo}/issues/${issue_number}/comments`, "POST", { body });
      return { content: [{ type: "text", text: `Comment added to #${issue_number}\nURL: ${comment.html_url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── Start ───

async function main() {
  

// ═══════════════════════════════════════════════
//  Missing Read Tools for Inter-Agent Coordination
// ═══════════════════════════════════════════════

server.tool(
  "github_get_issue",
  "Get detailed info about a repository issue",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number()
  },
  async ({ owner, repo, issue_number }) => {
    const token = await getToken();
    const url = `${GH_API}/repos/${owner}/${repo}/issues/${issue_number}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "ubik-mcp"
      }
    });

    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `GitHub API error: ${res.status} ${res.statusText}` }]
      };
    }

    const data = await res.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    };
  }
);

server.tool(
  "github_list_issue_comments",
  "List all comments for a specific issue",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number(),
    per_page: z.number().default(30)
  },
  async ({ owner, repo, issue_number, per_page }) => {
    const token = await getToken();
    const url = new URL(`${GH_API}/repos/${owner}/${repo}/issues/${issue_number}/comments`);
    url.searchParams.append("per_page", per_page.toString());

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "ubik-mcp"
      }
    });

    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `GitHub API error: ${res.status} ${res.statusText}` }]
      };
    }

    const data = await res.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    };
  }
);

server.tool(
  "github_get_pr",
  "Get detailed info about a pull request",
  {
    owner: z.string(),
    repo: z.string(),
    pull_number: z.number()
  },
  async ({ owner, repo, pull_number }) => {
    const token = await getToken();
    const url = `${GH_API}/repos/${owner}/${repo}/pulls/${pull_number}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "ubik-mcp"
      }
    });

    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `GitHub API error: ${res.status} ${res.statusText}` }]
      };
    }

    const data = await res.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    };
  }
);

server.tool(
  "github_get_pr_diff",
  "Get the diff of a pull request",
  {
    owner: z.string(),
    repo: z.string(),
    pull_number: z.number()
  },
  async ({ owner, repo, pull_number }) => {
    const token = await getToken();
    const url = `${GH_API}/repos/${owner}/${repo}/pulls/${pull_number}`;

    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3.diff",
        "User-Agent": "ubik-mcp"
      }
    });

    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `GitHub API error: ${res.status} ${res.statusText}` }]
      };
    }

    const data = await res.text();
    return {
      content: [{ type: "text", text: data }]
    };
  }
);

server.tool(
  "github_list_pr_files",
  "List files changed in a pull request",
  {
    owner: z.string(),
    repo: z.string(),
    pull_number: z.number(),
    per_page: z.number().default(30)
  },
  async ({ owner, repo, pull_number, per_page }) => {
    const token = await getToken();
    const url = new URL(`${GH_API}/repos/${owner}/${repo}/pulls/${pull_number}/files`);
    url.searchParams.append("per_page", per_page.toString());

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "ubik-mcp"
      }
    });

    if (!res.ok) {
      return {
        isError: true,
        content: [{ type: "text", text: `GitHub API error: ${res.status} ${res.statusText}` }]
      };
    }

    const data = await res.json();
    return {
      content: [{ type: "text", text: JSON.stringify(data, null, 2) }]
    };
  }
);


const transport = new StdioServerTransport();
  await server.connect(transport);
  wrapTransportWithAuth(transport, auth);

  console.error("[ubik-github] MCP server started (37 tools)");
}

main().catch((err) => {
  console.error("[ubik-github] Fatal:", err);
  process.exit(1);
});
