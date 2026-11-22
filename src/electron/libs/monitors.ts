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
  // Fail OPEN with a marker (not a throw): a throw into the 15s poll loop is
  // silent death — catch-everything renders nothing, forever (the shape
  // Uncia has killed three times this month). No key → empty list + reason.
  if (!config.apiKey) {
    return [{ id: "no-cloud-key", description: "No cloud API key — monitors unavailable", status: "unavailable", kind: "error" }];
  }
  // apiBaseUrl is optional (empty = default cloud); the monitors endpoint
  // lives on the plain cloud API base.
  const base = (config.apiBaseUrl || "https://api.letta.com").replace(/\/$/, "");
  const url = `${base}/v1/monitors?conversation_id=${encodeURIComponent(conversationId)}`;
  // 10s timeout: a hung /v1/monitors must not hang the caller (the env-ws
  // pattern — race every remote fetch).
  const res = await Promise.race([
    fetch(url, { headers: { Authorization: `Bearer ${config.apiKey}` } }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Monitors API timed out.")), 10_000),
    ),
  ]);
  if (!res.ok) throw new Error(`Monitors API ${res.status}`);
  const rows = (await res.json()) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.monitor_id ?? row.id ?? ""),
    description: (row.description as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    kind: (row.kind as string | null) ?? null,
  }));
}
