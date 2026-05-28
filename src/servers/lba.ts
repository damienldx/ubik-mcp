#!/usr/bin/env node
/**
 * UBIK LBA — standalone MCP stdio server.
 *
 * Tools (1):
 *   - lba_desktop_deploiement  Deploy LBA-DESKTOP: git pull + build + rsync + restart backend.
 *
 * Repo:    /home/damienldx/workspace/LBA-DESKTOP
 * Web:     /var/www/lba-desktop (served by Caddy on :8090)
 * Backend: lba-plan-service (:8504), ubik-system-lba (OAuth sidecar)
 *
 * Safety:
 *   - default dry_run=true (caller must pass dry_run=false to actually deploy)
 *   - default branch=main with guard: aborts if `plan/` directory is missing
 *     (protection against incident 2026-05-27 where main was deployed without
 *      the recouvrement P0 fixes)
 *   - branch name validated against strict whitelist (no shell metacharacters)
 */

import { z } from "zod";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { createMcpServer, runServer } from "../lib/server.js";

const execp = promisify(exec);

const REPO_DIR         = "/home/damienldx/workspace/LBA-DESKTOP";
const WEB_TARGET       = "/var/www/lba-desktop";
const BACKEND_SERVICES = ["lba-plan-service", "ubik-system-lba"];
const REQUIRED_DIRS    = ["plan"];

type StepResult = {
  label: string;
  cmd: string;
  durationMs: number;
  ok: boolean;
  stdoutTail?: string;
  stderrTail?: string;
};

function tail(s: string | undefined | null, lines = 8): string {
  if (!s) return "";
  return s.toString().split("\n").slice(-lines).join("\n").trim();
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

function shellQuoteBranch(s: string): string {
  if (!/^[A-Za-z0-9._\-/+]+$/.test(s)) {
    throw new Error(`Invalid branch name (allowed: alnum . _ - / +): ${s}`);
  }
  return s;
}

async function step(
  label: string,
  cmd: string,
  opts: { cwd?: string; dryRun?: boolean } = {}
): Promise<StepResult> {
  const t0 = Date.now();
  if (opts.dryRun) {
    return { label, cmd, durationMs: 0, ok: true, stdoutTail: "[dry-run, not executed]" };
  }
  try {
    const { stdout, stderr } = await execp(cmd, {
      cwd: opts.cwd,
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5 * 60 * 1000,
    });
    return {
      label,
      cmd,
      durationMs: Date.now() - t0,
      ok: true,
      stdoutTail: tail(stdout),
      stderrTail: tail(stderr) || undefined,
    };
  } catch (err: any) {
    return {
      label,
      cmd,
      durationMs: Date.now() - t0,
      ok: false,
      stdoutTail: tail(err?.stdout),
      stderrTail: tail(err?.stderr) || (err?.message ?? String(err)),
    };
  }
}

function renderReport(r: {
  ok: boolean;
  startedAt: string;
  branch?: string;
  commit?: string;
  dry_run?: boolean;
  skip_frontend?: boolean;
  skip_backend?: boolean;
  reason?: string;
  totalMs: number;
  steps: StepResult[];
}): string {
  const lines: string[] = [];
  lines.push(`# LBA Desktop Deploy — ${r.ok ? "OK" : "FAILED"}`);
  lines.push(`Started: ${r.startedAt}`);
  if (r.branch) lines.push(`Branch: ${r.branch}`);
  if (r.commit) lines.push(`Commit: ${r.commit}`);
  if (r.dry_run !== undefined) lines.push(`Mode: ${r.dry_run ? "DRY-RUN" : "DEPLOY"}`);
  if (r.skip_frontend) lines.push(`Skipped: frontend`);
  if (r.skip_backend) lines.push(`Skipped: backend`);
  if (r.reason) lines.push(`Reason: ${r.reason}`);
  lines.push(`Total: ${r.totalMs}ms`);
  lines.push("");
  lines.push("## Steps");
  for (const s of r.steps) {
    lines.push(`- [${s.ok ? "OK" : "FAIL"}] ${s.label} (${s.durationMs}ms)`);
    if (s.stdoutTail) lines.push(`    stdout: ${truncate(s.stdoutTail, 240)}`);
    if (s.stderrTail) lines.push(`    stderr: ${truncate(s.stderrTail, 240)}`);
  }
  return lines.join("\n");
}

const server = createMcpServer("ubik-lba");

server.tool(
  "lba_desktop_deploiement",
  "Deploy LBA-DESKTOP full-stack on dev-station-02: git pull <branch> + npm ci + npm build + rsync dist/ to /var/www/lba-desktop/ + systemctl restart backend services (lba-plan-service, ubik-system-lba). Default branch=main, with guard aborting if plan/ directory missing (protection against incident 2026-05-27). Default dry_run=true — caller must pass dry_run=false to actually deploy.",
  {
    branch: z.string().default("main").describe("Git branch to deploy (default: main)."),
    dry_run: z.boolean().default(true).describe("If true (default), show what would happen without executing build/rsync/restart. Git fetch/checkout/pull and the safety guard run in both modes."),
    skip_frontend: z.boolean().default(false).describe("Skip npm ci + npm build + rsync /var/www/lba-desktop/."),
    skip_backend: z.boolean().default(false).describe("Skip systemctl restart of backend services (lba-plan-service, ubik-system-lba)."),
  },
  async ({ branch, dry_run, skip_frontend, skip_backend }) => {
    const startedAt = new Date().toISOString();
    const steps: StepResult[] = [];

    const fail = (reason: string) => {
      const totalMs = steps.reduce((a, s) => a + s.durationMs, 0);
      return {
        content: [
          {
            type: "text" as const,
            text: renderReport({ ok: false, startedAt, branch, dry_run, skip_frontend, skip_backend, reason, totalMs, steps }),
          },
        ],
        isError: true,
      };
    };

    let safeBranch: string;
    try {
      safeBranch = shellQuoteBranch(branch);
    } catch (err: any) {
      return fail(err.message);
    }

    steps.push(await step("git_fetch", "git fetch --all --prune", { cwd: REPO_DIR }));
    if (!steps.at(-1)!.ok) return fail("git fetch failed");

    steps.push(await step("git_checkout", `git checkout ${safeBranch}`, { cwd: REPO_DIR }));
    if (!steps.at(-1)!.ok) return fail(`git checkout ${safeBranch} failed`);

    steps.push(await step("git_pull", "git pull --ff-only", { cwd: REPO_DIR }));
    if (!steps.at(-1)!.ok) return fail("git pull --ff-only failed (diverged?)");

    for (const dir of REQUIRED_DIRS) {
      const g = await step(`guard_${dir}`, `git cat-file -e HEAD:${dir}`, { cwd: REPO_DIR });
      steps.push(g);
      if (!g.ok) {
        return fail(`ABORT: required directory '${dir}' missing on branch '${safeBranch}'. Not safe to deploy.`);
      }
    }

    const commit = await step("commit_info", "git log -1 --pretty=format:'%h %ad %s' --date=short", { cwd: REPO_DIR });
    steps.push(commit);

    if (!skip_frontend) {
      steps.push(await step("npm_ci", "npm ci", { cwd: REPO_DIR, dryRun: dry_run }));
      if (!steps.at(-1)!.ok) return fail("npm ci failed");

      steps.push(await step("npm_build", "npm run build", { cwd: REPO_DIR, dryRun: dry_run }));
      if (!steps.at(-1)!.ok) return fail("npm run build failed");

      steps.push(await step("rsync_dist", `sudo rsync -a --delete ${REPO_DIR}/dist/ ${WEB_TARGET}/`, { dryRun: dry_run }));
      if (!steps.at(-1)!.ok) return fail("rsync failed");
    }

    if (!skip_backend) {
      for (const svc of BACKEND_SERVICES) {
        steps.push(await step(`restart_${svc}`, `sudo /bin/systemctl restart ${svc}`, { dryRun: dry_run }));
        if (!steps.at(-1)!.ok) return fail(`restart ${svc} failed`);
      }
      for (const svc of BACKEND_SERVICES) {
        steps.push(await step(`status_${svc}`, `systemctl is-active ${svc}`, { dryRun: dry_run }));
      }
    }

    const totalMs = steps.reduce((a, s) => a + s.durationMs, 0);
    return {
      content: [
        {
          type: "text" as const,
          text: renderReport({
            ok: true,
            startedAt,
            branch: safeBranch,
            commit: commit.stdoutTail || "n/a",
            dry_run,
            skip_frontend,
            skip_backend,
            totalMs,
            steps,
          }),
        },
      ],
    };
  }
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-lba] fatal: ${err?.message ?? err}\n`);
  process.exit(1);
});
