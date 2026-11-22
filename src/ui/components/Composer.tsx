import { useEffect, useLayoutEffect, useRef, useState } from "react";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { folderName, shortPath } from "../lib/format";
import { NEW_CHAT, selectCwd, selectEffectiveEnvironment, selectModel, supportedEffortsFor, targetKeyFor, useAppStore } from "../store";
import type { PermissionMode } from "../types";
import { EnvironmentPicker } from "./EnvironmentPicker";
import { ModelPicker } from "./ModelPicker";
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, FolderIcon, ShieldIcon, Spinner, StopIcon } from "./icons";

const MAX_HEIGHT = 240;
// A stable reference: a selector must not return a fresh array on every call.
const NO_FOLDERS: string[] = [];

const PERMISSION_MODES: Array<{ mode: PermissionMode; label: string; detail: string }> = [
  { mode: "standard", label: "Ask first", detail: "Asks before running commands or editing files" },
  { mode: "acceptEdits", label: "Accept edits", detail: "Edits files freely, asks before commands" },
  { mode: "unrestricted", label: "Full access", detail: "Runs everything without asking" },
];

const menuContent =
  "z-50 min-w-[240px] rounded-xl border border-border bg-surface p-1 shadow-elevated";
const menuItem =
  "flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm text-ink-800 outline-none data-[highlighted]:bg-surface-tertiary";

function FolderMenu({ cwd }: { cwd: string }) {
  // Hooks must run before ANY conditional return — the environment pick
  // changes between renders, and an early return would change the hook
  // count and crash the tree ("Rendered fewer hooks than expected").
  const effectiveEnv = useAppStore(selectEffectiveEnvironment);
  const recentCwds = useAppStore((state) => state.settings?.recentCwds ?? NO_FOLDERS);
  const setCwd = useAppStore((state) => state.setCwd);
  const pickCwd = useAppStore((state) => state.pickCwd);
  const setEnvCwd = useAppStore((state) => state.setEnvCwd);

  const [browsing, setBrowsing] = useState(false);
  const activeId = useAppStore((state) => state.activeId);
  const envOverride = useAppStore((state) =>
    activeId ? state.envOverrides[activeId] : state.envOverrides[NEW_CHAT],
  );


  // Per-target folder: remembered pick, else the target's discovered default.
  // The label mirrors what the session will actually use.
  const targetDeviceId =
    envOverride && typeof envOverride === "object" && "deviceId" in envOverride
      ? envOverride.deviceId
      : null;
  const targetKey = useAppStore(targetKeyFor);
  const [targetFolder, setTargetFolder] = useState<string | null>(null);
  const [folderResolving, setFolderResolving] = useState(false);
  useEffect(() => {
    if (effectiveEnv !== "sandbox" && effectiveEnv !== "remote") return;
    // Retry timers die with the effect (navigation unmount) — no zombie retries.
    const pendingTimers: ReturnType<typeof setTimeout>[] = [];
    const originalSetTimeout = setTimeout;
    const scopedSetTimeout = ((fn: () => void, ms?: number) => {
      const id = originalSetTimeout(fn, ms);
      pendingTimers.push(id);
      return id;
    }) as typeof setTimeout;
    // Target changed: clear immediately — never show the previous target's
    // folder while this one resolves.
    setTargetFolder(null);
    setFolderResolving(true);
    // 10s timeout: a websocket to a dead lease can hang the chain forever,
    // freezing the chip at "Remote". Losing the race = retry next open.
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000));
    const resolvedRef = { done: false };
    try {
    // The FIRST bridge call is guarded too: every layer of this chain has
    // produced 'reading catch' at one time or another — nothing gets to
    // throw uncaught, and nothing gets to be undefined-then-chained.
    const rememberedP = window.bridge.getTargetFolder({ targetKey });
    void Promise.race([
      Promise.resolve(rememberedP)
        .then((remembered) => {
          if (remembered) {
            resolvedRef.done = true;
            setTargetFolder(remembered);
            return;
          }
          // No remembered pick: discover the target's own default. In
          // remote-env mode the default target IS this machine's registration —
          // null would fall to the sandbox transport (credit-walled).
          // Guarded like the retry: HMR/module-reload can hand back a torn
          // bridge binding (undefined) — treat as failure, not a crash, and
          // let the retry loop carry it.
          const pendingPrimary = window.bridge.getDefaultDirectory({
            selector: targetDeviceId
              ? { deviceId: targetDeviceId }
              : effectiveEnv === "remote"
                ? "remote-default"
                : null,
          });
          if (!pendingPrimary || typeof pendingPrimary.then !== "function") {
            console.warn("[chip] discovery bridge unavailable (module reload?)");
            setTargetFolder(null);
            return;
          }
          return pendingPrimary
            .then((def) => {
              setTargetFolder(def);
            })
            .catch((error) => {
              console.warn("[chip] discovery failed:", String(error).slice(0, 200));
              setTargetFolder(null);
            });
        })
        .catch((error) => {
          console.warn("[chip] folder-chain failed:", String(error).slice(0, 200));
          setTargetFolder(null);
        }),
      timeout,
    ]).finally(() => {
      setFolderResolving(false);
      // Boot-race self-heal: 'registration not up yet' fails once at startup
      // and without a retry the chip stays 'Remote' forever. Retry with
      // backoff until a folder resolves (bounded: 5 tries, 2s→16s).
      // resolvedRef guards against the stale-closure targetFolder check.
      {
        let attempt = 0;
        const retry = () => {
          attempt += 1;
          if (attempt > 5 || resolvedRef.done) return;
          scopedSetTimeout(() => {
            // Whole retry body guarded: a synchronous throw anywhere in the
            // chain (bridge gone mid-navigation, etc.) must not kill the loop.
            try {
              const pending = window.bridge.getDefaultDirectory({
                selector: targetDeviceId
                  ? { deviceId: targetDeviceId }
                  : effectiveEnv === "remote"
                    ? "remote-default"
                    : null,
              });
              if (pending && typeof pending.then === "function") {
                void pending
                  .then((def) => {
                    if (def) {
                      resolvedRef.done = true;
                      setTargetFolder(def);
                    } else retry();
                  })
                  .catch(() => retry());
              } else {
                retry();
              }
            } catch {
              retry();
            }
          }, Math.min(2000 * 2 ** (attempt - 1), 16000));
        };
        retry();
      }
    });
    } catch (fatal) {
      console.warn("[chip] discovery chain crashed:", String(fatal).slice(0, 200));
      setFolderResolving(false);
    }
    return () => {
      for (const id of pendingTimers) clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveEnv, targetKey]);

  // Resolve the browse target: explicit pick → computer/sandbox.
  const selector =
    effectiveEnv === "sandbox"
      ? null
      : (() => {
          if (!envOverride || typeof envOverride !== "object" || !("deviceId" in envOverride)) {
            return null;
          }
          return envOverride;
        })();

  if (effectiveEnv === "sandbox" || effectiveEnv === "remote") {
    return (
      <>
        <button
          type="button"
          className="chip"
          title={
            effectiveEnv === "sandbox"
              ? "Browse the cloud sandbox filesystem (one quick turn per folder)"
              : "Browse the remote computer's filesystem (one quick turn per folder)"
          }
          onClick={() => setBrowsing(true)}
        >
          <FolderIcon className="h-3.5 w-3.5 shrink-0" />
          <span className="truncate text-xs">
            {folderResolving && !targetFolder ? (
              <span className="flex items-center gap-1.5 text-muted">
                <Spinner className="h-3 w-3" />
                Loading
              </span>
            ) : targetFolder ? (
              shortPath(targetFolder)
            ) : effectiveEnv === "sandbox" ? (
              "Sandbox"
            ) : (
              "Remote"
            )}
          </span>
          <ChevronDownIcon className="h-3 w-3 shrink-0" />
        </button>
        {browsing && (
          <RemoteBrowseDialog
            selector={selector}
            startPath={cwd}
            onChoose={(path) => {
              // Per-environment folder: switching targets never leaks this
              // path into another environment's session.
              setEnvCwd(path);
              setTargetFolder(path);
              void window.bridge
                .setTargetFolder({ targetKey, folder: path })
                .catch(() => undefined);
              setBrowsing(false);
            }}
            onClose={() => setBrowsing(false)}
          />
        )}
      </>
    );
  }
  void cwd;
  const others = recentCwds.filter((path) => path !== cwd);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="chip" title={`Working folder: ${cwd}`}>
        <FolderIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{folderName(cwd) || "Choose folder"}</span>
        <ChevronDownIcon className="h-3 w-3 shrink-0" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={menuContent} side="top" align="start" sideOffset={8}>
          <DropdownMenu.Label className="px-3 pb-1 pt-2 text-xs text-muted">
            The agent works in this folder
          </DropdownMenu.Label>
          <DropdownMenu.Item className={menuItem} disabled>
            <CheckIcon className="h-4 w-4 shrink-0 text-accent" />
            <span className="truncate font-mono text-xs">{shortPath(cwd)}</span>
          </DropdownMenu.Item>
          {others.map((path) => (
            <DropdownMenu.Item key={path} className={menuItem} onSelect={() => setCwd(path)}>
              <span className="w-4 shrink-0" />
              <span className="truncate font-mono text-xs" title={path}>
                {shortPath(path)}
              </span>
            </DropdownMenu.Item>
          ))}
          <DropdownMenu.Separator className="my-1 h-px bg-border" />
          <DropdownMenu.Item className={menuItem} onSelect={() => void pickCwd()}>
            <FolderIcon className="h-4 w-4 shrink-0 text-muted" />
            Choose folder...
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

const EFFORT_TIERS: Array<{
  effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  label: string;
  detail: string;
}> = [
  { effort: "none", label: "None", detail: "No reasoning — direct answers" },
  { effort: "minimal", label: "Minimal", detail: "Brief thinking, fastest" },
  { effort: "low", label: "Low", detail: "Light reasoning" },
  { effort: "medium", label: "Medium", detail: "Balanced reasoning" },
  { effort: "high", label: "High", detail: "Deep reasoning" },
  { effort: "xhigh", label: "X-high", detail: "Extended reasoning" },
  { effort: "max", label: "Max", detail: "Maximum reasoning — slowest" },
];


/** Grey bar above the prompt input: N monitors on this conversation;
 *  click expands to descriptions. Polls 15s while visible. */
function MonitorBar() {
  const activeId = useAppStore((state) => state.activeId);
  const [monitors, setMonitors] = useState<
    Array<{ id: string; description: string | null; status: string | null; kind: string | null }>
  >([]);
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!activeId) {
      setMonitors([]);
      return;
    }
    let cancelled = false;
    const poll = () => {
      window.bridge
        .listMonitors({ conversationId: activeId })
        .then((rows) => {
          if (!cancelled) {
            setMonitors(rows);
            setFailed(false);
          }
        })
        .catch(() => {
          if (!cancelled) setFailed(true);
        });
    };
    poll();
    const timer = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [activeId]);

  if (!activeId || (monitors.length === 0 && !failed)) return null;

  return (
    <div className="mx-2 mb-1.5 rounded-lg border border-border bg-surface-tertiary px-3 py-1.5 text-xs text-muted">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center gap-1.5 text-left"
      >
        <span className="font-medium">{monitors.length} monitor{monitors.length === 1 ? "" : "s"}</span>
        <span className="text-muted-light">
          {monitors.filter((m) => m.status === "running").length} running
        </span>
        <span className="ml-auto text-muted-light">{expanded ? "Hide" : "Show"}</span>
      </button>
      {expanded && (
        <ul className="mt-1.5 space-y-1 border-t border-border pt-1.5">
          {monitors.map((m) => (
            <li key={m.id} className="flex items-baseline gap-2">
              <span
                className={
                  m.status === "running" ? "text-accent" : m.status === "failed" ? "text-error" : "text-muted"
                }
              >
                {m.status ?? "unknown"}
              </span>
              <span className="min-w-0 flex-1 truncate" title={m.description ?? ""}>
                {m.description ?? m.id}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EffortMenu() {
  // The model's catalog default effort, when published — surfaces what Auto
  // means for THIS model (e.g. glm: Auto IS max reasoning).
  const defaultEffortRaw = useAppStore((state) => {
    const activeId2 = state.activeId;
    // Model resolution order mirrors the send path: conversation override →
    // conversation model → NEW_CHAT override → the AGENT's default model.
    // Without the agent fallback, new chats (no model anywhere yet) showed
    // plain "Auto" instead of "Auto (max)".
    const handle =
      (activeId2
        ? state.modelOverrides[activeId2] ??
          state.conversations.find((item) => item.id === activeId2)?.model
        : state.modelOverrides[NEW_CHAT]) ??
      state.agents.find((a) => a.id === state.agentId)?.model ??
      null;
    const row = state.models.find((m) => m.handle === handle);
    return row?.defaultEffort ?? null;
  });
  const defaultEffortLabel = defaultEffortRaw ?? "";
  const activeId = useAppStore((state) => state.activeId);
  const models = useAppStore((state) => state.models);
  const modelHandle = useAppStore((state) =>
    activeId
      ? state.modelOverrides[activeId] ??
        state.conversations.find((item) => item.id === activeId)?.model
      : state.modelOverrides[NEW_CHAT],
  );
  const effort = useAppStore((state) =>
    activeId ? state.effortOverrides[activeId] : state.effortOverrides[NEW_CHAT],
  );
  const setEffort = useAppStore((state) => state.setEffort);
  const label = effort ? (EFFORT_TIERS.find((t) => t.effort === effort)?.label ?? effort) : "Auto";

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="chip" title="How hard the model thinks before answering">
        <span className="truncate text-xs">{label}</span>
        <ChevronDownIcon className="h-3 w-3 shrink-0" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={menuContent} side="top" align="start" sideOffset={8}>
          <DropdownMenu.Label className="px-3 pb-1 pt-2 text-xs text-muted">
            Thinking effort
          </DropdownMenu.Label>
          <DropdownMenu.Item
            className={menuItem}
            onSelect={() => setEffort(null)}
          >
            <span className="w-4 shrink-0">{effort === undefined ? <CheckIcon className="h-4 w-4 text-accent" /> : null}</span>
            <span>
              <span className="block">
                Auto{defaultEffortLabel ? ` (${defaultEffortLabel})` : ""}
              </span>
              <span className="block text-xs text-muted">
                {defaultEffortLabel
                  ? `The model's default effort — ${defaultEffortLabel}`
                  : "Model default"}
              </span>
            </span>
          </DropdownMenu.Item>
          {EFFORT_TIERS.filter((tier) => supportedEffortsFor(modelHandle, models).includes(tier.effort)).map((tier) => (
            <DropdownMenu.Item
              key={tier.effort}
              className={menuItem}
              onSelect={() => setEffort(tier.effort)}
            >
              <span className="w-4 shrink-0">{effort === tier.effort ? <CheckIcon className="h-4 w-4 text-accent" /> : null}</span>
              <span>
                <span className="block">{tier.label}</span>
                <span className="block text-xs text-muted">{tier.detail}</span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function PermissionMenu() {
  const current = useAppStore((state) => state.settings?.permissionMode ?? "standard");
  const saveSettings = useAppStore((state) => state.saveSettings);
  const label = PERMISSION_MODES.find((item) => item.mode === current)?.label ?? current;

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="chip" title="What the agent may do without asking">
        <ShieldIcon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
        <ChevronDownIcon className="h-3 w-3 shrink-0" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={menuContent} side="top" align="start" sideOffset={8}>
          {PERMISSION_MODES.map((item) => (
            <DropdownMenu.Item
              key={item.mode}
              className={menuItem}
              onSelect={() => void saveSettings({ permissionMode: item.mode })}
            >
              <span className="w-4 shrink-0">
                {item.mode === current && <CheckIcon className="h-4 w-4 text-accent" />}
              </span>
              <span>
                <span className="block">{item.label}</span>
                <span className="block text-xs text-muted">{item.detail}</span>
              </span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function Composer({ disabled }: { disabled: boolean }) {
  const pickImages = useAppStore((state) => state.pickImages);
  const stagedAttachments = useAppStore((state) => state.stagedAttachments);
  const activeId = useAppStore((state) => state.activeId);
  const key = activeId ?? NEW_CHAT;
  const draft = useAppStore((state) => state.drafts[key] ?? "");
  const running = useAppStore((state) =>
    activeId ? (state.chats[activeId]?.running ?? false) : state.pendingFirstMessage !== null,
  );
  const cwd = useAppStore((state) => selectCwd(state, key));
  const model = useAppStore((state) => selectModel(state, key));
  const models = useAppStore((state) => state.models);
  const setDraft = useAppStore((state) => state.setDraft);
  const setModel = useAppStore((state) => state.setModel);
  const send = useAppStore((state) => state.send);
  const stop = useAppStore((state) => state.stop);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, MAX_HEIGHT)}px`;
    input.style.overflowY = input.scrollHeight > MAX_HEIGHT ? "auto" : "hidden";
  }, [draft]);

  useEffect(() => {
    if (!disabled) inputRef.current?.focus();
  }, [key, disabled]);

  // Queueing: mid-run sends on an EXISTING conversation multiplex onto the
  // live session (server-side queue) — the composer must not block them.
  // First-message chats stay single-flight (pendingFirstMessage gate in send).
  const isExistingChat = activeId !== null;
  const canSend = !disabled && draft.trim().length > 0 && (isExistingChat || !running);

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pb-5">
      <div className="rounded-2xl border border-border bg-surface shadow-card transition-colors focus-within:border-border-hover">
        {stagedAttachments.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {stagedAttachments.map((attachment) => (
              <span
                key={attachment.id}
                className="flex items-center gap-1 rounded-lg border border-border bg-surface-tertiary px-2 py-1 text-xs"
              >
                <span className="truncate max-w-32">{attachment.name}</span>
                <span className="text-muted">{attachment.width}×{attachment.height}</span>
              </span>
            ))}
          </div>
        )}
        <MonitorBar />
                <textarea
          ref={inputRef}
          rows={1}
          value={draft}
          disabled={disabled}
          placeholder={disabled ? "Connect to Letta to start" : "Ask your agent to do something"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            // Enter sends; Shift+Enter and IME composition insert a newline.
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
            event.preventDefault();
            if (canSend) void send(draft);
          }}
          className="block w-full resize-none bg-transparent px-4 pt-3.5 text-[15px] leading-relaxed text-ink-900 placeholder:text-muted focus:outline-none disabled:cursor-not-allowed"
        />
        <div className="flex items-center gap-1.5 px-2.5 pb-2.5 pt-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <FolderMenu cwd={cwd} />
            <EnvironmentPicker />
            <ModelPicker value={model} models={models} onChange={setModel} className="min-w-0" />
            <EffortMenu />
            <PermissionMenu />
            <button
              type="button"
              className="chip"
              title="Attach images"
              onClick={() => void pickImages()}
            >
              <span className="text-xs">📎</span>
            </button>
          </div>
          {running && activeId ? (
            <button
              type="button"
              onClick={stop}
              aria-label="Stop"
              title="Stop"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ink-900 text-surface hover:opacity-80 transition-opacity"
            >
              <StopIcon className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send(draft)}
              disabled={!canSend}
              aria-label="Send"
              title="Send (Enter)"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-brand-content transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-30"
            >
              <ArrowUpIcon className="h-4 w-4" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Remote/sandbox directory browser. Listings speak the list_in_directory
 * protocol directly over the target's transport — instant, creates nothing.
 */
function RemoteBrowseDialog({
  selector,
  startPath,
  onChoose,
  onClose,
}: {
  selector: { deviceId: string } | null;
  startPath: string | null;
  onChoose: (path: string) => void;
  onClose: () => void;
}) {
  const [path, setPath] = useState("/"); // replaced on mount by conversation cwd

  const [entries, setEntries] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [directoriesLoaded, setDirectoriesLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = (next: string) => {
    setPath(next);
    setLoading(true);
    setError(null);
    void window.bridge
      .listRemoteDirectory({ selector, path: next })
      .then((dirs) => {
        setEntries(dirs);
        setDirectoriesLoaded(true);
      })
      .catch((failure) => {
        setError(failure instanceof Error ? failure.message : String(failure));
      })
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    // Open where the conversation already is. If that folder doesn't exist
    // on this target (e.g. a local default path on a phone), fall back to /.
    const start = startPath && startPath.startsWith("/") ? startPath : "/";
    void window.bridge
      .listRemoteDirectory({ selector, path: start })
      .then((dirs) => {
        setPath(start);
        setEntries(dirs);
        setLoading(false);
      })
      .catch(() => {
        if (start !== "/") {
          load("/");
        } else {
          setError("Could not list the target's root directory.");
          setLoading(false);
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
      <div className="w-[28rem] rounded-2xl border border-border bg-surface p-4 shadow-elevated">
        <div className="mb-2 flex items-center justify-between">
          <span className="font-mono text-sm text-ink-900">{path}</span>
          <button type="button" className="text-muted hover:text-ink-900" onClick={onClose}>
            ✕
          </button>
        </div>
        <div className="max-h-64 overflow-y-auto rounded-lg border border-border">
          {loading && (
            <div className="flex items-center gap-2 px-3 py-2 text-sm text-muted">
              <Spinner className="h-3 w-3" /> Listing…
            </div>
          )}
          {error && <div className="px-3 py-2 text-sm text-error">{error}</div>}
          {!loading &&
            !error &&
            entries.map((entry) => (
              <button
                key={entry}
                type="button"
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-tertiary"
                onClick={() => load(path === "/" ? `/${entry}` : `${path}/${entry}`)}
              >
                📁 {entry}
              </button>
            ))}
          {!loading && !error && !directoriesLoaded && (
            <div className="px-3 py-2 text-sm text-muted">Loading…</div>
          )}
          {!loading && !error && directoriesLoaded && entries.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted">No subdirectories.</div>
          )}
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            className="button-secondary"
            disabled={path === "/"}
            onClick={() => load(path.split("/").slice(0, -1).join("/") || "/")}
          >
            Up
          </button>
          <span className="flex-1" />
          <button type="button" className="button-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="button-primary" onClick={() => onChoose(path)}>
            Choose this folder
          </button>
        </div>
      </div>
    </div>
  );
}
