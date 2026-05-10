#!/usr/bin/env node
/**
 * Standalone MCP server — formation.ts
 *
 * UI automation primitives for screencast / training / scripted demos.
 * Tools wrap xdotool + a screenshot util via child_process.execFile.
 *
 *   - formation_screenshot  Take a PNG screenshot to the given path.
 *   - formation_key         Press a single key (xdotool key).
 *   - formation_hotkey      Press a key combination (xdotool key with modifiers).
 *   - formation_scroll      Scroll up or down N notches at the current pointer.
 *
 * No UBIK-RELEASE deps. Imports: @modelcontextprotocol/sdk, zod, dotenv, node:*.
 * Designed to run on a Linux desktop (X11 or Wayland with xwayland for xdotool).
 */

import { z } from "zod";
import { config } from "dotenv";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createMcpServer, runServer } from "../lib/server";

config({ path: path.join(process.cwd(), ".env") });

const exec = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 10_000;

// ── Helpers ──────────────────────────────────────────────────────────────────
async function which(cmd: string): Promise<string | null> {
  try {
    const { stdout } = await exec("which", [cmd], { timeout: 2_000 });
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function pickScreenshotTool(): Promise<{ bin: string; args: (out: string) => string[] } | null> {
  // Try a few common Linux screenshot utilities.
  if (await which("gnome-screenshot")) {
    return { bin: "gnome-screenshot", args: (out) => ["-f", out] };
  }
  if (await which("scrot")) {
    return { bin: "scrot", args: (out) => ["-o", out] };
  }
  if (await which("import")) {
    // ImageMagick — fullscreen
    return { bin: "import", args: (out) => ["-window", "root", out] };
  }
  if (await which("grim")) {
    // Wayland (Sway/Hyprland)
    return { bin: "grim", args: (out) => [out] };
  }
  return null;
}

// ── Server ────────────────────────────────────────────────────────────────────
const server = createMcpServer("ubik-formation");

server.tool(
  "formation_screenshot",
  "Capture a fullscreen PNG and write it to disk. Auto-detects the available tool (gnome-screenshot, scrot, ImageMagick import, or grim on Wayland).",
  {
    out_path: z.string().describe("Absolute path where the PNG will be written"),
  },
  async ({ out_path }) => {
    try {
      const abs = path.resolve(out_path);
      const dir = path.dirname(abs);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const tool = await pickScreenshotTool();
      if (!tool) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                "No screenshot tool available. Install one of: gnome-screenshot, scrot, imagemagick, grim.",
            },
          ],
          isError: true,
        };
      }
      await exec(tool.bin, tool.args(abs), { timeout: DEFAULT_TIMEOUT_MS });
      return {
        content: [{ type: "text" as const, text: `Screenshot saved with ${tool.bin}: ${abs}` }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Screenshot error: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  "formation_key",
  "Press a single key on the focused window. Examples: 'Return', 'Escape', 'Tab', 'a', 'F5'. Requires xdotool.",
  {
    key:      z.string().min(1).describe("X keysym name (no spaces, no modifiers — use formation_hotkey for combos)"),
    repeat:   z.number().int().positive().max(50).default(1).describe("Number of times to press the key"),
    delay_ms: z.number().int().min(0).max(2_000).default(0).describe("Delay in milliseconds between repeats"),
  },
  async ({ key, repeat, delay_ms }) => {
    try {
      if (!(await which("xdotool"))) {
        return {
          content: [{ type: "text" as const, text: "xdotool not found. Install it (sudo apt install xdotool)." }],
          isError: true,
        };
      }
      // Whitelist: no spaces, no shell metacharacters; xdotool keysyms are alnum + underscore + a few.
      if (!/^[A-Za-z0-9_+\-]+$/.test(key)) {
        return {
          content: [{ type: "text" as const, text: `Invalid key format: ${key}` }],
          isError: true,
        };
      }
      for (let i = 0; i < repeat; i++) {
        await exec("xdotool", ["key", "--clearmodifiers", key], { timeout: DEFAULT_TIMEOUT_MS });
        if (delay_ms > 0 && i < repeat - 1) {
          await new Promise((r) => setTimeout(r, delay_ms));
        }
      }
      return { content: [{ type: "text" as const, text: `Pressed ${key} × ${repeat}` }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Key press error: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  "formation_hotkey",
  "Press a modifier key combination on the focused window. Modifiers: ctrl, shift, alt, super. Requires xdotool.",
  {
    combo: z.string().min(1).describe("Combo joined by '+', e.g. 'ctrl+shift+t' or 'alt+F4'"),
  },
  async ({ combo }) => {
    try {
      if (!(await which("xdotool"))) {
        return {
          content: [{ type: "text" as const, text: "xdotool not found." }],
          isError: true,
        };
      }
      // Allow only safe characters in the combo string.
      if (!/^[A-Za-z0-9_+\-]+$/.test(combo)) {
        return {
          content: [{ type: "text" as const, text: `Invalid combo format: ${combo}` }],
          isError: true,
        };
      }
      await exec("xdotool", ["key", combo], { timeout: DEFAULT_TIMEOUT_MS });
      return { content: [{ type: "text" as const, text: `Hotkey sent: ${combo}` }] };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Hotkey error: ${msg}` }], isError: true };
    }
  },
);

server.tool(
  "formation_scroll",
  "Scroll the window under the pointer. Each notch maps to one mouse-wheel click. Requires xdotool.",
  {
    direction: z.enum(["up", "down"]).describe("Scroll direction"),
    notches:   z.number().int().min(1).max(50).default(3).describe("Number of scroll-wheel notches"),
  },
  async ({ direction, notches }) => {
    try {
      if (!(await which("xdotool"))) {
        return {
          content: [{ type: "text" as const, text: "xdotool not found." }],
          isError: true,
        };
      }
      const button = direction === "up" ? "4" : "5";
      for (let i = 0; i < notches; i++) {
        await exec("xdotool", ["click", button], { timeout: DEFAULT_TIMEOUT_MS });
      }
      return {
        content: [{ type: "text" as const, text: `Scrolled ${direction} × ${notches}` }],
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text" as const, text: `Scroll error: ${msg}` }], isError: true };
    }
  },
);

runServer(server).catch((err) => {
  process.stderr.write(`[ubik-formation] fatal: ${String(err)}\n`);
  process.exit(1);
});
