/**
 * Canvas Session — In-memory event bus for streaming HTML artifacts
 *
 * When buildHtmlArtifactStreaming() renders sections, it emits events
 * to this bus. The /api/canvas-stream SSE endpoint reads from it.
 * Sessions auto-cleanup after 60 seconds.
 */

import { EventEmitter } from "events";

interface CanvasEvent {
  phase: "shell" | "section" | "done";
  html?: string;
  index?: number;
  total?: number;
  path?: string;
}

const sessions = new Map<string, EventEmitter>();

/** Create a new canvas session and return its ID */
export function createCanvasSession(): { sessionId: string; emitter: EventEmitter } {
  const sessionId = `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const emitter = new EventEmitter();
  emitter.setMaxListeners(10);
  sessions.set(sessionId, emitter);

  // Auto-cleanup after 60s
  setTimeout(() => {
    sessions.delete(sessionId);
    emitter.removeAllListeners();
  }, 60_000);

  return { sessionId, emitter };
}

/** Get an existing canvas session */
export function getCanvasSession(sessionId: string): EventEmitter | undefined {
  return sessions.get(sessionId);
}

/** Emit an event on a canvas session */
export function emitCanvasEvent(sessionId: string, event: CanvasEvent): void {
  const emitter = sessions.get(sessionId);
  if (emitter) {
    emitter.emit("canvas", event);
  }
}

/** Close and cleanup a canvas session */
export function closeCanvasSession(sessionId: string): void {
  const emitter = sessions.get(sessionId);
  if (emitter) {
    emitter.removeAllListeners();
    sessions.delete(sessionId);
  }
}
