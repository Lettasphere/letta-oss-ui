/**
 * The contract between the Electron main process and the renderer.
 * Types only - the renderer imports this file with `import type`.
 */

import type { PermissionMode } from "@letta-ai/letta-agent-sdk";

export type { PermissionMode };

/**
 * Where agents live and where their tools run:
 * - local:  agents stored on this machine, tools run on this machine
 * - cloud:  agents stored in Letta Cloud, tools run on this machine
 * - remote: a self-hosted Letta app server owns both
 */
export type BackendKind = "local" | "cloud" | "remote";

export type AppSettings = {
  backend: BackendKind;
  serverUrl: string;
  apiBaseUrl: string;
  /** Secrets never leave the main process; the renderer only learns whether one is set. */
  hasApiKey: boolean;
  hasServerToken: boolean;
  permissionMode: PermissionMode;
  /** Agent selected for the current backend. */
  agentId: string | null;
  recentCwds: string[];
  defaultCwd: string;
};

export type SettingsUpdate = {
  backend?: BackendKind;
  serverUrl?: string;
  apiBaseUrl?: string;
  /** A string replaces the saved secret, null clears it, undefined keeps it. */
  apiKey?: string | null;
  serverToken?: string | null;
  permissionMode?: PermissionMode;
  agentId?: string | null;
};

import type { ComputerSummary, ComputerSelectorField, ConversationEnv } from "./libs/env.js";
export type { ComputerSummary, ComputerSelectorField, ConversationEnv };
/** A saved connection: a named snapshot of the flat connection settings. */
export type SavedConnection = {
  id: string;
  name: string;
  backend: BackendKind;
  apiBaseUrl?: string;
  serverUrl?: string;
  /** Unix ms of the last switch to this connection (most-recent sorts first). */
  usedAt: number;
};

export type ConnectionState =
  | { status: "connecting"; backend: BackendKind }
  | {
      status: "ready";
      backend: BackendKind;
      detail: string;
      /** True when the server keeps its own model provider keys (the local backend). */
      providers: boolean;
    }
  | { status: "error"; backend: BackendKind; error: string };

export type AgentSummary = {
  id: string;
  name: string;
  description: string | null;
  model: string | null;
};

export type AgentDetails = AgentSummary & {
  /** The agent's full system prompt. */
  system: string;
};

/** Fields left out are not changed. */
export type AgentUpdate = {
  name?: string;
  description?: string;
  /** Default model for new chats. */
  model?: string;
  system?: string;
};

export type ModelOption = {
  id: string;
  handle: string;
  label: string;
};

export type ProviderField = {
  key: string;
  label: string;
  placeholder: string | null;
  secret: boolean;
  required: boolean;
};

export type ProviderAuthMethod = {
  id: string;
  label: string;
  description: string;
  fields: ProviderField[];
};

export type ProviderSummary = {
  id: string;
  name: string;
  description: string;
  /** Subscription sign-in. These are connected from the Letta CLI, not here. */
  oauth: boolean;
  fields: ProviderField[];
  /** Set instead of `fields` when a provider offers more than one way to authenticate. */
  authMethods: ProviderAuthMethod[];
  connections: Array<{ name: string; authType: "api" | "oauth" | null; baseUrl: string | null }>;
};

export type MemoryFile = {
  /** Path relative to the agent's memory folder. */
  path: string;
  /** System files are always in the agent's context. */
  system: boolean;
  description: string | null;
  /** The body, without the file's header. Use readMemoryFile for the whole file. */
  content: string;
  size: number;
  kind: "markdown" | "image";
};

export type MemoryOverview = {
  /** False for agents that do not use file-based memory. */
  enabled: boolean;
  files: MemoryFile[];
};

export type MemoryCommit = {
  sha: string;
  message: string;
  timestamp: number;
  author: string | null;
};

export type ConversationSummary = {
  id: string;
  agentId: string;
  title: string;
  updatedAt: number;
  model: string | null;
  cwd: string | null;
};

export type ChatTextRow = {
  kind: "user" | "assistant" | "reasoning";
  key: string;
  text: string;
  /** Correlates an optimistic user row with the message Letta persists. */
  otid?: string;
};

export type ChatToolRow = {
  kind: "tool_call";
  key: string;
  toolCallId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  status: "streaming" | "ready" | "complete";
  result?: { content: string; isError: boolean };
};

export type ChatRow = ChatTextRow | ChatToolRow;

export type ApprovalRequest = {
  requestId: string;
  toolCallId: string | null;
  toolName: string;
  input: Record<string, unknown>;
  /** "Don't ask again" style grants offered by the runtime. */
  suggestions: Array<{ id: string; text: string }>;
};

export type ApprovalDecision =
  | { behavior: "allow"; updatedInput?: Record<string, unknown>; suggestionIds?: string[] }
  | { behavior: "deny"; message?: string };

export type HistoryResult = {
  rows: ChatRow[];
  hasMore: boolean;
  running: boolean;
  activity: string | null;
  approvals: ApprovalRequest[];
};

export type SendMessageInput = {
  agentId: string;
  /** null starts a new conversation. */
  conversationId: string | null;
  text: string;
  otid: string;
  cwd: string;
  model?: string;
  /** Execution target for this turn: a computer selector (sandbox = omit). */
  computer?: import("@letta-ai/letta-agent-sdk").ComputerSelector;
};

/** Main -> renderer push events. */
// (remote_auth variant appended below)
export type AppEvent =
  | { type: "remote_adoption"; adoption: import("./libs/remote-env.js").AdoptedState }
  | { type: "remote_auth"; auth: import("./libs/remote-env.js").RemoteAuthState }
  | { type: "connection"; state: ConnectionState }
  | { type: "turn.started"; conversationId: string }
  | { type: "turn.rows"; conversationId: string; rows: ChatRow[] }
  | { type: "turn.rows.removed"; conversationId: string; keys: string[] }
  | { type: "turn.activity"; conversationId: string; activity: string | null }
  | { type: "turn.finished"; conversationId: string; error?: string }
  | { type: "approval.requested"; conversationId: string; request: ApprovalRequest }
  | { type: "approval.resolved"; conversationId: string; requestId: string }
  | { type: "conversation.updated"; conversation: ConversationSummary }
  | { type: "menu"; command: "new-chat" | "settings" };

/** Renderer -> main requests. Every method is an `ipcRenderer.invoke` round trip. */
export type ExecutionMode = "local" | "remote-env" | "cloud-only";

export type RemoteEnvStatus = { running: boolean; effectiveName: string | null; connectionId: string | null };

export type AppRequests = {
  getSettings(): AppSettings;
  listComputers(): ComputerSummary[];
  getConversationEnv(conversationId: string): ConversationEnv;
  setConversationEnv(input: {
    conversationId: string;
    /** null = cloud sandbox; undefined = inherit the mode default. */
    selector: ComputerSelectorField | null | undefined;
  }): ConversationEnv;
  getExecutionMode(): ExecutionMode;
  getRemoteEnvName(): string;
  listRemoteDirectory(input: {
    /** null = the SDK-managed sandbox; else a computer selector. */
    selector: import("@letta-ai/letta-agent-sdk").ComputerSelector | null;
    path: string;
  }): string[];
  getConversationCwd(conversationId: string): string | null;
  clearBrowseCache(): void;
  getDefaultDirectory(input: {
    selector: import("@letta-ai/letta-agent-sdk").ComputerSelector | null;
  }): string;
  getTargetFolder(input: { targetKey: string }): string | null;
  setTargetFolder(input: { targetKey: string; folder: string | null }): string | null;
  setRemoteEnvName(input: { name: string }): string;
  setExecutionMode(mode: ExecutionMode): ExecutionMode;
  getRemoteEnvStatus(): RemoteEnvStatus;
  getRemoteAdoption(): import("./libs/remote-env.js").AdoptedState;
  getRemoteAuth(): import("./libs/remote-env.js").RemoteAuthState;
  openRemoteAuthUrl(input: { url: string }): boolean;
  adoptRemoteEnv(): import("./libs/remote-env.js").AdoptedState;
  updateSettings(update: SettingsUpdate): AppSettings;
  listSavedConnections(): SavedConnection[];
  saveCurrentConnection(name: string): SavedConnection[];
  switchSavedConnection(input: { id: string }): SavedConnection[];
  deleteSavedConnection(input: { id: string }): SavedConnection[];
  getConnection(): ConnectionState;
  reconnect(): ConnectionState;
  listAgents(): AgentSummary[];
  createAgent(input: { name: string; model?: string }): AgentSummary;
  getAgent(agentId: string): AgentDetails;
  updateAgent(agentId: string, update: AgentUpdate): AgentSummary;
  deleteAgent(agentId: string): void;
  listModels(refresh?: boolean): ModelOption[];
  listProviders(): ProviderSummary[];
  connectProvider(input: {
    providerId: string;
    authMethodId?: string;
    fields: Record<string, string>;
  }): ProviderSummary[];
  disconnectProvider(input: { providerId: string; providerName?: string }): ProviderSummary[];
  listMemory(agentId: string): MemoryOverview;
  readMemoryFile(agentId: string, path: string): string;
  writeMemoryFile(agentId: string, path: string, content: string): void;
  deleteMemoryFile(agentId: string, path: string): void;
  listMemoryHistory(agentId: string, path: string): MemoryCommit[];
  readMemoryFileAt(agentId: string, path: string, sha: string): string;
  listConversations(agentId: string): ConversationSummary[];
  loadHistory(conversationId: string, limit: number): HistoryResult;
  renameConversation(conversationId: string, title: string): ConversationSummary;
  archiveConversation(conversationId: string): void;
  sendMessage(input: SendMessageInput): ConversationSummary;
  stopTurn(conversationId: string): void;
  respondApproval(conversationId: string, requestId: string, decision: ApprovalDecision): void;
  selectDirectory(): string | null;
};

export type AppBridge = {
  [K in keyof AppRequests]: (
    ...args: Parameters<AppRequests[K]>
  ) => Promise<ReturnType<AppRequests[K]>>;
} & {
  onEvent(listener: (event: AppEvent) => void): () => void;
  platform: string;
};
