import { useEffect, useRef, useState } from "react";
import { NEW_CHAT, useAppStore } from "../store";
import type { ComputerSelectorField } from "../types";
import { ChevronDownIcon } from "./icons";

/**
 * Per-conversation execution environment: the app server (this computer) or a
 * account's registered computers. Cloud conversations only — local and
 * remote-server backends run where the server already is.
 */
export function EnvironmentPicker({ conversationId }: { conversationId: string | null }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const computersLoading = useAppStore((state) => state.computersLoading);
  const computersError = useAppStore((state) => state.computersError);
  const connection = useAppStore((state) => state.connection);
  const refreshComputers = useAppStore((state) => state.refreshComputers);
  const pickEnvironment = useAppStore((state) => state.pickEnvironment);
  const envOverride = useAppStore((state) =>
    conversationId ? state.envOverrides[conversationId] : state.envOverrides[NEW_CHAT],
  );

  const isCloud = connection?.status === "ready" && connection.backend === "cloud";

  useEffect(() => {
    if (!open || !isCloud) return;
    void refreshComputers();
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, isCloud, refreshComputers]);

  const computers = useAppStore((state) => state.computers);
  const pickedDeviceId =
    envOverride && typeof envOverride === "object" && "deviceId" in envOverride
      ? envOverride.deviceId
      : null;
  const current =
    envOverride === null || envOverride === undefined
      ? ""
      : typeof envOverride === "string"
        ? envOverride
        : envOverride && "name" in envOverride
          ? envOverride.name
          : (() => {
              const match = computers.find(
                (computer) =>
                  envOverride && "deviceId" in envOverride && computer.deviceId === envOverride.deviceId,
              );
              return match?.name ?? "device";
            })();

  // Re-registrations can create several records for one machine; collapse
  // exact deviceId duplicates (prefer the online record).
  const dedupedComputers = computers.filter(
    (computer, index) =>
      computers.findIndex(
        (other) =>
          other.deviceId === computer.deviceId &&
          (other.status === "online" || other === computer),
      ) === index,
  );

  if (!isCloud) return null;

  const choose = (selector: ComputerSelectorField | null) => {
    void pickEnvironment(selector);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title="Where this conversation runs — the app server (this computer) or a registered machine"
        className="chip"
      >
        <span className="truncate text-xs">{current ? current : "This computer"}</span>
        <ChevronDownIcon className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-2 w-72 rounded-xl border border-border bg-surface p-1.5 shadow-elevated">
          <button
            type="button"
            onClick={() => choose(null)}
            className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm hover:bg-surface-tertiary"
          >
            <span>This computer</span>
            <span className="ml-auto text-[10px] text-muted">app server</span>
            {!current && <span className="text-xs text-accent">current</span>}
          </button>
          <div className="mt-1 border-t border-border pt-1">
            {computersLoading && <div className="px-3 py-2 text-xs text-muted">Loading computers…</div>}
            {computersError && (
              <div className="px-3 py-2 text-xs text-muted">{computersError}</div>
            )}
            {!computersLoading &&
              !computersError &&
              computers.length === 0 && (
                <div className="px-3 py-2 text-xs text-muted">
                  No computers registered. Run <code className="font-mono">letta connect</code> on a
                  machine to register it.
                </div>
              )}
            {dedupedComputers.map((computer) => (
              <button
                key={computer.id}
                type="button"
                onClick={() => choose({ deviceId: computer.deviceId })}
                className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm hover:bg-surface-tertiary"
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${computer.status === "online" ? "bg-accent" : "bg-muted"}`}
                    title={computer.status}
                  />
                  {computer.name}
                </span>
                {computer.deviceId === pickedDeviceId && (
                  <span className="text-xs text-accent">current</span>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
