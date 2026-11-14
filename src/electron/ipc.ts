import { BrowserWindow, dialog, ipcMain } from "electron";
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
import { getConversationEnv, listComputers, setConversationEnv } from "./libs/env.js";
import {
  clearBrowseCache,
  getDefaultDirectory,
  listRemoteDirectory,
} from "./libs/remote-browse.js";
import {
  adoptOrSpawn,
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
}

const handlers: Handlers = {
  getSettings,
  listComputers: () => listComputers(),
  getConversationEnv,
  setConversationEnv: (input) => setConversationEnv(input.conversationId, input.selector),
  getExecutionMode: () => load().executionMode ?? "local",
  getRemoteEnvName: () => load().remoteEnvName ?? "",
  listRemoteDirectory: (input) => listRemoteDirectory(input.selector, input.path),
  clearBrowseCache: () => clearBrowseCache(),
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
  loadHistory,
  renameConversation,
  archiveConversation,
  sendMessage,
  stopTurn,
  respondApproval,
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
