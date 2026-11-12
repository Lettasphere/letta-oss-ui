import type { LettaAgentClient, ComputerSelector } from "@letta-ai/letta-agent-sdk";
import { load, save, type StoredSettings } from "./settings.js";

/**
 * Per-conversation execution environment (computer) selection.
 *
 * The choice is stored in the settings file under `conversationEnvs`:
 *   - absent  → no explicit choice; the session runs wherever the account/
 *              SDK decides (SDK-managed sandbox for cloud conversations)
 *   - null    → explicit Cloud Sandbox
 *   - object  → a computer selector ({ deviceId } preferred; stable across
 *              connection rotations)
 *
 * Per-turn sessions mean a pick made mid-run applies to the NEXT send.
 */

export type ComputerSelectorField = ComputerSelector;

export type ConversationEnv = { selector: ComputerSelectorField | null | undefined };

export type ComputerSummary = {
  id: string;
  deviceId: string;
  name: string;
  status: "online" | "offline";
  lastSeenAt: number;
};

/** List computers registered with this Letta Cloud account. Cloud only —
 * the SDK's computers client throws on other backends; callers surface the
 * error instead of showing an empty list. */
export async function listComputers(client: LettaAgentClient): Promise<ComputerSummary[]> {
  const result = await client.computers.list({ limit: 50 });
  return result.computers.map((computer) => ({
    id: computer.id,
    deviceId: computer.deviceId,
    name: computer.name,
    status: computer.status,
    lastSeenAt: computer.lastSeenAt,
  }));
}

export function getConversationEnv(conversationId: string): ConversationEnv {
  const selector = load().conversationEnvs?.[conversationId];
  return selector === undefined ? { selector: undefined } : { selector: selector ?? null };
}

export function setConversationEnv(
  conversationId: string,
  selector: ComputerSelectorField | null,
): ConversationEnv {
  const stored = load();
  const map = { ...(stored.conversationEnvs ?? {}) };
  // undefined = inherit; null = explicit sandbox; object = a computer.
  if (selector === undefined) delete map[conversationId];
  else map[conversationId] = selector;
  save({ ...stored, conversationEnvs: map } as StoredSettings);
  return { selector: map[conversationId] ?? null };
}

/** The session option: undefined leaves the SDK's default (managed sandbox). */
export function sessionComputerOption(
  conversationId: string,
): ComputerSelector | undefined {
  const env = getConversationEnv(conversationId);
  return env.selector === null || env.selector === undefined ? undefined : env.selector;
}
