import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { app } from "electron";
import { load } from "./settings.js";

/**
 * Registers this machine as a remote environment with Letta Cloud
 * (`letta server` in remote mode — no local listener). Other clients on the
 * account can route sessions to this computer while it is registered.
 *
 * Lifecycle is tied to the app: starts when the app starts (if the setting
 * is on) and stops when the app quits or the setting changes away. One
 * instance per app; a fresh launch replaces a stale PID from a crash.
 */

const require = createRequire(import.meta.url);
const PID_FILE = () => `${app.getPath("userData")}/remote-env.pid`;

function findCli(): string {
  const override = process.env.LETTA_CLI_PATH;
  if (override && existsSync(override)) return override;
  return require
    .resolve("@letta-ai/letta-code")
    .replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

let launched: ChildProcess | null = null;

/** The registration's true identity, parsed from the CLI's startup output —
 * the name the registry ACTUALLY assigned (including any dedup suffix) and
 * its connectionId. This is the single source of truth for the UI. */
export type RemoteEnvState = {
  running: boolean;
  effectiveName: string | null;
  connectionId: string | null;
};

const state: RemoteEnvState = { running: false, effectiveName: null, connectionId: null };

export function remoteEnvState(): RemoteEnvState {
  return {
    ...state,
    running: state.running && launched !== null && launched.exitCode === null && launched.signalCode === null,
  };
}

/**
 * Kill registrations spawned by ANY run of this app (previous app runs leak
 * them — tracking is per-process). The pattern matches this app's electron
 * binary path plus the remote-server invocation; anything else on the box
 * (the user's own `letta server`) does not match and is left alone.
 */
function sweepStrayRegistrations(): void {
  try {
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    const pattern = `${"lettasphere/letta-oss-ui/node_modules"}.*electron.*server --env-name`;
    execFileSync("pkill", ["-f", pattern], { stdio: "ignore" });
  } catch {
    // no strays, or pkill unavailable — nothing to do
  }
}

/** Ensure a `letta server` (remote mode) registration is running. Idempotent. */
export function ensureRemoteEnv(env?: Record<string, string>): { running: boolean; pid: number | null } {
  if (launched && launched.exitCode === null && launched.signalCode === null) {
    return { running: true, pid: launched.pid ?? null };
  }
  sweepStrayRegistrations();

  const child = spawn(
    process.execPath,
    [
      findCli(),
      "server",
      "--env-name",
      load().remoteEnvName?.trim() || defaultRemoteEnvName(),
    ],
    {
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ...env },
    },
  );
  launched = child;
  state.running = true;
  state.effectiveName = null;
  state.connectionId = null;

  // stdout does NOT carry the registered identity: it prints the REQUESTED
  // name ("The name of your computer is: X"), but the server may append a
  // dedup suffix at registration (-N on name collisions) — the EFFECTIVE
  // name and connectionId land in the log file, whose path stdout announces
  // ("Log file: <path>"). Parse that file for the true identity.
  let banner = "";
  let logPath: string | null = null;
  let identityTimer: ReturnType<typeof setTimeout> | null = null;

  const readIdentityFromLog = () => {
    if (!logPath || !existsSync(logPath)) return;
    try {
      const log = readFileSync(logPath, "utf8");
      const name = log.match(/connectionName:\s*(\S+)/)?.[1];
      const conn = log.match(/connectionId[=:]\s*(conn-\S+)/)?.[1];
      if (name) state.effectiveName = name;
      if (conn) state.connectionId = conn;
      if (name && conn && identityTimer) {
        clearTimeout(identityTimer);
        identityTimer = null;
      }
    } catch {
      // log not flushed yet — retry on the next tick
    }
  };

  child.stdout?.on("data", (chunk: unknown) => {
    banner = (banner + String(chunk)).slice(-4_000);
    const path = banner.match(/Log file:\s*(\S+)/)?.[1];
    if (path && !logPath) {
      logPath = path;
      identityTimer = setInterval(readIdentityFromLog, 500);
      // Safety: stop polling after 30s regardless.
      setTimeout(() => {
        if (identityTimer) {
          clearInterval(identityTimer);
          identityTimer = null;
        }
      }, 30_000).unref?.();
    }
  });
  child.on("exit", () => {
    if (launched === child) launched = null;
    if (identityTimer) {
      clearInterval(identityTimer);
      identityTimer = null;
    }
    state.running = false;
    state.effectiveName = null;
    state.connectionId = null;
  });
  child.on("error", () => {
    state.running = false;
  });
  return { running: true, pid: child.pid ?? null };
}

function hostname(): string {
  try {
    return require("node:os").hostname();
  } catch {
    return "oss-ui";
  }
}

/** Registration name used when the user leaves the field blank — concrete and
 * distinct from the machine's primary registration so pickers stay readable. */
export function defaultRemoteEnvName(): string {
  return `oss-ui@${hostname()}`;
}

/** Stop the registration this app started. Called on app quit and when the
 * execution-mode setting changes away from remote-env. */
export function stopRemoteEnv(): void {
  if (launched) {
    try {
      launched.kill("SIGTERM");
    } catch {
      // already gone
    }
    launched = null;
  }
  sweepStrayRegistrations();
  state.running = false;
  state.effectiveName = null;
  state.connectionId = null;
  try {
    require("node:fs").unlinkSync(PID_FILE());
  } catch {
    // nothing to clean
  }
}
