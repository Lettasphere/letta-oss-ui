/**
 * Per-agent rail status: the agent's most-recent conversation timestamp +
 * a has-activity signal, for unread/working dots WITHOUT loading full lists.
 * One request per agent per poll — cheap for fleet-sized agent counts.
 */
import { LettaAgentClient } from "@letta-ai/letta-agent-sdk";
import { getConnectionConfig } from "./settings.js";

export interface AgentRailStatus {
  agentId: string;
  /** Newest last_message_at across the agent's conversations (ISO or null). */
  latestAt: string | null;
  /** Newest conversation id (for cursor comparison). */
  latestConversationId: string | null;
}

let client: LettaAgentClient | null = null;
let clientKey: string | null = null;

function sdk(): LettaAgentClient | null {
  const config = getConnectionConfig();
  // No cloud key → no poll. In local mode an unauthenticated cloud client
  // fires N doomed 401s per poll cycle, forever (Uncia gate 1).
  if (!config.apiKey) return null;
  // Credential rotation invalidates: rebuild when the key changes.
  if (!client || clientKey !== config.apiKey) {
    client = new LettaAgentClient({ backend: "cloud", apiKey: config.apiKey });
    clientKey = config.apiKey;
  }
  return client;
}

export async function agentRailStatus(agentId: string): Promise<AgentRailStatus> {
  const c = sdk();
  if (!c) throw new Error("No cloud API key — rail status unavailable.");
  const page = await c.conversations.list({ agentId, limit: 5 });
  let latest: { at: string | null; id: string | null } = { at: null, id: null };
  for (const c of page as Array<{ id: string; last_message_at?: string | null; updated_at?: string | null }>) {
    const at = c.last_message_at ?? c.updated_at ?? null;
    if (at && (!latest.at || at > latest.at)) latest = { at, id: c.id };
  }
  return { agentId, latestAt: latest.at, latestConversationId: latest.id };
}
