/**
 * Schedules panel — the agent's cron tasks via the app-server control
 * protocol. Works in local AND remote-env modes (any mode with an
 * app-server); cloud-only surfaces the error honestly.
 */
import { useCallback, useEffect, useState } from "react";

import { useAppStore } from "../store";

import type { CronTask } from "../../electron/libs/schedules";

function cronToHuman(cron: string): string {
  // Common shapes get friendly labels; raw expression as fallback.
  const map: Record<string, string> = {
    "0 */6 * * *": "every 6 hours",
    "0 */3 * * *": "every 3 hours",
    "0 0 * * *": "daily at midnight",
    "30 6 * * *": "daily at 6:30",
    "0 6 * * *": "daily at 6:00",
    "*/15 * * * *": "every 15 minutes",
    "0 13 * * *": "daily at 13:00",
    "0 14 * * *": "daily at 14:00",
  };
  return map[cron] ?? cron;
}

export function SchedulesPanel() {
  const [tasks, setTasks] = useState<CronTask[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const agentId = useAppStore.getState().agentId;
      // No agent selected: empty list immediately — never hang on Loading.
      if (!agentId) {
        setTasks([]);
        return;
      }
      setTasks(await window.bridge.listSchedules({ agentId }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't load schedules.");
      setTasks((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (taskId: string, op: "pause" | "resume" | "trigger", name: string) => {
    setBusy(taskId + op);
    try {
      if (op === "pause") await window.bridge.pauseSchedule({ taskId });
      if (op === "resume") await window.bridge.resumeSchedule({ taskId });
      if (op === "trigger") await window.bridge.triggerSchedule({ taskId });
      await load();
    } catch (e) {
      setError(`${name}: ${e instanceof Error ? e.message : "action failed"}`);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (taskId: string, name: string) => {
    if (!window.confirm(`Delete schedule "${name}"? This cannot be undone.`)) return;
    setBusy(taskId + "delete");
    try {
      await window.bridge.deleteSchedule({ taskId });
      await load();
    } catch (e) {
      setError(`${name}: ${e instanceof Error ? e.message : "delete failed"}`);
    } finally {
      setBusy(null);
    }
  };

  if (tasks === null) {
    return <p className="px-1 py-3 text-sm text-muted">Loading schedules…</p>;
  }

  return (
    <div className="grid gap-2">
      {error && <p className="text-sm text-error">{error}</p>}
      {tasks.length === 0 && !error && (
        <p className="px-1 py-3 text-sm text-muted">
          No schedules. Create them from the CLI (<code className="font-mono text-xs">letta cron add</code>).
        </p>
      )}
      {tasks.map((task) => (
        <div
          key={task.id}
          className="flex items-center justify-between gap-3 rounded-xl border border-border px-3.5 py-2.5"
        >
          <div className="min-w-0">
            <div className="truncate text-sm font-medium text-ink-900">{task.name}</div>
            <div className="truncate text-xs text-muted">
              {cronToHuman(task.cron)}
              {task.timezone ? ` · ${task.timezone}` : ""}
              {task.description ? ` · ${task.description}` : ""}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void act(task.id, "trigger", task.name)}
              className="rounded-lg px-2.5 py-1 text-xs text-muted hover:bg-surface-tertiary hover:text-ink-900 disabled:opacity-50"
              title="Run now"
            >
              Run
            </button>
            {task.status === "paused" ? (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void act(task.id, "resume", task.name)}
                className="rounded-lg px-2.5 py-1 text-xs text-accent hover:bg-surface-tertiary disabled:opacity-50"
              >
                Resume
              </button>
            ) : (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void act(task.id, "pause", task.name)}
                className="rounded-lg px-2.5 py-1 text-xs text-muted hover:bg-surface-tertiary hover:text-ink-900 disabled:opacity-50"
              >
                Pause
              </button>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void remove(task.id, task.name)}
              className="rounded-lg px-2.5 py-1 text-xs text-error hover:bg-surface-tertiary disabled:opacity-50"
            >
              Delete
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
