import { LettaAgentClient, type ComputerSelector } from "@letta-ai/letta-agent-sdk";
import { getConnectionConfig, load, save, type StoredSettings } from "./settings.js";

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

let cloudComputersClient: LettaAgentClient | null = null;

/** List computers registered with this Letta Cloud account.
 *
 * The app's main client routes cloud sessions through a local app-server
 * (backend: "local" with harnessBackend: "api"), and the SDK's computers
 * client exists only on a direct cloud client — so this builds one
 * dedicated listing client from the saved cloud credentials. */
export async function listComputers(): Promise<ComputerSummary[]> {
  const config = getConnectionConfig();
  if (config.backend !== "cloud") {
    throw new Error("Computers are only available with the Letta Cloud backend.");
  }
  cloudComputersClient ??= new LettaAgentClient({
    backend: "cloud",
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
  });
  const result = await cloudComputersClient.computers.list({ limit: 50 });
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
  selector: ComputerSelectorField | null | undefined,
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
