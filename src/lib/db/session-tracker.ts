/**
 * SessionTracker — Pont entre les sessions terminal et la mémoire persistante.
 *
 * Hooks into PTY sessions to feed the context memory:
 * - Session lifecycle (create/destroy) → interactions
 * - Command detection from input → atoms (type: "intent")
 * - Output pattern matching → atoms (observations: file ops, errors, agent decisions)
 * - Session stats tracking
 *
 * All DB writes are fire-and-forget (non-blocking).
 */

import {
  recordInteraction,
  writeToLiveMemory,
} from "./state-manager";

// ─── Types ───

export interface TrackedSession {
  id: string;
  shell: string;
  model?: string;
  startedAt: number;
  commandCount: number;
  // Input buffer: accumulates chars until we detect a "command entered" (newline)
  inputBuffer: string;
  // Output buffer: accumulates PTY output in chunks for pattern analysis
  outputBuffer: string;
  outputFlushTimer: ReturnType<typeof setTimeout> | null;
  // Listeners for context events
  onContextEvent?: (event: ContextEvent) => void;
}

export interface ContextEvent {
  type: "session:start" | "session:end" | "command:detected" | "output:file_op" | "output:error" | "output:agent_decision" | "workflow:done";
  sessionId: string;
  shell: string;
  data: Record<string, unknown>;
  timestamp: string;
}

type ContextEventListener = (event: ContextEvent) => void;

// ─── State ───

const tracked = new Map<string, TrackedSession>();
const listeners = new Set<ContextEventListener>();

// ─── Config ───

const OUTPUT_FLUSH_INTERVAL = 2000;  // ms — analyze output in 2s chunks
const OUTPUT_BUFFER_MAX = 10_000;    // chars — max output buffer before forced flush
const INPUT_MAX_LENGTH = 2000;       // chars — max command length to record

// Resolve userId from env — sessions inherit the user context of the UBIK process
function getSessionUserId(): string {
  return process.env.UBIK_USER_ID || process.env.UBIK_DEFAULT_USER_ID || "system";
}

// ─── Public API ───

export function onContextEvent(listener: ContextEventListener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(event: ContextEvent) {
  for (const l of listeners) {
    try { l(event); } catch { /* listener error, ignore */ }
  }
}

/**
 * Start tracking a terminal session.
 */
export function trackSessionStart(id: string, shell: string, model?: string) {
  const session: TrackedSession = {
    id,
    shell,
    model,
    startedAt: Date.now(),
    commandCount: 0,
    inputBuffer: "",
    outputBuffer: "",
    outputFlushTimer: null,
  };
  tracked.set(id, session);

  const event: ContextEvent = {
    type: "session:start",
    sessionId: id,
    shell,
    data: { model, startedAt: session.startedAt },
    timestamp: new Date().toISOString(),
  };
  emit(event);

  // Record as interaction (fire-and-forget)
  recordInteraction(getSessionUserId(), {
    type: "command",
    summary: `Terminal session started: ${shell}${model ? ` (${model})` : ""}`,
    contextRefs: [id],
  }).catch(() => {});

  console.log(`\x1b[35m[SessionTracker]\x1b[0m Tracking session ${id} (${shell})`);
}

/**
 * Stop tracking a terminal session.
 */
export function trackSessionEnd(id: string) {
  const session = tracked.get(id);
  if (!session) return;

  // Flush remaining output
  if (session.outputFlushTimer) clearTimeout(session.outputFlushTimer);
  if (session.outputBuffer.length > 0) {
    analyzeOutput(session, session.outputBuffer);
    session.outputBuffer = "";
  }

  const duration = Math.round((Date.now() - session.startedAt) / 1000);

  const event: ContextEvent = {
    type: "session:end",
    sessionId: id,
    shell: session.shell,
    data: {
      model: session.model,
      durationSeconds: duration,
      commandCount: session.commandCount,
    },
    timestamp: new Date().toISOString(),
  };
  emit(event);

  recordInteraction(getSessionUserId(), {
    type: "command",
    summary: `Terminal session ended: ${session.shell} — ${session.commandCount} commands, ${formatDuration(duration)}`,
    contextRefs: [id],
  }).catch(() => {});

  tracked.delete(id);
  console.log(`\x1b[35m[SessionTracker]\x1b[0m Session ${id} ended (${session.commandCount} cmds, ${formatDuration(duration)})`);
}

/**
 * Feed user input data. Detects command entries (newline-terminated).
 */
export function trackInput(sessionId: string, data: string) {
  const session = tracked.get(sessionId);
  if (!session) return;

  for (const char of data) {
    if (char === "\r" || char === "\n") {
      const command = session.inputBuffer.trim();
      if (command.length > 0 && command.length <= INPUT_MAX_LENGTH) {
        session.commandCount++;
        onCommandDetected(session, command);
      }
      session.inputBuffer = "";
    } else if (char === "\x7f" || char === "\b") {
      // Backspace
      session.inputBuffer = session.inputBuffer.slice(0, -1);
    } else if (char.charCodeAt(0) >= 32) {
      // Printable character
      session.inputBuffer += char;
    }
    // Ignore control chars (arrows, escape sequences, etc.)
  }
}

/**
 * Feed PTY output data. Buffered and analyzed in chunks.
 */
export function trackOutput(sessionId: string, data: string) {
  const session = tracked.get(sessionId);
  if (!session) return;

  session.outputBuffer += data;

  // Force flush if buffer is getting large
  if (session.outputBuffer.length > OUTPUT_BUFFER_MAX) {
    if (session.outputFlushTimer) clearTimeout(session.outputFlushTimer);
    analyzeOutput(session, session.outputBuffer);
    session.outputBuffer = "";
    session.outputFlushTimer = null;
    return;
  }

  // Debounced flush
  if (session.outputFlushTimer) clearTimeout(session.outputFlushTimer);
  session.outputFlushTimer = setTimeout(() => {
    if (session.outputBuffer.length > 0) {
      analyzeOutput(session, session.outputBuffer);
      session.outputBuffer = "";
    }
    session.outputFlushTimer = null;
  }, OUTPUT_FLUSH_INTERVAL);
}

/**
 * Get all currently tracked sessions.
 */
export function getTrackedSessions(): TrackedSession[] {
  return Array.from(tracked.values());
}

// ─── Internal: Command Detection ───

function onCommandDetected(session: TrackedSession, command: string) {
  // Skip very short or noise commands
  if (command.length < 2) return;
  // Skip pure whitespace or single-char inputs
  if (/^\s+$/.test(command)) return;

  const source = `${session.shell}:${session.model || "default"}`;

  const event: ContextEvent = {
    type: "command:detected",
    sessionId: session.id,
    shell: session.shell,
    data: { command },
    timestamp: new Date().toISOString(),
  };
  emit(event);

  writeToLiveMemory(getSessionUserId(), {
    sessionId: session.id,
    type: "command",
    source,
    content: `Agent prompt: ${command.slice(0, 120)}`,
  }).catch(() => {});
}

// ─── Internal: Output Pattern Analysis ───

// Strip ANSI escape codes for pattern matching
function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function analyzeOutput(session: TrackedSession, rawOutput: string) {
  const clean = stripAnsi(rawOutput);
  const lines = clean.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return;

  const source = `${session.shell}:${session.model || "default"}`;

  // ── File operations ──
  const fileOps = detectFileOperations(lines);
  if (fileOps.length > 0) {
    const event: ContextEvent = {
      type: "output:file_op",
      sessionId: session.id,
      shell: session.shell,
      data: { operations: fileOps },
      timestamp: new Date().toISOString(),
    };
    emit(event);

    writeToLiveMemory(getSessionUserId(), {
      sessionId: session.id,
      type: "file_op",
      source,
      content: fileOps.map(op => `${op.action}: ${op.path}`).join("\n"),
    }).catch(() => {});
  }

  // ── Errors ──
  const errors = detectErrors(lines);
  if (errors.length > 0) {
    const event: ContextEvent = {
      type: "output:error",
      sessionId: session.id,
      shell: session.shell,
      data: { errors },
      timestamp: new Date().toISOString(),
    };
    emit(event);

    writeToLiveMemory(getSessionUserId(), {
      sessionId: session.id,
      type: "error",
      source,
      content: errors.slice(0, 3).join("\n"),
    }).catch(() => {});
  }

  // ── Agent decisions (Claude/Gemini structured output) ──
  if (session.shell === "claude" || session.shell === "gemini") {
    const decisions = detectAgentDecisions(lines, session.shell);
    if (decisions.length > 0) {
      const event: ContextEvent = {
        type: "output:agent_decision",
        sessionId: session.id,
        shell: session.shell,
        data: { decisions },
        timestamp: new Date().toISOString(),
      };
      emit(event);

      writeToLiveMemory(getSessionUserId(), {
        sessionId: session.id,
        type: "agent_decision",
        source,
        content: decisions.slice(0, 3).join("\n"),
      }).catch(() => {});
    }
  }
}

// ─── Pattern Detectors ───

interface FileOp {
  action: "created" | "modified" | "deleted" | "renamed";
  path: string;
}

function detectFileOperations(lines: string[]): FileOp[] {
  const ops: FileOp[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    // Claude Code patterns
    let match = line.match(/(?:Created|Wrote|Write)\s+(.+\.\w+)/i);
    if (match && !seen.has(match[1])) { seen.add(match[1]); ops.push({ action: "created", path: match[1].trim() }); continue; }

    match = line.match(/(?:Edited|Updated|Modified|Edit)\s+(.+\.\w+)/i);
    if (match && !seen.has(match[1])) { seen.add(match[1]); ops.push({ action: "modified", path: match[1].trim() }); continue; }

    match = line.match(/(?:Deleted|Removed|Remove)\s+(.+\.\w+)/i);
    if (match && !seen.has(match[1])) { seen.add(match[1]); ops.push({ action: "deleted", path: match[1].trim() }); continue; }

    // Git patterns
    match = line.match(/create mode \d+ (.+)/);
    if (match && !seen.has(match[1])) { seen.add(match[1]); ops.push({ action: "created", path: match[1].trim() }); continue; }

    match = line.match(/delete mode \d+ (.+)/);
    if (match && !seen.has(match[1])) { seen.add(match[1]); ops.push({ action: "deleted", path: match[1].trim() }); continue; }

    // npm/build patterns
    match = line.match(/(?:Successfully compiled|Built|Compiled)\s+(.+)/i);
    if (match && !seen.has(match[1])) { seen.add(match[1]); ops.push({ action: "created", path: match[1].trim() }); continue; }

    // mkdir
    match = line.match(/mkdir\s+(?:-p\s+)?(.+)/);
    if (match && !seen.has(match[1])) { seen.add(match[1]); ops.push({ action: "created", path: match[1].trim() }); continue; }

    // touch/cp/mv
    match = line.match(/(?:touch|cp)\s+(?:\S+\s+)?(\S+\.\w+)/);
    if (match && !seen.has(match[1])) { seen.add(match[1]); ops.push({ action: "created", path: match[1].trim() }); }
  }

  return ops;
}

function detectErrors(lines: string[]): string[] {
  const errors: string[] = [];
  const patterns = [
    /^error\b/i,
    /^Error:/i,
    /^ERR!/,
    /^FATAL/i,
    /^TypeError:/,
    /^ReferenceError:/,
    /^SyntaxError:/,
    /^ENOENT/,
    /^EACCES/,
    /^Command failed/i,
    /^npm ERR!/,
    /^ModuleNotFoundError/,
    /^ImportError/,
    /^Traceback/,
    /^panic:/,
    /compilation failed/i,
    /build failed/i,
  ];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 5) continue;
    for (const pattern of patterns) {
      if (pattern.test(trimmed)) {
        errors.push(trimmed.slice(0, 500));
        break;
      }
    }
  }

  return errors.slice(0, 10); // Cap at 10 errors per chunk
}

function detectAgentDecisions(lines: string[], shell: string): string[] {
  const decisions: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length < 10) continue;

    // Claude Code tool use markers
    if (/^(Read|Edit|Write|Bash|Grep|Glob)\s/.test(trimmed)) {
      decisions.push(trimmed.slice(0, 300));
      continue;
    }

    // Decision/plan markers in agent output (structured labels only, not casual prose)
    if (/^(Plan|Decision|Strategy|Approach):\s/i.test(trimmed) && trimmed.length > 20) {
      decisions.push(trimmed.slice(0, 300));
      continue;
    }
  }

  return decisions.slice(0, 5); // Cap at 5 decisions per chunk
}

// ─── Utils ───

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m < 60) return `${m}m${s > 0 ? `${s}s` : ""}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60}m`;
}
