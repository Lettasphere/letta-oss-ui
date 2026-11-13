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
 * turn in a single reused "folder-browser" conversation under the app's
 * active agent (found-or-created once, resumed by id forever).
 */

let cloudClient: LettaAgentClient | null = null;
let browseConversationId: string | null = null;
const BROWSE_CONVERSATION_NAME = "folder-browser";

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

// --- Sandbox: one reused conversation ----------------------------------------

const SANDBOX_LIST_PROMPT = (path: string) =>
  `Run: find ${JSON.stringify(path)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort` +
  ` — then reply with ONLY the directory names, one per line, no headers, no commentary, no code fences. If the path does not exist, reply exactly: NOT_FOUND`;

function activeAgentId(): string {
  const stored = load();
  return stored.agentIds?.cloud ?? stored.agentIds?.local ?? "";
}

async function ensureBrowseConversation(): Promise<string> {
  if (browseConversationId) return browseConversationId;
  const agentId = activeAgentId();
  if (!agentId) throw new Error("Select an agent before browsing folders.");
  const listed = (await client().conversations.list({ agentId, limit: 50 } as never).catch(
    () => [],
  )) as unknown as { id: string; name: string | null }[] | null;
  const existing = listed?.find?.(
    (conversation) => conversation.name === BROWSE_CONVERSATION_NAME,
  );
  if (existing) {
    browseConversationId = existing.id;
    return existing.id;
  }
  const created = (await client().conversations.create({
    agentId,
    name: BROWSE_CONVERSATION_NAME,
  } as never)) as unknown as { id: string };
  browseConversationId = created.id;
  return created.id;
}

async function listInSandbox(path: string): Promise<string[]> {
  const conversationId = await ensureBrowseConversation();
  const session = client().resumeSession(conversationId, {
    permissionMode: "unrestricted",
  });
  const result = (await (
    session as unknown as {
      sendAndWaitForResult: (message: unknown) => Promise<{
        success?: boolean;
        result?: string;
        error?: string;
      }>;
    }
  ).sendAndWaitForResult([{ type: "text", text: SANDBOX_LIST_PROMPT(path) }])) as {
    success?: boolean;
    result?: string;
    error?: string;
  };
  session.close();
  if (!result.success) throw new Error(result.error ?? "The listing turn failed.");
  const body = (result.result ?? "").trim();
  if (body === "NOT_FOUND") throw new Error("That path does not exist in the sandbox.");
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("```") && line !== "NOT_FOUND")
    .slice(0, 200);
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
