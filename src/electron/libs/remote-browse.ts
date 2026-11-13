import { LettaAgentClient, type ComputerSelector } from "@letta-ai/letta-agent-sdk";
import { getConnectionConfig, load } from "./settings.js";

/**
 * Remote/sandbox directory browsing for the folder picker.
 *
 * DESIGN (post-litter-fix): ALL listings — every click, every target — run
 * through ONE reusable "folder-browser" conversation under the app's active
 * agent, found-or-created on first browse and resumed by ID thereafter.
 * Nothing is created per listing; the agent's history stays clean.
 *
 * The conversation is named and reusable; sandbox listings run in the
 * agent's managed sandbox, computer listings pass the computer override on
 * the same conversation. Results are cached per (target, path).
 */

let browseClient: LettaAgentClient | null = null;
let browseConversationId: string | null = null;
const BROWSE_CONVERSATION_NAME = "folder-browser";

function client(): LettaAgentClient {
  const config = getConnectionConfig();
  browseClient ??= new LettaAgentClient({
    backend: "cloud",
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
  });
  return browseClient;
}

function activeAgentId(): string {
  const stored = load();
  return stored.agentIds?.cloud ?? stored.agentIds?.local ?? "";
}

const cache = new Map<string, string[]>();

const LIST_PROMPT = (path: string) =>
  // find is depth-invariant INCLUDING at / (the ls -p + sed pipeline breaks on
  // root-level entries).
  `Run: find ${JSON.stringify(path)} -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' | sort` +
  ` — then reply with ONLY the directory names, one per line, no headers, no commentary, no code fences. If the path does not exist, reply exactly: NOT_FOUND`;

async function ensureBrowseConversation(): Promise<string> {
  if (browseConversationId) return browseConversationId;
  const agentId = activeAgentId();
  if (!agentId) throw new Error("Select an agent before browsing folders.");
  const listed = (await client().conversations.list({ agentId, limit: 50 } as never).catch(() => [])) as unknown as
    | { id: string; name: string | null }[]
    | null;
  const existing = listed?.find?.((conversation) => conversation.name === BROWSE_CONVERSATION_NAME);
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

export async function listRemoteDirectory(
  selector: ComputerSelector | null,
  path: string,
): Promise<string[]> {
  const key = `${JSON.stringify(selector ?? "sandbox")}|${path}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const conversationId = await ensureBrowseConversation();
  const session = client().resumeSession(conversationId, {
    permissionMode: "unrestricted",
    ...(selector ? { computer: selector } : {}),
  });
  const result = (await (
    session as unknown as {
      sendAndWaitForResult: (message: unknown) => Promise<{
        type: string;
        success?: boolean;
        result?: string;
        error?: string;
      }>;
    }
  ).sendAndWaitForResult([{ type: "text", text: LIST_PROMPT(path) }])) as {
    type: string;
    success?: boolean;
    result?: string;
    error?: string;
  };
  session.close();

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
