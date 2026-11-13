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
  if (hit) return hit as never;
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
  return wrapped;
}

async function listOnComputer(selector: ComputerSelector, path: string): Promise<string[]> {
  const resolved = await client().computers.resolve(selector);
  if (!resolved.connectionId) throw new Error("That computer is offline.");
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
  await (session as unknown as { initialize?: () => Promise<void> }).initialize?.();
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
