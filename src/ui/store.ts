import { create } from "zustand";
import { mergeHistory, optimisticUserRow, rowIdentity, upsertRows } from "./lib/rows";
import type {
  AgentSummary,
  AgentUpdate,
  AppEvent,
  AppSettings,
  ApprovalDecision,
  ComputerSelectorField,
  ComputerSummary,
  ApprovalRequest,
  ChatRow,
  ChatTextRow,
  ConnectionState,
  ConversationSummary,
  MemoryFile,
  ModelOption,
  ProviderSummary,
  SettingsUpdate,
} from "./types";

const api = window.bridge;

/**
 * The effective execution environment for the active conversation:
 * "local-app" (private app server), "sandbox", or a computer descriptor.
 * Explicit pick wins; otherwise the execution-mode default applies.
 */
// Return values must be referentially STABLE across calls — useSyncExternalStore
// re-renders on every new object reference (getSnapshot caching contract).
// So: strings/null only; the deviceId itself is read separately where needed.
export function selectEffectiveEnvironment(state: {
  activeId: string | null;
  envOverrides: Record<string, ComputerSelectorField | null>;
  executionMode: "local" | "remote-env" | "cloud-only";
}): "local-app" | "sandbox" | "remote" {
  const key = state.activeId ?? NEW_CHAT;
  const override = key in state.envOverrides ? state.envOverrides[key] : undefined;
  if (override === null) return "sandbox";
  if (override !== undefined) return "remote"; // any explicit selector
  // No explicit pick: the mode default IS the effective environment.
  // remote-env mode's whole point is "this computer's registration" — its
  // default target is remote (the adopted/owned machine), NOT sandbox.
  // Sandbox is the default only in cloud-only mode.
  if (state.executionMode === "local") return "local-app";
  if (state.executionMode === "remote-env") return "remote";
  return "sandbox";
}

function labelForComputer(
  selector: ComputerSelectorField,
  computers: ComputerSummary[],
): string {
  const byDevice = new Map(
    computers.map((computer) => [JSON.stringify({ deviceId: computer.deviceId }), computer.name]),
  );
  const key = JSON.stringify(selector);
  const asName =
    typeof selector === "string" ? selector : selector && "name" in selector ? selector.name : null;
  return byDevice.get(key) ?? asName ?? "the selected computer";
}

/** Key for the chat that has not been sent yet. */
export const NEW_CHAT = "new";
const HISTORY_PAGE = 100;

export type ChatState = {
  rows: ChatRow[];
  loaded: boolean;
  loading: boolean;
  hasMore: boolean;
  limit: number;
  running: boolean;
  activity: string | null;
  error: string | null;
  approvals: ApprovalRequest[];
};

export type MemoryState = {
  loading: boolean;
  error: string | null;
  /** False for agents that do not use file-based memory. */
  enabled: boolean;
  files: MemoryFile[];
};

export type SettingsTab = "connection" | "providers";

const EMPTY_CHAT: ChatState = {
  rows: [],
  loaded: false,
  loading: false,
  hasMore: false,
  limit: HISTORY_PAGE,
  running: false,
  activity: null,
  error: null,
  approvals: [],
};

type AppState = {
  settings: AppSettings | null;
  connection: ConnectionState | null;
  agents: AgentSummary[];
  agentsLoaded: boolean;
  agentId: string | null;
  models: ModelOption[];
  /** App execution mode (what runs locally) — shared so every surface
   * (environment chip, pickers) reacts to Settings changes instantly. */
  executionMode: "local" | "remote-env" | "cloud-only";
  /** Working folder PER conversation PER environment (sandbox|deviceId).
   * Key: `${conversationKey}|${targetKey}` — switching environment switches
   * the effective folder instead of leaking one target's path to another. */
  envCwdOverrides: Record<string, string>;
  /** The spawn's OAuth device-flow state (remote-env mode sign-in). */
  /** Pinned conversation ids — sorted first in the sidebar. */
  pinnedConversations: string[];
  /** conversationId -> last-seen updatedAt; newer rows render unread. */
  readCursors: Record<string, number>;
  /** Handover lifecycle: disconnect detected → switching → stable. */
  remoteHandover: { phase: "stable" } | { phase: "switching"; since: number; reason: string };
  /** Live adoption state (owned vs adopted registration) — event-driven. */
  remoteAdoption:
    | { kind: "none" }
    | { kind: "adopted"; connectionId: string; name: string; deviceId: string }
    | { kind: "owned"; connectionId: string; name: string; deviceId: string };
  remoteAuth:
    | { status: "idle" }
    | { status: "pending"; url: string | null; userCode: string | null; reason: "mode-switch" | "replacement" }
    | { status: "done" }
    | { status: "failed"; error: string | null; reason: "mode-switch" | "replacement" };
  computers: ComputerSummary[];
  computersLoading: boolean;
  computersError: string | null;
  envOverrides: Record<string, ComputerSelectorField | null>;
  /** null until loaded, or when the backend manages providers itself. */
  providers: ProviderSummary[] | null;
  /** What the main area shows for the selected agent. */
  view: "chat" | "memory" | "schedules";
  memory: MemoryState | null;
  conversations: ConversationSummary[];
  conversationsLoading: boolean;
  conversationsLoaded: boolean;
  /** null is the new, unsent chat. */
  activeId: string | null;
  chats: Record<string, ChatState>;
  /** Unsent composer text per chat. */
  drafts: Record<string, string>;
  /** Working directory and model picked in the composer but not yet sent. */
  cwdOverrides: Record<string, string>;
  modelOverrides: Record<string, string>;
  /** Reasoning-effort pick per conversation (absent = model default). */
  effortOverrides: Record<string, "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">;
  /** Images staged for the next send (cleared on send). */
  stagedAttachments: import("../electron/libs/attachments.js").AttachmentView[];
  /** The first message of a new chat, shown while its conversation is created. */
  pendingFirstMessage: ChatTextRow | null;
  notice: string | null;
  settingsOpen: boolean;
  settingsTab: SettingsTab;
  newAgentOpen: boolean;
  agentSettingsOpen: boolean;

  bootstrap: () => Promise<void>;
  handleEvent: (event: AppEvent) => void;
  refreshAgents: () => Promise<void>;
  refreshModels: (force?: boolean) => Promise<void>;
  selectAgent: (agentId: string) => Promise<void>;
  createAgent: (input: { name: string; model?: string }) => Promise<void>;
  updateAgent: (update: AgentUpdate) => Promise<AgentSummary>;
  deleteAgent: () => Promise<void>;
  openChat: (conversationId: string | null) => void;
  loadHistory: (conversationId: string, limit?: number) => Promise<void>;
  send: (text: string) => Promise<void>;
  stop: () => void;
  respondApproval: (requestId: string, decision: ApprovalDecision) => void;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  archiveConversation: (conversationId: string) => Promise<void>;
  saveSettings: (update: SettingsUpdate) => Promise<void>;
  loadProviders: () => Promise<void>;
  connectProvider: (input: {
    providerId: string;
    authMethodId?: string;
    fields: Record<string, string>;
  }) => Promise<void>;
  disconnectProvider: (input: { providerId: string; providerName?: string }) => Promise<void>;
  openMemory: () => void;
  openSchedules: () => void;
  loadMemory: () => Promise<void>;
  saveMemoryFile: (path: string, content: string) => Promise<void>;
  deleteMemoryFile: (path: string) => Promise<void>;
  openSettings: (tab: SettingsTab) => void;
  reconnect: () => void;
  pickCwd: () => Promise<void>;
  setCwd: (cwd: string) => void;
  setModel: (handle: string) => void;
  setEffort: (effort: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | null) => void;
  /** Stage image attachments for the active conversation's next send. */
  pickImages: () => Promise<void>;
  refreshComputers: () => Promise<void>;
  refreshExecutionMode: () => Promise<void>;
  /** Seed adoption state from the main process (events only fire on CHANGE —
   * adoption during connect() predates the renderer's subscription). */
  refreshRemoteAdoption: () => void;
  hydrateEnvOverrides: () => void;
  refreshRemoteHandover: () => void;
  refreshPinnedConversations: () => void;
  togglePinnedConversation: (conversationId: string) => void;
  markConversationRead: (conversationId: string, updatedAt: number) => void;
  markAllRead: () => void;
  pickEnvironment: (selector: ComputerSelectorField | null | undefined) => void;
  /** Set the working folder for the ACTIVE conversation on the ACTIVE
   * environment target (remote/sandbox flows). */
  setEnvCwd: (folder: string) => void;
  setDraft: (text: string) => void;
  setNotice: (notice: string | null) => void;
  setSettingsOpen: (open: boolean) => void;
  setNewAgentOpen: (open: boolean) => void;
  setAgentSettingsOpen: (open: boolean) => void;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function patchChat(
  state: AppState,
  conversationId: string,
  patch: (chat: ChatState) => Partial<ChatState>,
): Pick<AppState, "chats"> {
  const chat = state.chats[conversationId] ?? EMPTY_CHAT;
  return { chats: { ...state.chats, [conversationId]: { ...chat, ...patch(chat) } } };
}

function upsertConversation(
  list: ConversationSummary[],
  conversation: ConversationSummary,
): ConversationSummary[] {
  return [conversation, ...list.filter((item) => item.id !== conversation.id)].sort(
    (a, b) => b.updatedAt - a.updatedAt,
  );
}

const CLEARED = {
  agents: [],
  agentsLoaded: false,
  agentId: null,
  models: [],
  executionMode: "local",
  computers: [],
  computersLoading: false,
  computersError: null,
  envOverrides: {},
  envCwdOverrides: {},
  remoteHandover: { phase: "stable" },
  pinnedConversations: [],
  readCursors: {},
  remoteAdoption: { kind: "none" },
  remoteAuth: { status: "idle" },
  providers: null,
  view: "chat",
  memory: null,
  conversations: [],
  conversationsLoading: false,
  conversationsLoaded: false,
  activeId: null,
  chats: {},
  pendingFirstMessage: null,
} satisfies Partial<AppState>;

export const useAppStore = create<AppState>((set, get) => ({
  settings: null,
  connection: null,
  ...CLEARED,
  drafts: {},
  cwdOverrides: {},
  modelOverrides: {},
  effortOverrides: {},
  stagedAttachments: [],
  notice: null,
  settingsOpen: false,
  settingsTab: "connection",
  newAgentOpen: false,
  agentSettingsOpen: false,

  bootstrap: async () => {
    const [settings, connection] = await Promise.all([api.getSettings(), api.getConnection()]);
    set({ settings });
    get().handleEvent({ type: "connection", state: connection });
  },

  handleEvent: (event) => {
    switch (event.type) {
      case "remote_handover":
        set({ remoteHandover: event.handover });
        if (event.handover.phase === "stable") void get().refreshComputers();
        return;
      case "remote_adoption":
        set({ remoteAdoption: event.adoption });
        // Every adoption rotation (adopt → owned → adopt-back) re-reads the
        // fleet list — the world changed.
        void get().refreshComputers();
        return;
      case "remote_auth":
        set({ remoteAuth: event.auth });
        return;
      case "connection": {
        const previous = get().connection;
        set({ connection: event.state });
        if (event.state.status === "ready" && previous?.status !== "ready") {
          void get().refreshAgents();
          // Conversation lists can go stale across connection cycles (mode
          // switches swap which registry serves the list). Reload alongside
          // agents on every ready transition.
          const agentId = get().agentId;
          if (agentId) {
            void api
              .listConversations(agentId)
              .then((conversations) => set({ conversations, conversationsLoaded: true }))
              .catch(() => undefined);
          }
          get().refreshRemoteAdoption();
          get().refreshRemoteHandover();
          // The fleet registry is account-level and survives connection
          // cycles — re-read it on every ready transition (handovers trigger
          // reconnects; without this the CLEARED wipe below left it empty).
          void get().refreshComputers();
          void get().refreshExecutionMode();
        } else if (event.state.status !== "ready" && previous?.status === "ready") {
          // Agents and conversations belong to the backend that just went
          // away. Computers do NOT — they're account registry data; keep the
          // last-good list across the flicker.
          const keptComputers = get().computers;
          const keptLoading = get().computersLoading;
          const keptError = get().computersError;
          set(CLEARED);
          set({
            computers: keptComputers,
            computersLoading: keptLoading,
            computersError: keptError,
          });
        }
        break;
      }
      case "turn.started":
        set((state) =>
          patchChat(state, event.conversationId, () => ({
            running: true,
            error: null,
            activity: "Starting",
          })),
        );
        break;
      case "turn.rows":
        set((state) =>
          patchChat(state, event.conversationId, (chat) => ({
            rows: upsertRows(chat.rows, event.rows),
          })),
        );
        break;
      case "turn.rows.removed": {
        const removed = new Set(event.keys);
        set((state) =>
          patchChat(state, event.conversationId, (chat) => ({
            rows: chat.rows.filter((row) => !removed.has(row.key)),
          })),
        );
        break;
      }
      case "turn.activity":
        set((state) =>
          patchChat(state, event.conversationId, () => ({ activity: event.activity })),
        );
        break;
      case "turn.finished":
        set((state) =>
          patchChat(state, event.conversationId, () => ({
            running: false,
            activity: null,
            approvals: [],
            error: event.error ?? null,
          })),
        );
        // The agent may have rewritten its memory during the turn.
        if (get().view === "memory") void get().loadMemory();
        break;
      case "approval.requested":
        set((state) =>
          patchChat(state, event.conversationId, (chat) => ({
            approvals: [
              ...chat.approvals.filter((item) => item.requestId !== event.request.requestId),
              event.request,
            ],
          })),
        );
        break;
      case "approval.resolved":
        set((state) =>
          patchChat(state, event.conversationId, (chat) => ({
            approvals: chat.approvals.filter((item) => item.requestId !== event.requestId),
          })),
        );
        break;
      case "conversation.updated": {
        // An update to the OPEN conversation is seen the moment it renders.
        if (get().activeId === event.conversation.id) {
          void window.bridge
            .markConversationRead({ conversationId: event.conversation.id, updatedAt: event.conversation.updatedAt })
            .then((cursors) => set({ readCursors: cursors }))
            .catch(() => undefined);
        }
        if (event.conversation.agentId !== get().agentId) break;
        set((state) => ({
          conversations: upsertConversation(state.conversations, event.conversation),
        }));
        break;
      }
      case "menu":
        if (event.command === "new-chat") get().openChat(null);
        else get().openSettings("connection");
        break;
    }
  },

  refreshAgents: async () => {
    try {
      const [agents, settings] = await Promise.all([api.listAgents(), api.getSettings()]);
      set({ agents, agentsLoaded: true, settings });
      void get().refreshModels();
      void get().refreshExecutionMode();
      get().refreshPinnedConversations();
      get().hydrateEnvOverrides();
      void window.bridge.getReadCursors().then((cursors) => set({ readCursors: cursors }));
      get().refreshRemoteAdoption();
      get().refreshRemoteHandover();
      const connection = get().connection;
      if (connection?.status === "ready" && connection.providers) void get().loadProviders();

      const agentId =
        agents.find((agent) => agent.id === settings.agentId)?.id ?? agents[0]?.id ?? null;
      if (agentId) await get().selectAgent(agentId);
      else {
        set({
          agentId: null,
          conversations: [],
          conversationsLoading: false, conversationsLoaded: true,
          activeId: null,
          view: "chat",
          memory: null,
        });
      }
    } catch (error) {
      set({ agentsLoaded: true, notice: errorMessage(error) });
    }
  },

  /**
   * Re-reads the model list. Provider availability changes independently of the
   * connection — a BYOK server can start long after the app — so the picker
   * refreshes on open instead of relying on the one fetch at connect time.
   * `force` bypasses the backend's availability cache (a few seconds of
   * provider probes), needed when a provider just came back up. Keeps the
   * previous list on failure; the next open retries.
   */
  refreshModels: async (force = false) => {
    try {
      set({ models: await api.listModels(force) });
    } catch {
      // A stale list beats an empty one.
    }
  },

  selectAgent: async (agentId) => {
    set({
      agentId,
      conversationsLoading: true,
      conversations: [],
      conversationsLoaded: false,
      activeId: null,
      pendingFirstMessage: null,
      view: "chat",
      memory: null,
    });
    void api
      .updateSettings({ agentId })
      .then((settings) => set({ settings }))
      .catch(() => undefined);
    try {
      // Progressive: first 25 paint immediately (cheap filter, no probes);
      // the full verified list replaces it when ready.
      const first = await api.listConversationsFirstPage(agentId);
      if (get().agentId === agentId && get().conversations.length === 0) {
        set({ conversations: first });
      }
      const conversations = await api.listConversations(agentId);
      if (get().agentId === agentId)
        set({ conversations, conversationsLoading: false, conversationsLoaded: true });
    } catch (error) {
      if (get().agentId === agentId) {
        set({ conversationsLoading: false, conversationsLoaded: true, notice: errorMessage(error) });
      }
    }
  },

  createAgent: async (input) => {
    const agent = await api.createAgent(input);
    set((state) => ({ agents: [agent, ...state.agents.filter((item) => item.id !== agent.id)] }));
    await get().selectAgent(agent.id);
  },

  // Update and delete reject on failure so the dialog can show the reason.
  updateAgent: async (update) => {
    const { agentId } = get();
    if (!agentId) throw new Error("No agent is selected.");
    const agent = await api.updateAgent(agentId, update);
    set((state) => ({
      agents: state.agents.map((item) => (item.id === agent.id ? agent : item)),
    }));
    return agent;
  },

  deleteAgent: async () => {
    const { agentId } = get();
    if (!agentId)         return;
    await api.deleteAgent(agentId);
    set({ agentSettingsOpen: false });
    // Picks another agent, or shows the "create your first agent" screen.
    await get().refreshAgents();
  },

  openChat: (conversationId) => {
    // Opening marks the conversation seen (its current state = read).
    if (conversationId) {
      const updatedAt = get().conversations.find((c) => c.id === conversationId)?.updatedAt;
      if (updatedAt) get().markConversationRead(conversationId, updatedAt);
    }
    set({ activeId: conversationId, view: "chat" });
    if (!conversationId) return;
    const chat = get().chats[conversationId];
    if (!chat?.loaded && !chat?.loading) void get().loadHistory(conversationId);
  },

  loadHistory: async (conversationId, limit) => {
    const pageSize = limit ?? get().chats[conversationId]?.limit ?? HISTORY_PAGE;
    set((state) => patchChat(state, conversationId, () => ({ loading: true, limit: pageSize })));
    try {
      const history = await api.loadHistory(conversationId, pageSize);
      set((state) =>
        patchChat(state, conversationId, (chat) => ({
          rows: mergeHistory(history.rows, chat.rows),
          loaded: true,
          loading: false,
          hasMore: history.hasMore,
          running: history.running,
          activity: history.running ? (chat.activity ?? history.activity) : null,
          approvals: history.approvals,
        })),
      );
    } catch (error) {
      set((state) =>
        patchChat(state, conversationId, () => ({
          loaded: true,
          loading: false,
          error: errorMessage(error),
        })),
      );
    }
  },

  send: async (rawText) => {
    const text = rawText.trim();
    const state = get();
    const { agentId, activeId } = state;
    if (!text || !agentId) return;
    const key = activeId ?? NEW_CHAT;
    // Mid-run sends QUEUE server-side for existing conversations (runtime
    // multiplexes the active session); only the first message is single-flight.
    if (activeId ? false : state.pendingFirstMessage) return;
    if (activeId && !state.chats[activeId]?.running) {
      // fall through — normal send path
    }

    const otid = crypto.randomUUID();
    const userRow = optimisticUserRow(text, otid);
    const cwd = selectCwd(state, key);
    const pickedModel = state.modelOverrides[key];
    const currentModel = state.conversations.find((item) => item.id === activeId)?.model;
    const model = pickedModel && pickedModel !== currentModel ? pickedModel : undefined;

    const clearComposer = (id: string) => (current: AppState) => {
      const drafts = { ...current.drafts };
      const cwdOverrides = { ...current.cwdOverrides };
      const modelOverrides = { ...current.modelOverrides };
      delete drafts[id];
      delete cwdOverrides[id];
      delete modelOverrides[id];
      return { drafts, cwdOverrides, modelOverrides };
    };

    const wasRunning = activeId ? Boolean(state.chats[activeId]?.running) : false;
    if (activeId) {
      set((current) => ({
        ...clearComposer(activeId)(current),
        ...patchChat(current, activeId, (chat) => ({
          rows: upsertRows(chat.rows, [userRow]),
          running: true,
          error: null,
          activity: "Starting",
        })),
        // Mid-run sends queue: model/effort/folder picks apply to the
        // NEXT new run (they bind at session creation), not this one.
        ...(wasRunning
          ? { notice: "Queued — model/effort/folder picks apply to the next new run." }
          : {}),
      }));
    } else {
      set((current) => ({ ...clearComposer(NEW_CHAT)(current), pendingFirstMessage: userRow }));
    }

    try {
      const pickedEnv =
      key in state.envOverrides ? state.envOverrides[key] : undefined;
    let pickedEffort = key in state.effortOverrides ? state.effortOverrides[key] : undefined;
    // The SDK rejects "max" (validator Set, 0.8.32–0.8.90) AND "xhigh" has no
    // glm catalog row (tier resolution fails server-side). Only tiers present
    // in BOTH the catalog capabilities and the SDK Set are sendable; the menu
    // filters to those. "Auto" (no effort pick) sends the model's default
    // (glm: the max row) through the no-reasoningEffort path — the honest way
    // to run glm at full reasoning today.
    if (pickedEffort === "max") pickedEffort = undefined;
      const conversation = await api.sendMessage({
        agentId,
        conversationId: activeId,
        text,
        otid,
        cwd,
        ...(model ? { model } : {}),
        // Explicit environment pick: null = cloud sandbox, object = a
        // registered computer, undefined = the mode's default (omitted).
        ...(pickedEnv !== undefined ? { computer: pickedEnv ?? undefined } : {}),
        ...(pickedEffort !== undefined ? { reasoningEffort: pickedEffort } : {}),
      });
      set((current) => ({
        conversations: upsertConversation(current.conversations, {
          ...conversation,
          model: model ?? conversation.model,
        }),
        ...(activeId
          ? {}
          : {
              // The turn may already be streaming into this conversation; the
              // first message always leads it.
              ...patchChat(current, conversation.id, (chat) => ({
                rows: upsertRows([userRow], chat.rows),
                loaded: true,
              })),
              pendingFirstMessage: null,
              activeId:
                current.pendingFirstMessage === userRow && current.activeId === null
                  ? conversation.id
                  : current.activeId,
            }),
      }));
    } catch (error) {
      // Nothing was sent: put the message back in the composer.
      set((current) => ({
        drafts: { ...current.drafts, [key]: current.drafts[key] || text },
        notice: errorMessage(error),
        ...(activeId
          ? patchChat(current, activeId, (chat) => ({
              rows: chat.rows.filter((row) => rowIdentity(row) !== rowIdentity(userRow)),
              running: false,
              activity: null,
            }))
          : { pendingFirstMessage: null }),
      }));
    }
  },

  stop: () => {
    const { activeId } = get();
    if (activeId) void api.stopTurn(activeId);
  },

  respondApproval: (requestId, decision) => {
    const { activeId } = get();
    if (!activeId) return;
    set((state) =>
      patchChat(state, activeId, (chat) => ({
        approvals: chat.approvals.filter((item) => item.requestId !== requestId),
      })),
    );
    void api.respondApproval(activeId, requestId, decision);
  },

  renameConversation: async (conversationId, title) => {
    try {
      const conversation = await api.renameConversation(conversationId, title);
      set((state) => ({
        conversations: state.conversations.map((item) =>
          item.id === conversationId ? { ...item, title: conversation.title } : item,
        ),
      }));
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  archiveConversation: async (conversationId) => {
    try {
      await api.archiveConversation(conversationId);
      set((state) => {
        const chats = { ...state.chats };
        delete chats[conversationId];
        return {
          chats,
          conversations: state.conversations.filter((item) => item.id !== conversationId),
          activeId: state.activeId === conversationId ? null : state.activeId,
        };
      });
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  saveSettings: async (update) => {
    set({ settings: await api.updateSettings(update) });
    // Mode may have been applied by the dialog alongside these settings.
    void get().refreshExecutionMode();
  },

  loadProviders: async () => {
    try {
      set({ providers: await api.listProviders() });
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  // Connect and disconnect reject on failure so the form can show the reason.
  connectProvider: async (input) => {
    set({ providers: await api.connectProvider(input) });
    set({ models: await api.listModels(true) });
  },

  disconnectProvider: async (input) => {
    set({ providers: await api.disconnectProvider(input) });
    set({ models: await api.listModels(true) });
  },

  openMemory: () => {
    set({ view: "memory" });
  },

  openSchedules: () => {
    set({ view: "schedules" });
    void get().loadMemory();
  },

  loadMemory: async () => {
    const { agentId } = get();
    if (!agentId) return;
    set((state) => ({
      memory: { ...(state.memory ?? { enabled: true, files: [] }), loading: true, error: null },
    }));
    try {
      const overview = await api.listMemory(agentId);
      if (get().agentId === agentId) set({ memory: { ...overview, loading: false, error: null } });
    } catch (error) {
      if (get().agentId !== agentId) return;
      set((state) => ({
        memory: {
          enabled: state.memory?.enabled ?? true,
          files: state.memory?.files ?? [],
          loading: false,
          error: errorMessage(error),
        },
      }));
    }
  },

  saveMemoryFile: async (path, content) => {
    const { agentId } = get();
    if (!agentId) return;
    await api.writeMemoryFile(agentId, path, content);
    await get().loadMemory();
  },

  deleteMemoryFile: async (path) => {
    const { agentId } = get();
    if (!agentId) return;
    await api.deleteMemoryFile(agentId, path);
    await get().loadMemory();
  },

  openSettings: (tab) => set({ settingsOpen: true, settingsTab: tab }),

  reconnect: () => {
    void api.reconnect();
  },

  pickCwd: async () => {
    const directory = await api.selectDirectory();
    if (directory) get().setCwd(directory);
  },

  setCwd: (cwd) =>
    set((state) => ({
      cwdOverrides: { ...state.cwdOverrides, [state.activeId ?? NEW_CHAT]: cwd },
    })),

  markConversationRead: (conversationId: string, updatedAt: number) => {
    void window.bridge
      .markConversationRead({ conversationId, updatedAt })
      .then((cursors) => set({ readCursors: cursors }));
  },

  markAllRead: () => {
    const items = get().conversations.map((c) => ({ conversationId: c.id, updatedAt: c.updatedAt }));
    if (items.length === 0) return;
    void window.bridge
      .markAllConversationsRead({ items })
      .then((cursors) => set({ readCursors: cursors }));
  },

  togglePinnedConversation: (conversationId: string) => {
    void window.bridge
      .togglePinnedConversation({ conversationId })
      .then((pins) => set({ pinnedConversations: pins }));
  },

  refreshPinnedConversations: () => {
    void window.bridge.getPinnedConversations().then((pins) => {
      set({ pinnedConversations: pins });
    });
  },

  refreshRemoteHandover: () => {
    void window.bridge.getRemoteHandover().then((handover) => {
      set({ remoteHandover: handover });
    });
  },

  /** Hydrate persisted per-conversation env picks from settings (the store
   * starts empty; without this every restart fell to mode-default targets). */
  hydrateEnvOverrides: () => {
    void window.bridge
      .getAllConversationEnvs()
      .then((all) => {
        // The NEW_CHAT key's null (an old explicit-sandbox click) must not
        // pin every future chat to sandbox — drop it so the mode default
        // (remote-env = this computer) rules new chats. Conversation-nulls
        // stay: they were deliberate per-chat picks.
        const envOverrides = { ...all };
        if (envOverrides[NEW_CHAT] === null) delete envOverrides[NEW_CHAT];
        set({ envOverrides });
      })
      .catch(() => undefined);
  },

  refreshRemoteAdoption: () => {
    void window.bridge.getRemoteAdoption().then((adoption) => {
      set({ remoteAdoption: adoption });
    });
  },

  refreshExecutionMode: async () => {
    try {
      set({ executionMode: await api.getExecutionMode() });
    } catch {
      // keep current
    }
  },

  refreshComputers: async () => {
    set({ computersLoading: true, computersError: null });
    try {
      const list = await api.listComputers();
      set({ computers: list, computersLoading: false });
    } catch (error) {
      // A failed re-read must NOT clobber the last good list (a transient
      // error during handover races used to blank YOUR COMPUTERS).
      set({ computersLoading: false, computersError: errorMessage(error) });
    }
  },

  pickEnvironment: (selector) => {
    const key = get().activeId ?? NEW_CHAT;
    if (key !== NEW_CHAT && get().chats[key]?.running) {
      set({ notice: "Wait for the current run to finish before changing the environment." });
      return;
    }
    if (key !== NEW_CHAT) {
      void api.setConversationEnv({ conversationId: key, selector }).catch((error) => {
        set({ notice: errorMessage(error) });
      });
    }
    // undefined = inherit the mode default ("This computer" in private mode):
    // CLEAR the override rather than writing a value.
    set((state) => {
      const envOverrides = { ...state.envOverrides };
      if (selector === undefined) delete envOverrides[key];
      else envOverrides[key] = selector;
      return {
        envOverrides,
        notice:
          selector === undefined
            ? "Runs in this conversation now use this computer's app server."
            : `Runs in this conversation now use ${selector ? labelForComputer(selector, state.computers) : "the cloud sandbox"}.`,
      };
    });
  },

  setEnvCwd: (folder) => {
    set((state) => {
      const key = state.activeId ?? NEW_CHAT;
      const target = targetKeyFor(state);
      return { envCwdOverrides: { ...state.envCwdOverrides, [`${key}|${target}`]: folder } };
    });
  },

  setModel: (handle) =>
    set((state) => ({
      modelOverrides: { ...state.modelOverrides, [state.activeId ?? NEW_CHAT]: handle },
    })),

  pickImages: async () => {
    try {
      const { attachments, skipped } = await api.selectImages();
      if (skipped.length > 0) set({ notice: skipped.join("\n") });
      if (attachments.length > 0) {
        set((state) => ({
          stagedAttachments: [...state.stagedAttachments, ...attachments].slice(0, 4),
        }));
      }
    } catch (error) {
      set({ notice: errorMessage(error) });
    }
  },

  setEffort: (effort) =>
    set((state) => {
      const effortOverrides = { ...state.effortOverrides };
      const key = state.activeId ?? NEW_CHAT;
      // null clears the pick (model default); a value sets it.
      if (effort === null) delete effortOverrides[key];
      else effortOverrides[key] = effort;
      return { effortOverrides };
    }),

  setDraft: (text) =>
    set((state) => ({ drafts: { ...state.drafts, [state.activeId ?? NEW_CHAT]: text } })),

  setNotice: (notice) => set({ notice }),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setNewAgentOpen: (newAgentOpen) => set({ newAgentOpen }),
  setAgentSettingsOpen: (agentSettingsOpen) => set({ agentSettingsOpen }),
}));

// --- Selectors --------------------------------------------------------------

type Selectable = Pick<
  AppState,
  | "settings"
  | "conversations"
  | "cwdOverrides"
  | "envCwdOverrides"
  | "envOverrides"
  | "executionMode"
  | "activeId"
  | "modelOverrides"
  | "agents"
  | "agentId"
>;

/** Working directory the next message in a chat will run in. */
export function targetKeyFor(state: {
  activeId?: string | null;
  envOverrides?: Record<string, ComputerSelectorField | null>;
  executionMode?: "local" | "remote-env" | "cloud-only";
} & Record<string, unknown>): string {
  const activeId = state.activeId ?? null;
  const overrides = state.envOverrides ?? {};
  const mode = state.executionMode ?? "local";
  const key = activeId ?? NEW_CHAT;
  const override = key in overrides ? overrides[key] : undefined;
  if (override === null) return "sandbox";
  if (override !== undefined && typeof override === "object" && "deviceId" in override && override.deviceId) {
    return String(override.deviceId);
  }
  if (override !== undefined) return "remote";
  // No explicit pick: mirror selectEffectiveEnvironment — remote-env's
  // default is this computer's registration, not sandbox.
  if (mode === "remote-env") return "remote";
  return mode === "local" ? "local" : "sandbox";
}

/**
 * Reasoning tiers for a model handle: LIVE catalog capabilities first
 * (reasoning_capabilities.supported_efforts — populated Nov 18 after probing
 * null since Nov 16; the derived table below was wrong in both directions:
 * medium unsupported for glm, max missing). The table remains only as a
 * fallback for rows whose capabilities field is still null.
 */
export function supportedEffortsFor(
  handle: string | null | undefined,
  models?: { handle: string; efforts: string[] | null }[],
): string[] {
  const ALL = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (!handle) return ALL;
  // Live: exact-handle match wins; same-handle-prefix rows share capabilities.
  const SDK_SENDABLE = ["none", "minimal", "low", "medium", "high", "xhigh"];
  const live = models?.find((m) => m.handle === handle)?.efforts;
  if (live && live.length > 0) {
    // Intersect: catalog-supported AND SDK-sendable. max is catalog-valid but
    // the SDK validator rejects it; a tier without a catalog row fails
    // server-side resolution. Auto (undefined) reaches the model default.
    const sendable = live.filter((e) => SDK_SENDABLE.includes(e));
    return sendable.length > 0 ? sendable : live;
  }
  // Fallback table (derived; used only while the catalog field is null).
  const provider = handle.split("/")[0] ?? "";
  const table: Record<string, string[]> = {
    zai: ["low", "high", "max"],
    "z-ai": ["low", "high", "max"],
    "lc-zai-coding": ["low", "high", "max"],
    openai: ["none", "minimal", "low", "medium", "high"],
    anthropic: ["low", "medium", "high"],
    google: ["low", "medium", "high"],
    deepseek: ["low", "medium", "high"],
  };
  // The fallback is as honest as the live path: filter through the sendable
  // set too — a menu tier that silently no-ops at send is a fake mapping
  // with a label (Uncia finding 3).
  return (table[provider] ?? ALL).filter((e) => SDK_SENDABLE.includes(e));
}

/** The folder the NEXT message uses: environment-scoped pick first, else the
 * legacy conversation cwd (local/default flows), else recent. */
export function selectEffectiveCwd(state: Selectable, key: string): string {
  const target = targetKeyFor(state);
  const envScoped = state.envCwdOverrides?.[`${key}|${target}`];
  if (envScoped) return envScoped;
  // Local/default environments keep the conversation cwd semantics.
  if (target === "local") {
    return (
      state.cwdOverrides[key] ??
      state.conversations.find((item) => item.id === key)?.cwd ??
      state.settings?.recentCwds[0] ??
      state.settings?.defaultCwd ??
      ""
    );
  }
  // Remote/sandbox with no pick yet: empty — the session uses the target's
  // own default (boot_working_directory), NOT another environment's path.
  return "";
}

export function selectCwd(state: Selectable, key: string): string {
  return selectEffectiveCwd(state, key);
}

/** Model the next message in a chat will use. */
export function selectModel(state: Selectable, key: string): string | null {
  return (
    state.modelOverrides[key] ??
    state.conversations.find((item) => item.id === key)?.model ??
    state.agents.find((agent) => agent.id === state.agentId)?.model ??
    null
  );
}

export { EMPTY_CHAT };
