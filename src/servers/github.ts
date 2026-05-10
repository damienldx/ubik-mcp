#!/usr/bin/env node
/**
 * UBIK GitHub — standalone MCP stdio server.
 *
 * Tools (20):
 *   Profile + repos
 *     - github_get_me              Profile of the authenticated user.
 *     - github_list_repos          Repos for a user, an org, or the authenticated user.
 *     - github_get_repo            Full details for one repository.
 *     - github_create_repo         Create a repository (user or org owned).
 *   Pull requests
 *     - github_list_prs            List pull requests (state-filtered).
 *     - github_create_pr           Open a pull request.
 *     - github_merge_pull_request  Merge a PR (merge / squash / rebase).
 *   Issues
 *     - github_list_issues         List issues (state, labels, assignee).
 *     - github_create_issue        Create an issue.
 *     - github_update_issue        Update an issue (state, title, body, labels, assignees).
 *   Actions / workflows
 *     - github_list_workflows      List Actions workflows.
 *     - github_trigger_workflow    Dispatch a workflow on a ref with inputs.
 *     - github_list_workflow_runs  List recent runs (status filter).
 *   Releases
 *     - github_list_releases       List releases.
 *     - github_create_release      Create a release (tag, notes, draft, pre-release).
 *   Search & discovery
 *     - github_search_repos        Search repositories.
 *     - github_search_code         Search code.
 *     - github_list_commits        List commits (branch / since / page).
 *   Comments
 *     - github_list_comments       List comments on an issue or PR.
 *     - github_add_comment         Add a comment on an issue or PR.
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
  "github_get_me",
  "Returns the profile of the authenticated GitHub user (login, name, email, repo counts).",
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
  "Lists repositories for the authenticated user or for a specific owner (user or org).",
  {
    owner: z.string().optional().describe("GitHub username or org login (omit for the authenticated user's repos)."),
    type: z.enum(["all", "owner", "public", "private", "member"]).default("all").describe("Repo membership filter."),
    sort: z.enum(["created", "updated", "pushed", "full_name"]).default("updated").describe("Sort order."),
    per_page: z.number().int().min(1).max(100).default(30).describe("Results per page (max 100)."),
  },
  async ({ owner, type, sort, per_page }) => {
    try {
      const endpoint = owner
        ? `/users/${encodeURIComponent(owner)}/repos?type=${type}&sort=${sort}&per_page=${per_page}`
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
  "Returns full details for one repository (description, stars, forks, license, topics, clone URL).",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name (without owner)."),
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
  "Creates a new repository under the authenticated user or under a given organisation.",
  {
    name: z.string().describe("New repository name (must be unique within the owner)."),
    description: z.string().optional().describe("Short repo description shown on its page."),
    private: z.boolean().default(false).describe("Create as private (default: false)."),
    auto_init: z.boolean().default(true).describe("Initialise the repo with a README (default: true)."),
    org: z.string().optional().describe("Organisation login (omit to create under the authenticated user)."),
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
  "Lists pull requests for a repository, filtered by state (open, closed, all).",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
    state: z.enum(["open", "closed", "all"]).default("open").describe("PR state filter."),
    per_page: z.number().int().min(1).max(100).default(30).describe("Results per page (max 100)."),
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
  "Creates a pull request from a head branch into a base branch on the given repository.",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
    title: z.string().describe("PR title (one line, shown in lists and notifications)."),
    body: z.string().optional().describe("PR description in GitHub-flavoured markdown."),
    head: z.string().describe("Source branch (e.g. 'feature/my-feature' or 'fork-owner:branch')."),
    base: z.string().default("main").describe("Target branch in the repo (default: main)."),
    draft: z.boolean().default(false).describe("Open the PR as draft (default: false)."),
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

// ─── Issues ──────────────────────────────────────────────────────────────────

function formatIssue(i: any): string {
  return `#${i.number} [${i.state}] ${i.title}${i.user ? ` by @${i.user.login}` : ""}${i.labels?.length ? ` [${i.labels.map((l: any) => l.name).join(",")}]` : ""}`;
}

server.tool(
  "github_list_issues",
  "Lists issues for a repository, filtered by state, labels and assignee. Note: GitHub returns PRs in this endpoint too — filter by `pull_request` field if you want issues only.",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
    state: z.enum(["open", "closed", "all"]).default("open").describe("Issue state filter."),
    labels: z.string().optional().describe("Comma-separated list of label names to filter on."),
    assignee: z.string().optional().describe("Filter by assignee login, '*' for any, 'none' for unassigned."),
    per_page: z.number().int().min(1).max(100).default(30).describe("Results per page (max 100)."),
  },
  async ({ owner, repo, state, labels, assignee, per_page }) => {
    try {
      const params = new URLSearchParams({ state, per_page: String(per_page) });
      if (labels) params.set("labels", labels);
      if (assignee) params.set("assignee", assignee);
      const issues = await ghApi(`/repos/${owner}/${repo}/issues?${params.toString()}`);
      if (!issues.length) return { content: [{ type: "text", text: `No ${state} issues found.` }] };
      return { content: [{ type: "text", text: issues.map(formatIssue).join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_create_issue",
  "Creates an issue on the given repository.",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
    title: z.string().describe("Issue title (one line)."),
    body: z.string().optional().describe("Issue body in GitHub-flavoured markdown."),
    labels: z.array(z.string()).optional().describe("Label names to attach (must already exist)."),
    assignees: z.array(z.string()).optional().describe("Logins to assign to the issue."),
  },
  async ({ owner, repo, title, body, labels, assignees }) => {
    try {
      const issue = await ghApi(`/repos/${owner}/${repo}/issues`, "POST", { title, body, labels, assignees });
      return { content: [{ type: "text", text: `Issue created: ${formatIssue(issue)}\nURL: ${issue.html_url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_update_issue",
  "Updates an existing issue (state, title, body, labels, assignees).",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
    number: z.number().int().positive().describe("Issue number."),
    state: z.enum(["open", "closed"]).optional().describe("New state."),
    title: z.string().optional().describe("New title."),
    body: z.string().optional().describe("New body (markdown)."),
    labels: z.array(z.string()).optional().describe("Replace labels with this list."),
    assignees: z.array(z.string()).optional().describe("Replace assignees with this list."),
  },
  async ({ owner, repo, number, ...patch }) => {
    try {
      const issue = await ghApi(`/repos/${owner}/${repo}/issues/${number}`, "PATCH", patch);
      return { content: [{ type: "text", text: `Issue updated: ${formatIssue(issue)}\nURL: ${issue.html_url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── Pull request merge ──────────────────────────────────────────────────────

server.tool(
  "github_merge_pull_request",
  "Merges a pull request via the GitHub API. Returns 405 if the PR is not mergeable (conflict, required checks pending, etc.).",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
    number: z.number().int().positive().describe("Pull request number."),
    commit_title: z.string().optional().describe("Title for the merge commit (defaults to GitHub's auto-title)."),
    commit_message: z.string().optional().describe("Body for the merge commit."),
    merge_method: z.enum(["merge", "squash", "rebase"]).default("merge").describe("Merge strategy."),
  },
  async ({ owner, repo, number, ...body }) => {
    try {
      const r = await ghApi(`/repos/${owner}/${repo}/pulls/${number}/merge`, "PUT", body);
      return { content: [{ type: "text", text: `PR #${number} merged: sha=${r.sha}\nMessage: ${r.message}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── Actions / Workflows ─────────────────────────────────────────────────────

server.tool(
  "github_list_workflows",
  "Lists GitHub Actions workflows defined on a repository.",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
  },
  async ({ owner, repo }) => {
    try {
      const r = await ghApi(`/repos/${owner}/${repo}/actions/workflows`);
      const wfs = r.workflows || [];
      if (!wfs.length) return { content: [{ type: "text", text: "No workflows found." }] };
      const lines = wfs.map((w: any) => `#${w.id} [${w.state}] ${w.name} (${w.path})`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_trigger_workflow",
  "Triggers a workflow_dispatch event on a workflow. The workflow file must declare 'on: workflow_dispatch'.",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
    workflow_id: z.union([z.number().int().positive(), z.string()]).describe("Workflow numeric ID or filename (e.g. 'ci.yml')."),
    ref: z.string().describe("Git ref (branch or tag) the workflow should run on."),
    inputs: z.record(z.string()).optional().describe("Map of input name → string value passed to the workflow."),
  },
  async ({ owner, repo, workflow_id, ref, inputs }) => {
    try {
      await ghApi(
        `/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(String(workflow_id))}/dispatches`,
        "POST",
        { ref, inputs }
      );
      return { content: [{ type: "text", text: `Workflow ${workflow_id} dispatched on ${ref}.` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_list_workflow_runs",
  "Lists recent workflow runs for a repository, optionally filtered by status.",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
    status: z.enum(["queued", "in_progress", "completed", "success", "failure", "cancelled", "skipped"]).optional().describe("Filter by run status / conclusion."),
    per_page: z.number().int().min(1).max(100).default(20).describe("Results per page (max 100)."),
  },
  async ({ owner, repo, status, per_page }) => {
    try {
      const params = new URLSearchParams({ per_page: String(per_page) });
      if (status) params.set("status", status);
      const r = await ghApi(`/repos/${owner}/${repo}/actions/runs?${params.toString()}`);
      const runs = r.workflow_runs || [];
      if (!runs.length) return { content: [{ type: "text", text: "No workflow runs found." }] };
      const lines = runs.map((w: any) => `#${w.run_number} [${w.status}/${w.conclusion ?? "?"}] ${w.name} on ${w.head_branch} (${w.html_url})`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── Releases ────────────────────────────────────────────────────────────────

server.tool(
  "github_list_releases",
  "Lists releases for a repository (most recent first).",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
    per_page: z.number().int().min(1).max(100).default(20).describe("Results per page (max 100)."),
  },
  async ({ owner, repo, per_page }) => {
    try {
      const releases = await ghApi(`/repos/${owner}/${repo}/releases?per_page=${per_page}`);
      if (!releases.length) return { content: [{ type: "text", text: "No releases found." }] };
      const lines = releases.map((r: any) => `${r.tag_name}${r.draft ? " (draft)" : ""}${r.prerelease ? " (pre)" : ""} — ${r.name || ""} (${r.published_at?.slice(0, 10) ?? "?"})`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_create_release",
  "Creates a new release on a repository (and the underlying tag if it does not exist).",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
    tag_name: z.string().describe("Tag the release points to (will be created on target_commitish if missing)."),
    name: z.string().optional().describe("Release name (defaults to tag_name)."),
    body: z.string().optional().describe("Release notes (markdown)."),
    target_commitish: z.string().optional().describe("Branch or commit the tag is created against (default: repo default branch)."),
    draft: z.boolean().default(false).describe("Create as draft (not visible publicly)."),
    prerelease: z.boolean().default(false).describe("Mark as pre-release."),
  },
  async ({ owner, repo, ...body }) => {
    try {
      const r = await ghApi(`/repos/${owner}/${repo}/releases`, "POST", body);
      return { content: [{ type: "text", text: `Release created: ${r.tag_name} (${r.name ?? ""})\nURL: ${r.html_url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── Search & Discovery ──────────────────────────────────────────────────────

server.tool(
  "github_search_repos",
  "Searches public repositories using GitHub's search syntax (e.g. 'react stars:>1000 language:TypeScript').",
  {
    query: z.string().describe("GitHub repository search query."),
    sort: z.enum(["stars", "forks", "help-wanted-issues", "updated"]).optional().describe("Sort field (default: best match)."),
    order: z.enum(["asc", "desc"]).default("desc").describe("Sort order."),
    per_page: z.number().int().min(1).max(100).default(20).describe("Results per page (max 100)."),
  },
  async ({ query, sort, order, per_page }) => {
    try {
      const params = new URLSearchParams({ q: query, order, per_page: String(per_page) });
      if (sort) params.set("sort", sort);
      const r = await ghApi(`/search/repositories?${params.toString()}`);
      const items = r.items || [];
      if (!items.length) return { content: [{ type: "text", text: `No repositories found for: "${query}"` }] };
      return { content: [{ type: "text", text: items.map(formatRepo).join("\n\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_search_code",
  "Searches code across GitHub using the search syntax (e.g. 'createMcpServer language:typescript repo:damienldx/ubik-mcp').",
  {
    query: z.string().describe("GitHub code search query (must include qualifier such as repo:, user:, org:, language:)."),
    per_page: z.number().int().min(1).max(100).default(20).describe("Results per page (max 100)."),
  },
  async ({ query, per_page }) => {
    try {
      const params = new URLSearchParams({ q: query, per_page: String(per_page) });
      const r = await ghApi(`/search/code?${params.toString()}`);
      const items = r.items || [];
      if (!items.length) return { content: [{ type: "text", text: `No code matches for: "${query}"` }] };
      const lines = items.map((it: any) => `${it.repository?.full_name}: ${it.path} — ${it.html_url}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_list_commits",
  "Lists commits on a repository, optionally filtered by branch/sha and date.",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
    sha: z.string().optional().describe("Branch name, tag, or commit SHA to start from."),
    since: z.string().optional().describe("ISO 8601 timestamp — only commits after this date."),
    per_page: z.number().int().min(1).max(100).default(30).describe("Results per page (max 100)."),
  },
  async ({ owner, repo, sha, since, per_page }) => {
    try {
      const params = new URLSearchParams({ per_page: String(per_page) });
      if (sha) params.set("sha", sha);
      if (since) params.set("since", since);
      const commits = await ghApi(`/repos/${owner}/${repo}/commits?${params.toString()}`);
      if (!commits.length) return { content: [{ type: "text", text: "No commits found." }] };
      const lines = commits.map((c: any) => `${c.sha?.slice(0, 8)} — ${c.commit?.message?.split("\n")[0] ?? ""} (${c.commit?.author?.name ?? "?"}, ${c.commit?.author?.date?.slice(0, 10) ?? "?"})`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ─── Comments ────────────────────────────────────────────────────────────────

server.tool(
  "github_list_comments",
  "Lists comments on an issue or pull request (PRs share the issue comment endpoint).",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
    number: z.number().int().positive().describe("Issue or PR number."),
    per_page: z.number().int().min(1).max(100).default(30).describe("Results per page (max 100)."),
  },
  async ({ owner, repo, number, per_page }) => {
    try {
      const comments = await ghApi(`/repos/${owner}/${repo}/issues/${number}/comments?per_page=${per_page}`);
      if (!comments.length) return { content: [{ type: "text", text: `No comments on #${number}.` }] };
      const lines = comments.map((c: any) => `@${c.user?.login ?? "?"} (${c.created_at?.slice(0, 10) ?? "?"}): ${(c.body ?? "").slice(0, 200)}`);
      return { content: [{ type: "text", text: lines.join("\n\n") }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

server.tool(
  "github_add_comment",
  "Adds a comment on an issue or pull request (PRs share the issue comment endpoint).",
  {
    owner: z.string().describe("Owner login (user or org)."),
    repo: z.string().describe("Repository name."),
    number: z.number().int().positive().describe("Issue or PR number."),
    body: z.string().describe("Comment body (markdown supported)."),
  },
  async ({ owner, repo, number, body }) => {
    try {
      const c = await ghApi(`/repos/${owner}/${repo}/issues/${number}/comments`, "POST", { body });
      return { content: [{ type: "text", text: `Comment added on #${number}: ${c.html_url}` }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
    }
  }
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-github] Fatal: ${err}\n`);
  process.exit(1);
});
