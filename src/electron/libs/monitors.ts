/**
 * Letta Monitors (command-watchers) for the active conversation — distinct
 * from cron schedules. Polled, not evented: the monitors API has no push
 * channel; 15s keeps the bar fresh without hammering.
 */
import { getConnectionConfig } from "./settings.js";

export interface MonitorInfo {
  id: string;
  description: string | null;
  status: string | null;
  kind: string | null;
}

export async function listMonitors(conversationId: string): Promise<MonitorInfo[]> {
  const config = getConnectionConfig();
  if (!config.apiKey) throw new Error("No cloud API key configured.");
  // apiBaseUrl is optional (empty = default cloud); the monitors endpoint
  // lives on the plain cloud API base.
  const base = (config.apiBaseUrl || "https://api.letta.com").replace(/\/$/, "");
  const url = `${base}/v1/monitors?conversation_id=${encodeURIComponent(conversationId)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.apiKey}` },
  });
  if (!res.ok) throw new Error(`Monitors API ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.monitor_id ?? row.id ?? ""),
    description: (row.description as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    kind: (row.kind as string | null) ?? null,
  }));
}
