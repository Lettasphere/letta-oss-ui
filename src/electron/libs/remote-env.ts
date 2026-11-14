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

/**
 * The spawn's OAuth device-flow, parsed from its stdout:
 *   "Opening your browser to sign in..." → pending
 *   "If it didn't open, visit: <url>"    → url captured
 *   "Your code: <code>"                  → user code captured
 *   "Authenticated successfully."        → done
 *   poll timeout / exit                  → failed
 */
export type RemoteAuthState =
  | { status: "idle" }
  | { status: "pending"; url: string | null; userCode: string | null; reason: SpawnReason }
  | { status: "done" }
  | { status: "failed"; error: string | null; reason: SpawnReason };

let authState: RemoteAuthState = { status: "idle" };
const authListeners = new Set<(s: RemoteAuthState) => void>();

export function remoteAuthState(): RemoteAuthState {
  return authState;
}

export function onRemoteAuthChange(listener: (s: RemoteAuthState) => void): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function setAuthState(
  next:
    | RemoteAuthState
    | { status: "idle"; reason?: SpawnReason },
): void {
  authState = next;
  for (const listener of authListeners) listener(next);
}

/** Parse one stdout chunk for the device-auth flow markers. */
function feedAuthParser(chunk: string): void {
  const url = chunk.match(/If it didn't open, visit:\s*(\S+)/)?.[1];
  const code = chunk.match(/Your code:\s*(\S+)/)?.[1];
  if (url || code) {
    const priorReason =
      (authState as { reason?: SpawnReason }).reason === "replacement" ? "replacement" : "mode-switch";
    setAuthState({
      status: "pending",
      url: url ?? (authState.status === "pending" ? authState.url : null),
      userCode: code ?? (authState.status === "pending" ? authState.userCode : null),
      reason: priorReason,
    });
  }
  if (/Authenticated successfully/.test(chunk)) setAuthState({ status: "done" });
}

export function remoteEnvState(): RemoteEnvState {
  if (adopted !== null && typeof adopted === "object" && adopted.kind === "owned") {
    const s = state;
    if (s.connectionId && adopted.connectionId !== s.connectionId) {
      adopted = {
        kind: "owned",
        connectionId: s.connectionId,
        name: s.effectiveName ?? "",
        deviceId: adopted.kind === "owned" ? adopted.deviceId : "",
      };
    }
  }
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
export type SpawnReason = "mode-switch" | "replacement";

export function ensureRemoteEnv(
  env?: Record<string, string>,
  reason: SpawnReason = "mode-switch",
): { running: boolean; pid: number | null } {
  if (launched && launched.exitCode === null && launched.signalCode === null) {
    return { running: true, pid: launched.pid ?? null };
  }
  sweepStrayRegistrations();
  // Every spawn re-arms the auth watcher: a replacement spawn (adopted
  // registration died) must surface a fresh sign-in banner even after a
  // previous successful auth.
  setAuthState({ status: "idle", reason });

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
    feedAuthParser(banner.slice(-600));
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
    const priorReason =
      authState.status === "pending" || authState.status === "failed" ? authState.reason : "mode-switch";
    if (authState.status === "pending") {
      setAuthState({ status: "failed", error: "The sign-in ended before completing.", reason: priorReason });
    } else if (authState.status !== "done") {
      setAuthState({ status: "idle" });
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

// --- Adopt / watch / replace -------------------------------------------------

/**
 * ADOPT-WATCH-REPLACE: when an online registration already exists on this
 * machine's deviceId (e.g. the user's own `letta server`), the app adopts it
 * (displays it, routes to it, NEVER kills it). A websocket watch + heartbeat
 * detect its death; on death the app immediately spawns its own
 * oss-ui@<hostname> registration and surfaces the new identity.
 */

export type AdoptedState =
  | { kind: "none" }
  | { kind: "adopted"; connectionId: string; name: string; deviceId: string }
  | { kind: "owned"; connectionId: string; name: string; deviceId: string };

let adopted: AdoptedState = { kind: "none" };
let watchTimer: ReturnType<typeof setInterval> | null = null;

export function remoteAdoptionState(): AdoptedState {
  return adopted;
}

/** This machine's deviceId, from the registry (first online connection wins;
 * offline rows share it). Null when the registry can't be reached. */
async function thisMachineDeviceId(cloud: import("@letta-ai/letta-agent-sdk").LettaAgentClient): Promise<string | null> {
  try {
    const result = await cloud.computers.list({ limit: 50 });
    // The machine identity is stable across re-registrations; any row whose
    // connectionName matches this hostname pins it. Fall back: parse from
    // `letta environments current` is main-process unavailable — instead use
    // the spawn's own log the next time we own one.
    const hostname = defaultRemoteEnvName().split("@")[1] ?? "";
    const match = result.computers.find((c) => c.name === hostname || c.name.startsWith(`${hostname}-`));
    return match?.deviceId ?? null;
  } catch {
    return null;
  }
}

/**
 * Try adopting an existing online registration on this machine. Returns the
 * adoption state; when nothing is adoptable, falls through to spawning our
 * own (ensureRemoteEnv) — caller decides.
 */
export async function adoptOrSpawn(
  cloud: import("@letta-ai/letta-agent-sdk").LettaAgentClient,
  env?: Record<string, string>,
): Promise<AdoptedState> {
  // Already have a plan? Keep it (restart-safe within the process).
  if (adopted.kind !== "none") return adopted;

  const deviceId = await thisMachineDeviceId(cloud);
  if (deviceId) {
    try {
      const rows = (await cloud.computers.list({ limit: 50 })).computers;
      const online = rows.filter(
        (row) => row.deviceId === deviceId && row.status === "online" && row.connectionId,
      );
      const external = online.find((row) => !row.name.startsWith("oss-ui@"));
      if (external) {
        adopted = {
          kind: "adopted",
          connectionId: external.connectionId!,
          name: external.name,
          deviceId: external.deviceId,
        };
        startWatch(cloud, env);
        return adopted;
      }
    } catch {
      // registry unreachable — spawn path handles it
    }
  }
  const spawned = ensureRemoteEnv(env);
  if (spawned.running) {
    // identity arrives async from the spawn log; the existing banner parser
    // fills remoteEnvState(). Adoption state becomes "owned" once known.
    adopted = { kind: "owned", connectionId: "", name: "", deviceId: deviceId ?? "" };
    startWatch(cloud, env);
  }
  return adopted;
}

function startWatch(
  cloud: import("@letta-ai/letta-agent-sdk").LettaAgentClient,
  env?: Record<string, string>,
): void {
  if (watchTimer) return;
  watchTimer = setInterval(() => {
    void (async () => {
      const alive = await probeRegistrationAlive(cloud);
      if (alive) return;
      // Death detected: adopted → replace with our own; owned → respawn.
      const wasAdopted = adopted.kind === "adopted";
      adopted = { kind: "none" };
      stopWatch();
      ensureRemoteEnv(env, "replacement");
      adopted = { kind: "owned", connectionId: "", name: "", deviceId: "" };
      startWatch(cloud, env);
      if (wasAdopted) {
        // Surface the handover: renderer polls remoteEnvState + adoption.
      }
    })();
  }, 30_000);
  watchTimer.unref?.();
}

function stopWatch(): void {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
}

/** Heartbeat: a one-round-trip registry read of the watched connection. */
async function probeRegistrationAlive(
  cloud: import("@letta-ai/letta-agent-sdk").LettaAgentClient,
): Promise<boolean> {
  const watchedId =
    adopted.kind === "adopted" || adopted.kind === "owned" ? adopted.connectionId : null;
  if (!watchedId) {
    // Owned registration identity may still be parsing — treat as alive.
    return adopted.kind === "owned";
  }
  try {
    const rows = (await cloud.computers.list({ limit: 50 })).computers;
    return rows.some((row) => row.connectionId === watchedId && row.status === "online");
  } catch {
    // Registry unreachable is NOT death — keep watching.
    return true;
  }
}

/** Called on app quit: only OUR registration dies with us. */
export function shutdownAdoption(): void {
  stopWatch();
  if (adopted.kind === "adopted") {
    adopted = { kind: "none" }; // external registration survives
    return;
  }
  adopted = { kind: "none" };
  stopRemoteEnv();
}
