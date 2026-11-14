import { useEffect, useRef, useState } from "react";
import { NEW_CHAT, useAppStore } from "../store";
import type { ComputerSelectorField } from "../types";
import { ChevronDownIcon } from "./icons";

/**
 * Per-conversation execution environment: the app server (this computer) or a
 * account's registered computers. Cloud conversations only — local and
 * remote-server backends run where the server already is.
 */
export function EnvironmentPicker() {
  const activeId = useAppStore((state) => state.activeId);
  const conversationId = activeId;
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

  const mode = useAppStore((state) => state.executionMode);
  // An environment is ALWAYS effectively chosen: the explicit pick, else the
  // mode's default. Private mode defaults to this computer's app server;
  // every other mode defaults to the cloud sandbox. Exactly one row is
  // "current" in every state — "nothing picked" is not a state.
  const effectiveIsLocalApp = mode === "local" && envOverride === undefined;
  const effectiveIsSandbox = envOverride === null || (envOverride === undefined && mode !== "local");
  const [ownRemote, setOwnRemote] = useState<{
    running: boolean;
    effectiveName: string | null;
    connectionId: string | null;
  } | null>(null);
  // Adoption: when the app rides an EXTERNAL registration (this machine,
  // not app-spawned), THIS MACHINE shows it with an adopted hint; on its
  // death the app spawns its own and the poll below picks up the handover.
  // Event-driven from the main process (remote_adoption broadcasts) — the
  // handover (adopted dies → owned replacement) updates the picker instantly.
  const adoption = useAppStore((state) => state.remoteAdoption);


  useEffect(() => {
    void useAppStore.getState().refreshExecutionMode();
    void window.bridge.getRemoteEnvStatus().then(setOwnRemote);
    void useAppStore.getState().refreshExecutionMode();
  }, []);

  // Mode can flip mid-session (Settings Save spawns the registration AFTER
  // this component mounted). While in remote-env mode without an identity
  // yet, poll until it lands — the spawn's banner takes a couple seconds.
  useEffect(() => {
    if (mode !== "remote-env") return;
    if (ownRemote?.running && ownRemote.effectiveName) return;
    const timer = setInterval(() => {
      void window.bridge.getRemoteEnvStatus().then((status) => {
        setOwnRemote(status);
        if (status.running && status.effectiveName) clearInterval(timer);
      });
    }, 1500);
    const stop = setTimeout(() => clearInterval(timer), 60_000);
    return () => {
      clearInterval(timer);
      clearTimeout(stop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, ownRemote?.running, ownRemote?.effectiveName]);

  useEffect(() => {
    if (!open) return;
    // Re-read on open: the registration's identity lands ~2s after app
    // start (parsed from the spawn banner), so the mount-time fetch alone
    // would render the section nameless — or not at all.
    void useAppStore.getState().refreshExecutionMode();
    void window.bridge.getRemoteEnvStatus().then(setOwnRemote);
  }, [open]);

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
  // The adopted row's deviceId, resolved from the computers list by
  // connectionId — adoption picks must carry the REAL deviceId (an empty
  // one makes downstream selectors fall through to the sandbox path).
  const pickedDeviceId =
    envOverride && typeof envOverride === "object" && "deviceId" in envOverride
      ? envOverride.deviceId
      : null;
  const current =
    envOverride === null || envOverride === undefined
      ? ""
      : typeof envOverride === "string"
        ? envOverride
        : (() => {
            // A pick frozen at click time can outlive its registration
            // (adopted remote died → replacement spawned). Labels follow the
            // MACHINE: the picked connectionId when still live, else the
            // online registration on the picked deviceId — never the stale
            // name from the original pick.
            const pick = envOverride as {
              deviceId?: string;
              connectionId?: string;
              name?: string;
            };
            const byConn = pick.connectionId
              ? computers.find(
                  (c) => (c as { connectionId?: string }).connectionId === pick.connectionId,
                )
              : undefined;
            if (byConn) return byConn.name;
            const online = computers.find(
              (c) => pick.deviceId && c.deviceId === pick.deviceId && c.status === "online",
            );
            if (online) return online.name;
            return pick.name ?? "device";
          })();

  // Re-registrations can create several records for one machine; collapse
  // exact deviceId duplicates (prefer the online record).
  const dedupedComputers = computers
    .filter(
      (computer, index) =>
        computers.findIndex(
          (other) =>
            other.deviceId === computer.deviceId &&
            (other.status === "online" || other === computer),
        ) === index,
    )
    .filter((computer) => {
      // Whatever THIS MACHINE is showing — the app's own registration OR an
      // adopted external one — must not repeat in YOUR COMPUTERS.
      if (mode === "remote-env" && adoption.kind === "adopted") {
        if ((computer as { connectionId?: string }).connectionId === adoption.connectionId) {
          return false;
        }
        return computer.name !== adoption.name;
      }
      if (mode !== "remote-env" || !ownRemote?.effectiveName) return true;
      if (
        ownRemote.connectionId &&
        (computer as { connectionId?: string }).connectionId === ownRemote.connectionId
      ) {
        return false;
      }
      return computer.name !== ownRemote.effectiveName;
    });

  if (!isCloud) return null;

  const choose = (selector: ComputerSelectorField | null | undefined) => {
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
        <span className="truncate text-xs">
          {envOverride === null
            ? "Cloud sandbox"
            : current || (mode === "local" ? "This computer" : "Cloud sandbox")}
        </span>
        <ChevronDownIcon className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div className="absolute bottom-full right-0 z-50 mb-2 w-72 rounded-xl border border-border bg-surface p-1.5 shadow-elevated">
          {mode === "local" && (
            <button
              type="button"
              onClick={() => choose(undefined)}
              className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm hover:bg-surface-tertiary"
            >
              <span>This computer</span>
              <span className="ml-auto text-[10px] text-muted">app server</span>
              {effectiveIsLocalApp && <span className="text-xs text-accent">current</span>}
            </button>
          )}
          {mode === "remote-env" && adoption.kind === "adopted" && (
            <>
              <div className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted">This machine</div>
              <button
                type="button"
                onClick={() =>
                  choose({
                    deviceId: adoption.deviceId,
                    connectionId: adoption.connectionId,
                    name: adoption.name,
                  })
                }
                className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm hover:bg-surface-tertiary"
              >
                <span className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" title="online" />
                  {adoption.name}
                </span>
                <span className="ml-auto text-[10px] text-muted">adopted</span>
              </button>
            </>
          )}
          {mode === "remote-env" && adoption.kind !== "adopted" && ownRemote?.running && ownRemote.effectiveName && (
            <>
              <div className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted">This machine</div>
              <button
                type="button"
                onClick={() => {
                  // Anchor on the registration's connectionId — names dedupe
                  // with suffixes; the connectionId is exact.
                  const byConn =
                    ownRemote.connectionId
                      ? computers.find(
                          (computer) =>
                            (computer as { connectionId?: string }).connectionId ===
                            ownRemote.connectionId,
                        )
                      : undefined;
                  const match =
                    byConn ??
                    computers.find((computer) => computer.name === ownRemote.effectiveName);
                  if (match) choose({ deviceId: match.deviceId });
                }}
                className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm hover:bg-surface-tertiary"
              >
                <span className="flex items-center gap-2">
                  <span className="h-1.5 w-1.5 rounded-full bg-accent" title="online" />
                  {ownRemote.effectiveName}
                </span>
              </button>
            </>
          )}
          <div className="mt-1 border-t border-border pt-1">
            <div className="px-3 pb-0.5 pt-1 text-[10px] font-medium uppercase tracking-wide text-muted">Cloud</div>
            <button
              type="button"
              onClick={() => choose(null)}
              className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm hover:bg-surface-tertiary"
            >
              <span>Cloud sandbox</span>
              {effectiveIsSandbox && <span className="text-xs text-accent">current</span>}
            </button>
            <div className="px-3 pb-0.5 pt-2 text-[10px] font-medium uppercase tracking-wide text-muted">Your computers</div>
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
                onClick={() =>
                  choose({
                    deviceId: computer.deviceId,
                    connectionId: (computer as { connectionId?: string }).connectionId ?? "",
                    name: computer.name,
                  })
                }
                className="flex w-full items-center justify-between rounded-lg px-3 py-1.5 text-left text-sm hover:bg-surface-tertiary"
              >
                <span className="flex items-center gap-2">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${computer.status === "online" ? "bg-accent" : "bg-muted"}`}
                    title={computer.status}
                  />
                  {computer.name}
                </span>
                {((): boolean => {
                  const pickedConn =
                    envOverride && typeof envOverride === "object" && "connectionId" in envOverride
                      ? envOverride.connectionId
                      : null;
                  const rowConn = (computer as { connectionId?: string }).connectionId ?? null;
                  // Same device: only the picked CONNECTION is current.
                  if (pickedConn && rowConn) return pickedConn === rowConn;
                  return computer.deviceId === pickedDeviceId;
                })() && <span className="text-xs text-accent">current</span>}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
