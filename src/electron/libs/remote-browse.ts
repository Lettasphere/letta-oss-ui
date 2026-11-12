import { LettaAgentClient, type ComputerSelector } from "@letta-ai/letta-agent-sdk";
import { getConnectionConfig } from "./settings.js";

/**
 * Remote/sandbox directory browsing for the folder picker.
 *
 * The SDK exposes no direct filesystem API for a remote computer or the
 * managed sandbox — but a one-shot session pinned to the target CAN run a
 * directory listing. Each listing costs one quick agent turn (~5-35s), so
 * results are cached per (target, path): back-navigation and re-opens are
 * instant within the app's lifetime.
 *
 * Sandboxes: selector omitted — the turn runs in the SDK-managed sandbox.
 */

let browseClient: LettaAgentClient | null = null;

function client(): LettaAgentClient {
  browseClient ??= new LettaAgentClient({
    backend: "cloud",
    ...(getConnectionConfig().apiKey ? { apiKey: getConnectionConfig().apiKey } : {}),
    ...(getConnectionConfig().apiBaseUrl ? { apiBaseUrl: getConnectionConfig().apiBaseUrl } : {}),
  });
  return browseClient;
}

const cache = new Map<string, string[]>();

/** The agent browsing turns run under. Set by ipc from the app's active agent. */
let BROWSE_AGENT_ID = "";

const LIST_PROMPT = (path: string) =>
  // find is depth-invariant INCLUDING at / (the ls -p + sed pipeline breaks on
  // root-level entries).
  `Run: find ${JSON.stringify(path)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort` +
  ` — then reply with ONLY the directory names, one per line, no headers, no commentary, no code fences. If the path does not exist, reply exactly: NOT_FOUND`;

export async function listRemoteDirectory(
  selector: ComputerSelector | null,
  path: string,
): Promise<string[]> {
  const key = `${JSON.stringify(selector ?? "sandbox")}|${path}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const result = (await client().prompt(
    [{ type: "text", text: LIST_PROMPT(path) }],
    // Agent ID is resolved by the caller — browsing needs SOME cloud agent;
    // the turn is stateless for the picker's purposes.
    BROWSE_AGENT_ID,
    { permissionMode: "unrestricted", ...(selector ? { computer: selector } : {}) } as Record<string, unknown>,
  )) as { success?: boolean; result?: string; error?: string };

  if (!result.success) throw new Error(result.error ?? "The listing turn failed.");
  const body = (result.result ?? "").trim();
  if (body === "NOT_FOUND") throw new Error("That path does not exist on the target.");
  const dirs = body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("```") && line !== "NOT_FOUND")
    .slice(0, 200);
  cache.set(key, dirs);
  return dirs;
}

/** Invalidate on demand (fresh listing after remote changes). */
export function clearBrowseCache(): void {
  cache.clear();
}

export function setBrowseAgent(agentId: string): void {
  BROWSE_AGENT_ID = agentId;
}
