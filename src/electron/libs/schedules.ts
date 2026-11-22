/**
 * Schedules (cron) via the app-server protocol: list/pause/resume/delete/trigger.
 * Schedules speak the app-server control protocol (control.ts): any mode
 * with an app-server — local AND remote-env — works. Cloud-only mode has
 * no app-server; the panel surfaces that error honestly.
 */
import { request } from "./control.js";

export interface CronTask {
  id: string;
  name: string;
  description: string;
  cron: string;
  timezone?: string | null;
  recurring: boolean;
  prompt?: string;
  scheduled_for?: string | null;
  conversation_id?: string;
  agent_id?: string;
  /** "active" | "paused" — the wire uses status, not a paused boolean. */
  status?: string;
}

export async function listSchedules(agentId: string): Promise<CronTask[]> {
  const reply = await request<{ type: string; request_id?: string; success?: boolean; tasks?: CronTask[] }>("cron_list", { agent_id: agentId });
  return reply.tasks ?? [];
}

export async function pauseSchedule(taskId: string): Promise<void> {
  await request("cron_pause", { task_id: taskId });
}

export async function resumeSchedule(taskId: string): Promise<void> {
  await request("cron_resume", { task_id: taskId });
}

export async function deleteSchedule(taskId: string): Promise<void> {
  await request("cron_delete", { task_id: taskId });
}

export async function triggerSchedule(taskId: string): Promise<void> {
  await request("cron_trigger", { task_id: taskId });
}
