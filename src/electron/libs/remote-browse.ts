import { LettaAgentClient, type ComputerSelector } from "@letta-ai/letta-agent-sdk";
import { getConnectionConfig, load } from "./settings.js";

/**
 * Remote/sandbox directory browsing for the folder picker.
 *
 * COMPUTERS: speaks the remote-environment listener protocol directly —
 * `list_in_directory` over the environment's status websocket (the same
 * command chat.letta.com and the Letta desktop app use). Instant, and it
 * creates NOTHING: no conversations, no agent turns.
 *
 * SANDBOX: managed sandboxes have no listener socket; listings run as one
 * transport directly (same protocol as computers) — zero conversations,
 * zero turns.
 */

let cloudClient: LettaAgentClient | null = null;

function config() {
  return getConnectionConfig();
}

function client(): LettaAgentClient {
  cloudClient ??= new LettaAgentClient({
    backend: "cloud",
    ...(config().apiKey ? { apiKey: config().apiKey } : {}),
    ...(config().apiBaseUrl ? { apiBaseUrl: config().apiBaseUrl } : {}),
  });
  return cloudClient;
}

const cache = new Map<string, string[]>();

// --- Computers: environment listener protocol -------------------------------

const envClients = new Map<string, unknown>();

async function envListClient(connectionId: string): Promise<{
  requestRaw: (message: unknown, options: unknown) => Promise<unknown>;
  close: () => Promise<void>;
}> {
  const hit = envClients.get(connectionId);
  if (hit) {
    // cache-buster: a cached socket can be dead (server rotated the lease,
    // network blip) — requestRaw on it hangs until the caller's timeout.
    // Verify liveness with a cheap 3s ping; dead sockets get replaced.
    try {
      const pingId = `ping-${Date.now()}`;
      await Promise.race([
        (hit as { requestRaw: (m: unknown, o: unknown) => Promise<unknown> }).requestRaw(
          { type: "get_cwd_map", request_id: pingId },
          { predicate: (m: { type?: string; request_id?: string }) => m?.request_id === pingId, timeoutMs: 3_000 } as never,
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error("ping-timeout")), 3_000)),
      ]);
      return hit as never;
    } catch {
      await (hit as { close: () => Promise<void> }).close().catch(() => undefined);
      envClients.delete(connectionId);
    }
  }
  const { createAppServerClient } = await import("@letta-ai/letta-code/app-server-client");
  const url = `wss://api.letta.com/v1/environments/${encodeURIComponent(
    connectionId,
  )}/status/ws?conversationId=default&channel=stream`;
  const apiKey = config().apiKey;
  const opened = await createAppServerClient({
    url: apiKey ? `${url}&token=${apiKey}` : url,
  } as never).connect();
  const wrapped = opened as never;
  envClients.set(connectionId, wrapped);
  envClientsStamped.set(connectionId, Date.now());
  // Close-event eviction: a clean server-side close evicts immediately
  // instead of waiting for the next browse's failed ping.
  (wrapped as { onClose?: (cb: () => void) => void }).onClose?.(() => evictEnvClient(connectionId));
  return wrapped;
}

const ENV_SOCKET_TTL_MS = 10 * 60 * 1000; // lease rotations make old sockets suspect
const envClientsStamped = new Map<string, number>();

/** Evict a cached env socket (called on close events + TTL checks). */
function evictEnvClient(connectionId: string): void {
  const hit = envClients.get(connectionId);
  envClients.delete(connectionId);
  envClientsStamped.delete(connectionId);
  if (hit) void (hit as { close: () => Promise<void> }).close().catch(() => undefined);
}

async function listOnComputer(selector: ComputerSelector, path: string): Promise<string[]> {
  // resolve() can hang (API stall) — cap it; a hung resolve previously hung
  // the whole browse chain despite transport-level guards.
  const resolved = await Promise.race([
    client().computers.resolve(selector),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Computer lookup timed out.")), 10_000),
    ),
  ]);
  if (!resolved.connectionId) throw new Error("That computer is offline.");
  // TTL: sockets older than the lease-rotation window get evicted proactively
  // (not on the failed-ping path — every browse was paying a 3s dead-ping tax).
  const stamped = envClientsStamped.get(resolved.connectionId) ?? 0;
  if (Date.now() - stamped > ENV_SOCKET_TTL_MS) {
    evictEnvClient(resolved.connectionId);
  }
  const env = await envListClient(resolved.connectionId);
  const requestId = `browse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reply = (await env.requestRaw(
    { type: "list_in_directory", path, request_id: requestId, include_files: false },
    {
      predicate: (message: { type?: string; request_id?: string }) =>
        message?.type === "list_in_directory_response" && message?.request_id === requestId,
    } as never,
  )) as { success?: boolean; folders?: string[]; error?: string };
  if (!reply.success) throw new Error(reply.error ?? "The listing failed.");
  return reply.folders ?? [];
}




// --- Sandbox: the session transport speaks list_in_directory directly -------

/**
 * A persistent sandbox session used ONLY as a listing transport: the session
 * attaches the agent's managed sandbox, and its app-server connection answers
 * the `list_in_directory` protocol command directly — instant, zero turns,
 * zero conversations (verified against live sandboxes). Kept alive for the
 * app's lifetime; recreated lazily if it drops.
 */
let sandboxSession: unknown | null = null;

type RawClient = {
  requestRaw: (
    message: unknown,
    options: { predicate: (message: { type?: string; request_id?: string }) => boolean },
  ) => Promise<{ success?: boolean; folders?: string[]; error?: string }>;
};

async function sandboxTransport(): Promise<RawClient> {
  if (sandboxSession) {
    const existing = (
      (sandboxSession as { controller?: { client?: RawClient } }).controller ?? {}
    ).client;
    if (existing) return existing;
  }
  const stored = load();
  const agentId = stored.agentIds?.cloud ?? stored.agentIds?.local ?? "";
  if (!agentId) throw new Error("Select an agent before browsing folders.");
  const session = client().createSession(agentId, {
    permissionMode: "unrestricted",
  });
  try {
    await (session as unknown as { initialize?: () => Promise<void> }).initialize?.();
  } catch (error) {
    // The real cause (e.g. 403 cloud-credits-exhausted) must reach the chip —
    // the generic "did not come up" hid an actionable message for days.
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      message.includes("credits")
        ? "Cloud sandbox needs credits (chat.letta.com/preferences/usage) — pick a machine target or add credits."
        : `Sandbox session failed: ${message}`,
    );
  }
  sandboxSession = session;
  const transport = ((session as { controller?: { client?: RawClient } }).controller ?? {})
    .client;
  if (!transport) throw new Error("The sandbox transport did not come up.");
  return transport;
}

async function listInSandbox(path: string): Promise<string[]> {
  const transport = await sandboxTransport();
  const requestId = `sbx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reply = await transport.requestRaw(
    { type: "list_in_directory", path, request_id: requestId, include_files: false },
    {
      predicate: (message) =>
        message?.type === "list_in_directory_response" && message?.request_id === requestId,
    },
  );
  if (!reply.success) throw new Error(reply.error ?? "The listing failed.");
  return reply.folders ?? [];
}

// --- Public -------------------------------------------------------------------

export async function listRemoteDirectory(
  selector: ComputerSelector | null,
  path: string,
): Promise<string[]> {
  const key = `${JSON.stringify(selector ?? "sandbox")}|${path}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const dirs = selector ? await listOnComputer(selector, path) : await listInSandbox(path);
  cache.set(key, dirs);
  return dirs;
}

/** Invalidate on demand (fresh listing after remote changes). */
export function clearBrowseCache(): void {
  cache.clear();
}

/** The target's default working directory (boot_working_directory). */
export async function getDefaultDirectory(
  selector: ComputerSelector | string | null,
): Promise<string> {
  // "remote-default": the app's remote-env mode target — this machine's own
  // registration (the spawn the runtime owns). Resolves via its connection.
  let effectiveSelector: ComputerSelector | null = null;
  if (selector === "remote-default") {
    // This machine's LIVE registration: the adopted external one when the
    // app is adopting (remoteEnvState is the OWNED spawn — null while
    // riding an external registration), else the owned spawn's own id.
    const { remoteEnvState, remoteAdoptionState } = await import("./remote-env.js");
    const adoption = remoteAdoptionState();
    if (adoption.kind === "adopted" && adoption.connectionId) {
      effectiveSelector = { connectionId: adoption.connectionId };
    } else {
      const state = remoteEnvState();
      if (state.connectionId) effectiveSelector = { connectionId: state.connectionId };
      else throw new Error("This machine's remote registration is not up yet.");
    }
  } else {
    effectiveSelector = (selector ?? null) as ComputerSelector | null;
  }
  const transport: RawClient = effectiveSelector
    ? await envListClientFor(effectiveSelector)
    : await sandboxTransport();
  const requestId = `dflt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const reply = (await transport.requestRaw(
    { type: "get_cwd_map", request_id: requestId },
    {
      predicate: (message: { type?: string; request_id?: string }) =>
        message?.type === "get_cwd_map_response" && message?.request_id === requestId,
    },
  )) as { success?: boolean; boot_working_directory?: string; error?: string };
  if (!reply.success) throw new Error(reply.error ?? "Could not read the default folder.");
  return reply.boot_working_directory ?? "/";
}

async function envListClientFor(selector: ComputerSelector): Promise<RawClient> {
  const resolved = await client().computers.resolve(selector);
  if (!resolved.connectionId) throw new Error("That computer is offline.");
  const env = await envListClient(resolved.connectionId);
  return env as unknown as RawClient;
}
