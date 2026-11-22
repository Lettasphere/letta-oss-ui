/**
 * Full-screen Schedules view — opened from the sidebar button below Memory.
 * Wraps the panel with a header matching MemoryView's chrome.
 */
import { SchedulesPanel } from "./SchedulesPanel";

export function SchedulesView() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-6 pt-8">
      <h1 className="text-lg font-semibold text-ink-900">Schedules</h1>
      <p className="mb-4 text-sm text-muted">
        The agent's recurring tasks. Run, pause, resume, or delete — changes
        apply immediately.
      </p>
      <SchedulesPanel />
    </div>
  );
}
