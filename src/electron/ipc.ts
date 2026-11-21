import { BrowserWindow, dialog, ipcMain, Notification, shell } from "electron";
import type { AppEvent, AppRequests } from "./types.js";
import {
  applyPermissionMode,
  archiveConversation,
  createAgent,
  deleteAgent,
  getAgent,
  getConnection,
  listAgents,
  listConversations,
  listConversationsFirstPage,
  loadHistory,
  reconnect,
  renameConversation,
  respondApproval,
  sendMessage,
  stopTurn,
  updateAgent,
} from "./libs/runtime.js";
import {
  deleteMemoryFile,
  listMemory,
  listMemoryHistory,
  readMemoryFile,
  readMemoryFileAt,
  writeMemoryFile,
} from "./libs/memory.js";
import { connectProvider, disconnectProvider, listModels, listProviders } from "./libs/providers.js";
import {
  deleteSavedConnection,
  getConversationCwd,
  getSettings,
  listSavedConnections,
  load,
  save,
  saveCurrentConnection,
  switchSavedConnection,
  updateSettings,
} from "./libs/settings.js";
import { getAllConversationEnvs, getConversationEnv, listComputers, setConversationEnv } from "./libs/env.js";
import { intakeFiles } from "./libs/attachments.js";
import { deleteSchedule, listSchedules, pauseSchedule, resumeSchedule, triggerSchedule } from "./libs/schedules.js";
import {
  clearBrowseCache,
  getDefaultDirectory,
  listRemoteDirectory,
} from "./libs/remote-browse.js";
import {
  adoptOrSpawn,
  handoverState,
  onAdoptionChange,
  onHandoverChange,
  onRemoteAuthChange,
  remoteAuthState,
  defaultRemoteEnvName,
  ensureRemoteEnv,
  remoteAdoptionState,
  remoteEnvState,
  shutdownAdoption,
  stopRemoteEnv,
} from "./libs/remote-env.js";
import { describeError } from "./libs/transcript.js";
import { validateEventFrame } from "./util.js";

type Handlers = {
  [K in keyof AppRequests]: (
    ...args: Parameters<AppRequests[K]>
  ) => ReturnType<AppRequests[K]> | Promise<ReturnType<AppRequests[K]>>;
};

export function broadcast(event: AppEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send("app:event", event);
  }
  showOsNotification(event);
}

/**
 * OS notifications for attention-worthy events: approvals requested, turns
 * finished or failed. Skipped when a window is focused (the user is already
 * looking at the app) and when disabled in settings.
 */
function showOsNotification(event: AppEvent): void {
  try {
    const focused = BrowserWindow.getAllWindows().some((window) => window.isFocused() && !window.isDestroyed());
    if (focused) return;
    if (!load().osNotifications) return;
    if (event.type === "approval.requested") {
      const title = `Approval needed: ${event.request.toolName}`;
      new Notification({ title, body: "The agent is waiting for your decision." }).show();
    } else if (event.type === "turn.finished") {
      const chatTitle = event.conversationId; // titles live renderer-side; id suffices
      new Notification({
        title: "Response ready",
        body: `A turn finished (${chatTitle.slice(0, 18)})…`,
      }).show();
    }
  } catch {
    // Notification unavailable (headless) — no-op
  }
}

const handlers: Handlers = {
  getSettings,
  listComputers: () => listComputers(),
  getConversationEnv,
  getAllConversationEnvs,
  setConversationEnv: (input) => setConversationEnv(input.conversationId, input.selector),
  getAgentLayout: () => ({ order: load().agentOrder ?? [], pinned: load().pinnedAgents ?? [] }),
  setAgentLayout: (input) => {
    save({ ...load(), agentOrder: input.order, pinnedAgents: input.pinned });
    return { order: input.order, pinned: input.pinned };
  },
  getExecutionMode: () => load().executionMode ?? "local",
  getRemoteEnvName: () => load().remoteEnvName ?? "",
  listRemoteDirectory: (input) => listRemoteDirectory(input.selector, input.path),
  clearBrowseCache: () => clearBrowseCache(),
  getPinnedConversations: () => load().pinnedConversations ?? [],
  getReadCursors: () => load().readCursors ?? {},
  getOsNotifications: () => load().osNotifications ?? true,
  setOsNotifications: (input) => {
    const stored = load();
    save({ ...stored, osNotifications: input.enabled });
    return input.enabled;
  },
  markAllConversationsRead: (input) => {
    // Bulk: set the cursor for every listed conversation to its updatedAt
    // (or now) — one settings write.
    const stored = load();
    const readCursors = { ...(stored.readCursors ?? {}) };
    for (const item of input.items) readCursors[item.conversationId] = item.updatedAt;
    save({ ...stored, readCursors });
    return readCursors;
  },
  markConversationRead: (input) => {
    const stored = load();
    const readCursors = { ...(stored.readCursors ?? {}) };
    readCursors[input.conversationId] = input.updatedAt;
    save({ ...stored, readCursors });
    return readCursors;
  },
  togglePinnedConversation: (input) => {
    const stored = load();
    const pins = new Set(stored.pinnedConversations ?? []);
    if (pins.has(input.conversationId)) pins.delete(input.conversationId);
    else pins.add(input.conversationId);
    const next = [...pins];
    save({ ...stored, pinnedConversations: next });
    return next;
  },
  getDefaultDirectory: (input) =>
    getDefaultDirectory(input.selector),
  getTargetFolder: (input) => {
    const stored = load();
    const key = input.targetKey;
    return stored.targetFolders?.[key] ?? null;
  },
  setTargetFolder: (input) => {
    const stored = load();
    const targetFolders = { ...(stored.targetFolders ?? {}) };
    if (input.folder) targetFolders[input.targetKey] = input.folder;
    else delete targetFolders[input.targetKey];
    save({ ...stored, targetFolders });
    return input.folder ?? null;
  },
  getConversationCwd: (conversationId) => getConversationCwd(conversationId),
  setRemoteEnvName: (input) => {
    const stored = load();
    save({ ...stored, remoteEnvName: input.name.trim() || defaultRemoteEnvName() });
    // A renamed registration restarts so the new name takes effect cleanly.
    stopRemoteEnv();
    if ((load().executionMode ?? "local") === "remote-env") {
      ensureRemoteEnv({
        ...(stored.apiKey && !stored.apiKey.startsWith("enc:") ? { LETTA_API_KEY: stored.apiKey } : {}),
      });
    }
    return load().remoteEnvName ?? "";
  },
  setExecutionMode: (mode) => {
    const stored = load();
    save({ ...stored, executionMode: mode });
    if (mode === "remote-env") {
      const config = { ...stored };
      ensureRemoteEnv({
        ...(config.apiKey ? { LETTA_API_KEY: decodeStoredSecret(config.apiKey) } : {}),
      });
    }
    if (mode !== "remote-env") {
      shutdownAdoption();
      stopRemoteEnv();
    }
    void reconnect();
    return mode;
  },
  getRemoteAdoption: () => remoteAdoptionState(),
  getRemoteHandover: () => handoverState(),
  getRemoteAuth: () => remoteAuthState(),
  openRemoteAuthUrl: (input) => {
    if (input.url && /^https:\/\//.test(input.url)) void shell.openExternal(input.url);
    return true;
  },
  adoptRemoteEnv: async () => {
    const { getConnectionConfig } = await import("./libs/settings.js");
    const config = getConnectionConfig();
    const { LettaAgentClient } = await import("@letta-ai/letta-agent-sdk");
    const cloud = new LettaAgentClient({
      backend: "cloud",
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
    });
    return adoptOrSpawn(cloud, {
      ...(config.apiKey ? { LETTA_API_KEY: config.apiKey } : {}),
    });
  },
  getRemoteEnvStatus: () => remoteEnvStatusSafe(),
  listSavedConnections,
  saveCurrentConnection,
  switchSavedConnection: (input) => {
    const result = switchSavedConnection(input.id);
    void reconnect();
    return result;
  },
  deleteSavedConnection: (input) => deleteSavedConnection(input.id),
  updateSettings: (update) => {
    const { connectionChanged } = updateSettings(update);
    if (update.permissionMode) applyPermissionMode();
    // The renderer follows the reconnect through `connection` events.
    if (connectionChanged) void reconnect();
    return getSettings();
  },
  getConnection,
  reconnect,
  listAgents,
  createAgent,
  getAgent,
  updateAgent,
  deleteAgent,
  listModels,
  listProviders,
  connectProvider,
  disconnectProvider,
  listMemory,
  readMemoryFile,
  writeMemoryFile,
  deleteMemoryFile,
  listMemoryHistory,
  readMemoryFileAt,
  listConversations,
  listConversationsFirstPage,
  loadHistory,
  renameConversation,
  archiveConversation,
  sendMessage,
  stopTurn,
  respondApproval,
  listSchedules: (input) => listSchedules(input.agentId),
  pauseSchedule: (input) => pauseSchedule(input.taskId),
  resumeSchedule: (input) => resumeSchedule(input.taskId),
  deleteSchedule: (input) => deleteSchedule(input.taskId),
  triggerSchedule: (input) => triggerSchedule(input.taskId),
  selectImages: async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(window, {
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    });
    if (result.canceled) return { attachments: [], skipped: [] };
    return intakeFiles(result.filePaths);
  },
  selectDirectory: async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(window, {
      properties: ["openDirectory", "createDirectory"],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  },
};

function decodeStoredSecret(encoded: string | undefined): string | undefined {
  if (!encoded) return undefined;
  // settings stores enc:-prefixed safeStorage blobs; the plain fallback is used as-is.
  return encoded.startsWith("enc:") ? undefined : encoded;
}

function remoteEnvStatusSafe() {
  const s = remoteEnvState();
  return { running: s.running, effectiveName: s.effectiveName, connectionId: s.connectionId };
}

export function registerIpc(): void {
  onRemoteAuthChange((auth) => broadcast({ type: "remote_auth", auth }));
  onAdoptionChange((adoption) => broadcast({ type: "remote_adoption", adoption }));
  onHandoverChange((handover) => broadcast({ type: "remote_handover", handover }));
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle(`app:${name}`, async (event, ...args: unknown[]) => {
      // Errors cross the bridge as data so the renderer sees the real message
      // instead of Electron's "Error invoking remote method" wrapper.
      try {
        validateEventFrame(event.senderFrame);
        const value = await (handler as (...input: unknown[]) => unknown)(...args);
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: describeError(error) };
      }
    });
  }
}
