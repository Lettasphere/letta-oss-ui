import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { app } from "electron";
import { load, save } from "./settings.js";

/**
 * A persistent, shared Letta app server on this machine.
 *
 * Unlike the private per-app server (app-server.ts), this one:
 *   - binds a FIXED port (default ws://127.0.0.1:4500), not an ephemeral one
 *   - authenticates with a capability token, so other clients on trusted
 *     networks (e.g. the user's phone) can join the same runtime
 *   - runs detached: it survives app restarts; a stale instance is detected
 *     and adopted rather than duplicated
 *
 * Enable in Settings → Connection ("Share this computer's server").
 */

const DEFAULT_PORT = 4500;

export type SharedServerStatus = {
  enabled: boolean;
  url: string | null;
  running: boolean;
  token: string | null;
};

function stateKey(): { enabled: boolean; port: number } {
  return load().sharedServer ?? { enabled: false, port: DEFAULT_PORT };
}

export function getSharedServerConfig(): { enabled: boolean; port: number } {
  return stateKey();
}

function tokenPath(): string {
  return join(app.getPath("userData"), "shared-server.token");
}

function ensureToken(): string {
  const existing = existsSync(tokenPath()) ? readFileSync(tokenPath(), "utf8").trim() : "";
  if (existing) return existing;
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const token = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const { writeFileSync, chmodSync } = require("node:fs") as typeof import("node:fs");
  writeFileSync(tokenPath(), token + "\n", { mode: 0o600 });
  chmodSync(tokenPath(), 0o600);
  return token;
}

const require = createRequire(import.meta.url);

function findCli(): string {
  const override = process.env.LETTA_CLI_PATH;
  if (override && existsSync(override)) return override;
  return require
    .resolve("@letta-ai/letta-code")
    .replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

/** Probe a fixed-port server: is something already listening that answers? */
async function probe(url: string, token: string): Promise<boolean> {
  try {
    const { createAppServerClient } = await import(
      "@letta-ai/letta-code/app-server-client"
    );
    const client = await createAppServerClient({ url, authToken: token }).connect();
    await client.close();
    return true;
  } catch {
    return false;
  }
}

let launchInFlight: Promise<SharedServerStatus> | null = null;

export async function ensureSharedServer(): Promise<SharedServerStatus> {
  const config = stateKey();
  if (!config.enabled) return { enabled: false, url: null, running: false, token: null };
  if (launchInFlight) return launchInFlight;
  launchInFlight = (async () => {
    const port = config.port;
    const url = `ws://127.0.0.1:${port}`;
    const token = ensureToken();
    if (await probe(url, token)) {
      return { enabled: true, url, running: true, token };
    }
    // Launch detached with auth; adoption on next call handles restarts.
    const child = spawn(
      process.execPath,
      [
        findCli(),
        "--backend",
        "local",
        "server",
        "--listen",
        `ws://127.0.0.1:${port}`,
        "--ws-auth",
        "capability-token",
        "--ws-token-file",
        tokenPath(),
      ],
      {
        stdio: "ignore",
        detached: true,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      },
    );
    child.unref();
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (await probe(url, token)) {
        return { enabled: true, url, running: true, token };
      }
    }
    return { enabled: true, url, running: false, token };
  })();
  const result = await launchInFlight;
  launchInFlight = null;
  return result;
}

export function setSharedServerEnabled(enabled: boolean): SharedServerStatus {
  const stored = load();
  save({
    ...stored,
    sharedServer: { port: stored.sharedServer?.port ?? DEFAULT_PORT, enabled },
  });
  if (enabled) void ensureSharedServer();
  return { enabled, url: null, running: false, token: null };
}

export async function sharedServerStatus(): Promise<SharedServerStatus> {
  const config = stateKey();
  if (!config.enabled) return { enabled: false, url: null, running: false, token: null };
  const port = config.port;
  const url = `ws://127.0.0.1:${port}`;
  const token = existsSync(tokenPath()) ? readFileSync(tokenPath(), "utf8").trim() : null;
  const running = token ? await probe(url, token) : false;
  return { enabled: true, url: running ? url : null, running, token };
}
