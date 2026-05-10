#!/usr/bin/env node
/**
 * Standalone MCP server — review.ts
 *
 * Tools:
 *   - review_file  Static analysis of a single source file (no LLM).
 *   - review_diff  Parse a unified git diff and summarise changes / risk.
 *   - review_pr    Review a PR by fetching its commits + files via gh, then static checks.
 *
 * Pure syntactic analysis. Imports: @modelcontextprotocol/sdk, zod, dotenv, node:*.
 */

import { z } from "zod";
import { config } from "dotenv";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync, existsSync } from "node:fs";
import path from "node:path";
import { createMcpServer, runServer } from "../lib/server";

config({ path: path.join(process.cwd(), ".env") });

const MAX_FILE_SIZE = 500_000;

// ── Issue model ──────────────────────────────────────────────────────────────
type Severity = "error" | "warning" | "info";
interface Issue {
  severity: Severity;
  line: number;
  rule: string;
  message: string;
}

// ── Static rules (regex-based, language-agnostic where possible) ─────────────
const RULES: Array<{
  rule: string;
  pattern: RegExp;
  severity: Severity;
  message: string;
  appliesTo?: (ext: string) => boolean;
}> = [
  {
    rule: "no-eval",
    pattern: /\beval\s*\(/,
    severity: "error",
    message: "Use of eval() — code injection risk (CWE-95).",
  },
  {
    rule: "no-exec-shell",
    pattern: /child_process\.exec\s*\(/,
    severity: "warning",
    message: "child_process.exec runs a shell — prefer execFile to avoid injection (CWE-78).",
    appliesTo: (ext) => [".ts", ".tsx", ".js", ".mjs", ".cjs"].includes(ext),
  },
  {
    rule: "console-log",
    pattern: /\bconsole\.log\s*\(/,
    severity: "info",
    message: "console.log left in code — consider a logger or remove before production.",
  },
  {
    rule: "todo-marker",
    pattern: /\b(TODO|FIXME|XXX|HACK)\b/,
    severity: "info",
    message: "Pending work marker — track in an issue or remove.",
  },
  {
    rule: "weak-hash",
    pattern: /\b(md5|sha1)\s*\(/i,
    severity: "warning",
    message: "Weak hash algorithm — use sha256 or stronger (CWE-328).",
  },
  {
    rule: "hardcoded-secret",
    pattern: /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][A-Za-z0-9_\-]{16,}['"]/i,
    severity: "error",
    message: "Possible hardcoded secret — move to env or secret manager.",
  },
  {
    rule: "long-line",
    pattern: /^.{200,}$/,
    severity: "info",
    message: "Line longer than 200 chars — consider splitting.",
  },
];

function analyseLine(line: string, ext: string, lineNo: number): Issue[] {
  const out: Issue[] = [];
  for (const r of RULES) {
    if (r.appliesTo && !r.appliesTo(ext)) continue;
    if (r.pattern.test(line)) {
      out.push({ severity: r.severity, line: lineNo, rule: r.rule, message: r.message });
    }
  }
  return out;
}

interface ComplexityStat {
  totalLines: number;
  blankLines: number;
  commentLines: number;
  maxNesting: number;
  branchCount: number;
}

function complexity(text: string): ComplexityStat {
  const lines = text.split("\n");
  let blank = 0;
  let comment = 0;
  let maxNest = 0;
  let nest = 0;
  let branches = 0;
  for (const l of lines) {
    const t = l.trim();
    if (!t) {
      blank++;
      continue;
    }
    if (t.startsWith("//") || t.startsWith("#") || t.startsWith("*")) {
      comment++;
    }
    // crude nesting via opening braces, accept // and # as comments above
    nest += (l.match(/\{/g) || []).length;
    nest -= (l.match(/\}/g) || []).length;
    if (nest > maxNest) maxNest = nest;
    if (/\b(if|for|while|case|catch|else if|elif)\b/.test(t)) branches++;
  }
  return { totalLines: lines.length, blankLines: blank, commentLines: comment, maxNesting: maxNest, branchCount: branches };
}

function reviewText(text: string, ext: string): { issues: Issue[]; stats: ComplexityStat } {
  const issues: Issue[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    issues.push(...analyseLine(lines[i], ext, i + 1));
  }
  return { issues, stats: complexity(text) };
}

function formatIssues(issues: Issue[]): string {
  if (!issues.length) return "_No issues detected by static rules._";
  const bySev: Record<Severity, Issue[]> = { error: [], warning: [], info: [] };
  for (const i of issues) bySev[i.severity].push(i);
  const order: Severity[] = ["error", "warning", "info"];
  let out = "";
  for (const s of order) {
    if (!bySev[s].length) continue;
    out += `\n### ${s.toUpperCase()} (${bySev[s].length})\n`;
    for (const i of bySev[s]) {
      out += `- L${i.line} \`${i.rule}\` — ${i.message}\n`;
    }
  }
  return out.trim();
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = createMcpServer("ubik-review-standalone");

server.tool(
  "review_file",
  "Static analysis of a single source file. Detects eval, exec shell, weak hashes, hardcoded secrets, console.log, long lines, TODO markers. Reports complexity stats. No external LLM call.",
  {
    file_path: z.string().describe("Absolute or workspace-relative path to the file"),
  },
  async ({ file_path }) => {
    try {
      const abs = path.resolve(file_path);
      if (!existsSync(abs)) {
        return { content: [{ type: "text" as const, text: `File not found: ${abs}` }], isError: true };
      }
      const stat = statSync(abs);
      if (stat.size > MAX_FILE_SIZE) {
        return {
          content: [{ type: "text" as const, text: `File too large: ${stat.size} bytes (max ${MAX_FILE_SIZE}).` }],
          isError: true,
        };
      }
      const text = readFileSync(abs, "utf-8");
      const ext = path.extname(abs).toLowerCase();
      const { issues, stats } = reviewText(text, ext);
      const out = [
        `# review_file ${path.basename(abs)}`,
        `**Path:** ${abs}`,
        `**Size:** ${stat.size} bytes · ${stats.totalLines} lines (${stats.blankLines} blank, ${stats.commentLines} comments)`,
        `**Complexity:** maxNesting=${stats.maxNesting} · branches=${stats.branchCount}`,
        ``,
        `## Issues (${issues.length})`,
        formatIssues(issues),
      ].join("\n");
      return { content: [{ type: "text" as const, text: out }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error reviewing ${file_path}: ${msg}` }],
        isError: true,
      };
    }
  },
);

server.tool(
  "review_diff",
  "Parse a unified git diff and summarise changes per file (additions, deletions, risky patterns spotted in added lines).",
  {
    diff: z.string().describe("Unified diff text (output of `git diff` or similar)"),
  },
  async ({ diff }) => {
    try {
      const files = new Map<string, { added: number; removed: number; addedLines: string[] }>();
      let current: string | null = null;
      for (const line of diff.split("\n")) {
        const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (m) {
          current = m[2];
          if (!files.has(current)) files.set(current, { added: 0, removed: 0, addedLines: [] });
          continue;
        }
        if (!current) continue;
        if (line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+")) {
          const f = files.get(current)!;
          f.added++;
          f.addedLines.push(line.slice(1));
        } else if (line.startsWith("-")) {
          files.get(current)!.removed++;
        }
      }
      let out = `# review_diff\n**Files changed:** ${files.size}\n`;
      let total = 0;
      for (const [name, f] of files) {
        const ext = path.extname(name).toLowerCase();
        const issues: Issue[] = [];
        f.addedLines.forEach((ln, i) => issues.push(...analyseLine(ln, ext, i + 1)));
        total += f.added + f.removed;
        out += `\n## ${name}\n+${f.added} −${f.removed}\n`;
        if (issues.length) {
          out += `\n**Risky patterns in added lines:**\n${formatIssues(issues)}\n`;
        }
      }
      out += `\n---\n**Total churn:** ${total} lines.`;
      return { content: [{ type: "text" as const, text: out }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Error parsing diff: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  "review_pr",
  "Review a GitHub PR by number. Uses the gh CLI to fetch the diff + commit list. Runs review_diff logic on the diff and lists commits + authors.",
  {
    pr_number: z.number().int().positive().describe("PR number (in current repo)"),
    repo: z.string().optional().describe("owner/name slug (default: current repo from gh)"),
  },
  async ({ pr_number, repo }) => {
    try {
      const repoArgs = repo ? ["-R", repo] : [];
      const diff = execFileSync("gh", ["pr", "diff", String(pr_number), ...repoArgs], {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
      });
      const commits = execFileSync(
        "gh",
        [
          "pr",
          "view",
          String(pr_number),
          ...repoArgs,
          "--json",
          "title,author,commits,additions,deletions,changedFiles",
        ],
        { encoding: "utf-8" },
      );
      const meta = JSON.parse(commits) as {
        title: string;
        author?: { login: string };
        commits?: Array<{ messageHeadline: string; oid: string }>;
        additions: number;
        deletions: number;
        changedFiles: number;
      };

      // Re-use review_diff parser inline.
      const files = new Map<string, { added: number; removed: number; addedLines: string[] }>();
      let current: string | null = null;
      for (const line of diff.split("\n")) {
        const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
        if (m) {
          current = m[2];
          if (!files.has(current)) files.set(current, { added: 0, removed: 0, addedLines: [] });
          continue;
        }
        if (!current || line.startsWith("+++") || line.startsWith("---")) continue;
        if (line.startsWith("+")) {
          const f = files.get(current)!;
          f.added++;
          f.addedLines.push(line.slice(1));
        } else if (line.startsWith("-")) {
          files.get(current)!.removed++;
        }
      }

      let out = [
        `# review_pr #${pr_number}`,
        `**Title:** ${meta.title}`,
        `**Author:** ${meta.author?.login ?? "?"}`,
        `**Files changed:** ${meta.changedFiles} · +${meta.additions} −${meta.deletions}`,
        ``,
        `## Commits (${meta.commits?.length ?? 0})`,
      ].join("\n");
      for (const c of meta.commits ?? []) {
        out += `\n- \`${c.oid.slice(0, 8)}\` ${c.messageHeadline}`;
      }
      out += `\n\n## Static analysis on added lines`;
      for (const [name, f] of files) {
        const ext = path.extname(name).toLowerCase();
        const issues: Issue[] = [];
        f.addedLines.forEach((ln, i) => issues.push(...analyseLine(ln, ext, i + 1)));
        if (issues.length) {
          out += `\n\n### ${name} (+${f.added} −${f.removed})\n${formatIssues(issues)}`;
        }
      }
      return { content: [{ type: "text" as const, text: out }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: "text" as const, text: `Error reviewing PR #${pr_number}: ${msg}` }],
        isError: true,
      };
    }
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-review-standalone] fatal: ${String(err)}\n`);
  process.exit(1);
});
