import { randomUUID } from "node:crypto";
import {
  LettaAgentClient,
  createTranscriptAccumulator,
  type CanUseToolResponse,
  type LettaAgent,
  type LettaCodeSession,
  type LettaConversation,
  type TranscriptAccumulator,
  type TranscriptRow,
} from "@letta-ai/letta-agent-sdk";
import type {
  AgentDetails,
  AgentSummary,
  AgentUpdate,
  AppEvent,
  ApprovalDecision,
  ApprovalRequest,
  ChatRow,
  ConnectionState,
  ConversationSummary,
  HistoryResult,
  SendMessageInput,
} from "../types.js";
import { startAppServer, type AppServerHandle } from "./app-server.js";
import { adoptOrSpawn } from "./remote-env.js";
import { serverBackend, setControlTarget } from "./control.js";
import {
  type ConnectionConfig,
  forgetConversation,
  getConnectionConfig,
  getConversationCwd,
  getPermissionMode,
  load,
  getSettings,
  rememberCwd,
  setAgentId,
} from "./settings.js";
import { describeError, mergeHistory, projectHistory, toChatRow } from "./transcript.js";
import { wireContent, type AttachmentView } from "./attachments.js";

/**
 * Everything that talks to Letta: the SDK client, agent and conversation
 * management, and the turns currently streaming.
 */

type PendingApproval = {
  request: ApprovalRequest;
  resolve: (response: CanUseToolResponse) => void;
};

type Turn = {
  conversationId: string;
  session: LettaCodeSession;
  accumulator: TranscriptAccumulator;
  /** Last version of each row sent to the renderer, for identity diffing. */
  sent: Map<string, TranscriptRow>;
  approvals: Map<string, PendingApproval>;
  activity: string | null;
  flushTimer: NodeJS.Timeout | null;
  stopped: boolean;
  finished: boolean;
};

const ROW_FLUSH_MS = 40;
const STOP_GRACE_MS = 5_000;
const TITLE_MAX_CHARS = 60;

const ACTIVITY: Record<string, string | null> = {
  SENDING_API_REQUEST: "Thinking",
  WAITING_FOR_API_RESPONSE: "Thinking",
  PROCESSING_API_RESPONSE: "Responding",
  RETRYING_API_REQUEST: "Retrying",
  WAITING_ON_APPROVAL: "Waiting for approval",
  EXECUTING_CLIENT_SIDE_TOOL: "Running tool",
  EXECUTING_COMMAND: "Running command",
  WAITING_ON_INPUT: null,
};

let emit: (event: AppEvent) => void = () => {};
let client: LettaAgentClient | null = null;
let server: AppServerHandle | null = null;
let connecting: Promise<LettaAgentClient> | null = null;
let connection: ConnectionState = { status: "connecting", backend: "local" };

const turns = new Map<string, Turn>();
const conversations = new Map<string, ConversationSummary>();

export function initRuntime(emitter: (event: AppEvent) => void): void {
  emit = emitter;
  connection = { status: "connecting", backend: getConnectionConfig().backend };
  void ensureClient().catch(() => {
    // The failure is already reflected in the connection state.
  });
}

// --- Connection -------------------------------------------------------------

function setConnection(state: ConnectionState): void {
  connection = state;
  emit({ type: "connection", state });
}

export function getConnection(): ConnectionState {
  return connection;
}

/** Connection failures the user can fix get a message that says how. */
function describeConnectionError(error: unknown, config: ConnectionConfig): string {
  const detail = describeError(error);
  if (config.backend === "remote" && /WebSocket|ECONNREFUSED|ENOTFOUND/i.test(detail)) {
    return `Could not reach the Letta server at ${config.serverUrl}. Check that it is running and that the URL is correct.`;
  }
  if (config.backend === "cloud" && /LETTA_API_KEY/.test(detail)) {
    return "Add your Letta API key in Settings to use Letta Cloud.";
  }
  return detail;
}

function cloudClientForAdoption(): LettaAgentClient {
  const config = getConnectionConfig();
  return new LettaAgentClient({
    backend: "cloud",
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
  });
}

async function connect(): Promise<LettaAgentClient> {
  const config = getConnectionConfig();
  setConnection({ status: "connecting", backend: config.backend });

  let next: LettaAgentClient | null = null;
  let owned: AppServerHandle | null = null;
  const mode = load().executionMode ?? "local";
  try {
    let detail: string;
    // Execution mode 3 — cloud-only: direct cloud client. Sessions run in
    // the SDK-managed sandbox or on a registered computer (per-conversation
    // pick); no local process, no local file access.
    if (mode === "cloud-only") {
      next = new LettaAgentClient({
        backend: "cloud",
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      });
      detail = "Letta Cloud (cloud-only)";
    }
    // Execution mode 2 — remote-env: register this machine as a remote
    // environment (letta server, remote mode), then connect as a cloud
    // client; execution lands on this box's own registration.
    if (!next && mode === "remote-env") {
      // Adopt an existing online registration on this machine when present
      // (never kills it); otherwise spawn ours. Watch/replace runs inside.
      void adoptOrSpawn(cloudClientForAdoption(), {
        ...(config.apiKey ? { LETTA_API_KEY: config.apiKey } : {}),
        ...(config.apiBaseUrl ? { LETTA_BASE_URL: config.apiBaseUrl } : {}),
      });
      next = new LettaAgentClient({
        backend: "cloud",
        ...(config.apiKey ? { apiKey: config.apiKey } : {}),
        ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
      });
      detail = "Letta Cloud (via this machine's remote registration)";
    }
    if (config.backend === "remote" && !next) {
      if (!config.serverUrl) throw new Error("Add your Letta server URL in Settings.");
      next = new LettaAgentClient({
        backend: "remote",
        url: config.serverUrl,
        ...(config.serverToken ? { authToken: config.serverToken } : {}),
      });
      detail = config.serverUrl;
    } else {
      const cloud = config.backend === "cloud";
      owned = await startAppServer({
        harnessBackend: cloud ? "api" : "local",
        env: cloud
          ? {
              ...(config.apiKey ? { LETTA_API_KEY: config.apiKey } : {}),
              ...(config.apiBaseUrl ? { LETTA_BASE_URL: config.apiBaseUrl } : {}),
            }
          : {},
      });
      next = new LettaAgentClient({
        backend: "local",
        appServer: { url: owned.url, harnessBackend: cloud ? "api" : "local" },
      });
      detail = cloud ? "Letta Cloud" : "This computer";
    }

    // A cheap request that proves the server is reachable and authenticated.
    await next.agents.list({ limit: 1 });

    setControlTarget(
      owned
        ? { url: owned.url }
        : {
            url: config.serverUrl,
            ...(config.serverToken ? { authToken: config.serverToken } : {}),
          },
    );
    const providers = (await serverBackend()) === "local";

    owned?.onExit((reason) => {
      if (server !== owned) return;
      void disconnect().then(() => {
        setConnection({ status: "error", backend: config.backend, error: describeError(reason) });
      });
    });
    client = next;
    server = owned;
    setConnection({ status: "ready", backend: config.backend, detail, providers });
    return next;
  } catch (error) {
    setControlTarget(null);
    await next?.close().catch(() => undefined);
    owned?.close();
    setConnection({
      status: "error",
      backend: config.backend,
      error: describeConnectionError(error, config),
    });
    throw error;
  }
}

function ensureClient(): Promise<LettaAgentClient> {
  if (client) return Promise.resolve(client);
  connecting ??= connect().finally(() => {
    connecting = null;
  });
  return connecting;
}

export async function disconnect(): Promise<void> {
  await connecting?.catch(() => undefined);
  for (const turn of [...turns.values()]) {
    turn.stopped = true;
    finishTurn(turn);
  }
  conversations.clear();
  setControlTarget(null);
  const previousClient = client;
  const previousServer = server;
  client = null;
  server = null;
  await previousClient?.close().catch(() => undefined);
  previousServer?.close();
}

export async function reconnect(): Promise<ConnectionState> {
  await disconnect();
  await ensureClient().catch(() => undefined);
  return connection;
}

// --- Agents and models ------------------------------------------------------

function toAgentSummary(agent: LettaAgent): AgentSummary {
  return {
    id: agent.id,
    name: agent.name || "Untitled agent",
    description: agent.description ?? null,
    model: agent.model ?? agent.llm_config?.handle ?? null,
  };
}

export async function listAgents(): Promise<AgentSummary[]> {
  const sdk = await ensureClient();
  const agents = await sdk.agents.list({ limit: 100 });
  return agents.map(toAgentSummary);
}

export async function createAgent(input: { name: string; model?: string }): Promise<AgentSummary> {
  const sdk = await ensureClient();
  const agentId = await sdk.createAgent({
    name: input.name.trim() || "My agent",
    ...(input.model ? { model: input.model } : {}),
  });
  setAgentId(agentId);
  return toAgentSummary(await sdk.agents.retrieve(agentId));
}

export async function getAgent(agentId: string): Promise<AgentDetails> {
  const sdk = await ensureClient();
  const agent = await sdk.agents.retrieve(agentId);
  return { ...toAgentSummary(agent), system: agent.system ?? "" };
}

export async function updateAgent(agentId: string, update: AgentUpdate): Promise<AgentSummary> {
  const sdk = await ensureClient();
  const name = update.name?.trim();
  return toAgentSummary(
    await sdk.agents.update(agentId, {
      ...(name ? { name } : {}),
      ...(update.description !== undefined ? { description: update.description.trim() } : {}),
      ...(update.model ? { model: update.model } : {}),
      ...(update.system !== undefined ? { system: update.system } : {}),
    }),
  );
}

/** Permanently delete an agent, with its memory and conversations. */
export async function deleteAgent(agentId: string): Promise<void> {
  const sdk = await ensureClient();
  for (const conversation of [...conversations.values()]) {
    if (conversation.agentId !== agentId) continue;
    await stopTurn(conversation.id);
    conversations.delete(conversation.id);
    forgetConversation(conversation.id);
  }
  await sdk.agents.delete(agentId);
  if (getSettings().agentId === agentId) setAgentId(null);
}

// --- Conversations ----------------------------------------------------------

function timestamp(value: unknown): number {
  const parsed = typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isNaN(parsed) ? 0 : parsed;
}

function toConversationSummary(conversation: LettaConversation): ConversationSummary {
  const summary: ConversationSummary = {
    id: conversation.id,
    agentId: conversation.agent_id,
    title: conversation.summary?.trim() ?? "",
    updatedAt:
      timestamp(conversation.last_message_at) ||
      timestamp(conversation.updated_at) ||
      timestamp(conversation.created_at),
    model: conversation.model ?? null,
    cwd: getConversationCwd(conversation.id),
  };
  conversations.set(summary.id, summary);
  return summary;
}

function titleFrom(text: string): string {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  return line.length > TITLE_MAX_CHARS ? `${line.slice(0, TITLE_MAX_CHARS - 1).trimEnd()}...` : line;
}

/** In-process memo: conversation ids already husk-checked (id -> true=real, false=husk).
 * listMessages(limit 1) is the only reliable discriminator (husk=0 rows, real≥1;
 * list-level fields are projection-unreliable). Memoized so the per-refresh cost
 * is zero for previously-checked conversations. */
const huskChecked = new Map<string, boolean>();

async function hasMessages(sdk: Awaited<ReturnType<typeof ensureClient>>, conversationId: string): Promise<boolean> {
  const memo = huskChecked.get(conversationId);
  if (memo !== undefined) return memo;
  try {
    const page = (await sdk.conversations.listMessages(conversationId, { limit: 1 })) as unknown as {
      messages?: unknown[];
    };
    const verdict = (page.messages?.length ?? 0) > 0;
    huskChecked.set(conversationId, verdict);
    return verdict;
  } catch {
    // Unprobeable — treat as real (fail open; the official client's behavior
    // on unreachable rows is unknown, showing beats hiding on error).
    return true;
  }
}

/** In-process memo: display fields recovered via retrieve for rows whose list
 * projection nulled summary+last_message_at (id -> fields). Only probe-PASSING
 * rows land here (the probe proved them real); retrieve() is the only way to
 * get their title/timestamp back for display. Memoized so repeat loads never
 * re-retrieve (kills PR #13's per-refresh N1 tax). */
const enrichedFields = new Map<string, { summary: string | null; last_message_at: string | null }>();

async function enrichDisplayFields(
  sdk: Awaited<ReturnType<typeof ensureClient>>,
  conversationId: string,
): Promise<void> {
  if (enrichedFields.has(conversationId)) return;
  try {
    const full = await sdk.conversations.retrieve(conversationId);
    enrichedFields.set(conversationId, {
      summary: full.summary ?? null,
      last_message_at: full.last_message_at ?? null,
    });
  } catch {
    // Unenrichable — the row still shows (the probe passed it); it just lacks
    // a title/timestamp until a later load succeeds. Left unmemoized so the
    // next load retries.
  }
}

export async function listConversationsFirstPage(
  agentId: string,
  pageSize = 25,
): Promise<ConversationSummary[]> {
  // Fast first paint WITHOUT husk flash: over-fetch 100, drop archived and
  // title-less rows (husks render as "New chat"), then PROBE the first
  // batch concurrently — verified rows in ~2s. The title filter alone let
  // named cron shells through; the probe alone was too slow; both = right.
  const sdk = await ensureClient();
  const page = await sdk.conversations.list({ agentId, limit: 100 });
  const titled = page.filter(
    (conversation) =>
      !conversation.archived &&
      Boolean(conversation.summary || conversation.last_message_at || conversation.name),
  );
  // Probe up to 2x pageSize candidates concurrently (10-wide) — enough
  // survive husks to fill the page.
  const candidates = titled.slice(0, pageSize * 2);
  const verdicts = await Promise.all(
    candidates.map((_, index) => {
      const chunk = Math.floor(index / 10);
      return new Promise<boolean>((resolve) => {
        setTimeout(() => {
          void hasMessages(sdk, candidates[index]!.id).then(resolve, () => resolve(false));
        }, chunk * 150);
      });
    }),
  );
  return candidates
    .filter((_, i) => verdicts[i])
    .slice(0, pageSize)
    .map(toConversationSummary)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listConversations(agentId: string): Promise<ConversationSummary[]> {
  const sdk = await ensureClient();
  // Fetch ALL pages: the agent's conversation count can far exceed one page
  // (443 here, ~400 cron husks), and real conversations sit beyond page 1.
  const list = [];
  let after: string | undefined;
  let capped = false;
  for (let page = 0; page < 10; page++) {
    const batch = await sdk.conversations.list({
      agentId,
      limit: 100,
      ...(after ? { after } : {}),
    });
    list.push(...batch);
    if (batch.length < 100) break;
    // A full 10th page means the loop exits with conversations still unfetched
    // — silent truncation is the bug class that hides them, so say so loudly.
    if (page === 9) capped = true;
    after = batch[batch.length - 1]?.id;
  }
  if (capped) {
    console.log("[convlist] pagination cap reached — conversations beyond page 10 are NOT shown");
  }
  // All non-archived rows are probe candidates. The SDK list projection
  // intermittently nulls summary+last_message_at for REAL conversations
  // (observed Nov 16-17; retrieve() returns them), so list-level fields are
  // not a valid discriminator — the hasMessages probe is the single gate.
  const candidates = list.filter((conversation) => !conversation.archived);
  // Probe husk-status concurrently (10 at a time) — 447 sequential probes
  // took minutes; batched concurrency brings first load to ~30s, and the
  // memo makes every subsequent load instant.
  const verdicts = await Promise.all(
    candidates.map((_, index, all) => {
      // Stagger: probe in waves of 10 via micro-chunking
      const chunk = Math.floor(index / 10);
      return new Promise<boolean>((resolve) => {
        setTimeout(() => {
          void hasMessages(sdk, all[index].id).then(resolve);
        }, chunk * 150);
      });
    }),
  );
  const kept: typeof list = [];
  for (let i = 0; i < candidates.length; i++) {
    if (verdicts[i]) kept.push(candidates[i]);
  }
  // Rows that PASSED the probe but show null summary AND null last_message_at
  // in the list projection are real conversations missing display fields —
  // retrieve() fills title/last_message_at for display only (the probe already
  // decided inclusion). Memoized, so each such row is retrieved once ever.
  const needsDisplayFields = kept.filter(
    (conversation) => !conversation.summary && !conversation.last_message_at,
  );
  await Promise.all(
    needsDisplayFields.map((conversation) => enrichDisplayFields(sdk, conversation.id)),
  );
  // Merge the memoized display fields into each row before projection.
  const result = kept
    .map((conversation) => {
      const extra = enrichedFields.get(conversation.id);
      if (!extra) return conversation;
      // Memo fills gaps, never overrides: list-present values win over the
      // memoized null-day enrichment (rename-after-enrichment would else
      // show the stale title until process restart). (Uncia N1, PR #15.)
      return {
        ...conversation,
        summary: conversation.summary ?? extra.summary,
        last_message_at: conversation.last_message_at ?? extra.last_message_at,
      };
    })
    .map(toConversationSummary)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return result;
}

export async function renameConversation(
  conversationId: string,
  title: string,
): Promise<ConversationSummary> {
  const sdk = await ensureClient();
  return toConversationSummary(
    await sdk.conversations.update(conversationId, { summary: title.trim() }),
  );
}

export async function archiveConversation(conversationId: string): Promise<void> {
  const sdk = await ensureClient();
  await stopTurn(conversationId);
  await sdk.conversations.update(conversationId, { archived: true });
  conversations.delete(conversationId);
  forgetConversation(conversationId);
}

export async function loadHistory(conversationId: string, limit: number): Promise<HistoryResult> {
  const sdk = await ensureClient();
  const page = await sdk.conversations.listMessages(conversationId, { limit, order: "desc" });
  const history = projectHistory(page.messages);
  const turn = turns.get(conversationId);
  return {
    rows: turn ? mergeHistory(history, turn.accumulator.rows().map(toChatRow)) : history,
    hasMore: page.hasMore ?? page.messages.length >= limit,
    running: Boolean(turn),
    activity: turn?.activity ?? null,
    approvals: turn ? [...turn.approvals.values()].map((pending) => pending.request) : [],
  };
}

// --- Turns ------------------------------------------------------------------

function flushRows(turn: Turn): void {
  if (turn.flushTimer) {
    clearTimeout(turn.flushTimer);
    turn.flushTimer = null;
  }
  // Rows keep their object identity when nothing changed, so an identity
  // comparison against the last sent version is an exact diff.
  const changed: ChatRow[] = [];
  for (const row of turn.accumulator.rows()) {
    if (turn.sent.get(row.key) === row) continue;
    turn.sent.set(row.key, row);
    changed.push(toChatRow(row));
  }
  if (changed.length > 0) {
    emit({ type: "turn.rows", conversationId: turn.conversationId, rows: changed });
  }
}

function scheduleFlush(turn: Turn): void {
  turn.flushTimer ??= setTimeout(() => flushRows(turn), ROW_FLUSH_MS);
}

function setActivity(turn: Turn, activity: string | null): void {
  if (turn.activity === activity) return;
  turn.activity = activity;
  emit({ type: "turn.activity", conversationId: turn.conversationId, activity });
}

function settleApprovals(turn: Turn, message: string): void {
  for (const [requestId, pending] of turn.approvals) {
    pending.resolve({ behavior: "deny", message, interrupt: true });
    emit({ type: "approval.resolved", conversationId: turn.conversationId, requestId });
  }
  turn.approvals.clear();
}

function finishTurn(turn: Turn, error?: string): void {
  if (turn.finished) return;
  turn.finished = true;
  flushRows(turn);
  settleApprovals(turn, "The turn ended.");
  // Sessions hold a live connection to the runtime; the conversation itself is
  // durable, so the session is closed as soon as the turn is over.
  try {
    turn.session.close();
  } catch {
    // Already closed.
  }
  if (turns.get(turn.conversationId) === turn) turns.delete(turn.conversationId);
  emit({
    type: "turn.finished",
    conversationId: turn.conversationId,
    ...(error && !turn.stopped ? { error } : {}),
  });

  const conversation = conversations.get(turn.conversationId);
  if (conversation) {
    const updated = { ...conversation, updatedAt: Date.now() };
    conversations.set(updated.id, updated);
    emit({ type: "conversation.updated", conversation: updated });
  }
}

async function runTurn(
  turn: Turn,
  text: string,
  otid: string,
  attachments: AttachmentView[] = [],
): Promise<void> {
  let failure: string | undefined;
  try {
    // A conversation left waiting on an approval (for example, the app quit
    // mid-turn) stays wedged until the runtime re-drives it through canUseTool.
    await turn.session.recoverPendingApprovals({ timeoutMs: 5_000 }).catch(() => undefined);
    await turn.session.send(wireContent(text, attachments), { otid });

    for await (const message of turn.session.stream()) {
      if (turn.finished) return;
      switch (message.type) {
        case "error":
          failure = describeError(message.errorDetail ?? message.message);
          break;
        case "result":
          failure = message.success
            ? undefined
            : (failure ??
              describeError(message.errorDetail ?? message.error ?? "The turn failed."));
          break;
        case "retry": {
          // A retried turn re-streams from the top, so the rows written by the
          // abandoned attempt are dropped rather than accumulated onto.
          failure = undefined;
          const keys = [...turn.sent.keys()];
          turn.accumulator.reset();
          turn.sent.clear();
          if (keys.length > 0) {
            emit({ type: "turn.rows.removed", conversationId: turn.conversationId, keys });
          }
          setActivity(turn, `Retrying (${message.attempt}/${message.maxAttempts})`);
          break;
        }
        case "loop_status":
          if (message.status in ACTIVITY) setActivity(turn, ACTIVITY[message.status]);
          break;
        default:
          turn.accumulator.apply(message);
          scheduleFlush(turn);
      }
    }
  } catch (error) {
    failure = describeError(error);
  } finally {
    finishTurn(turn, failure);
  }
}

export async function sendMessage(input: SendMessageInput): Promise<ConversationSummary> {
  const sdk = await ensureClient();
  const text = input.text.trim();
  if (!text) throw new Error("Message is empty.");
  // Mid-run sends on the ACTIVE session queue server-side (the session
  // multiplexes); only a DIFFERENT stuck turn blocks. Matches the runtime
  // change the Angus client shipped (queue-while-running).
  const active = input.conversationId ? turns.get(input.conversationId) : undefined;
  if (active && active.finished) {
    throw new Error("This chat is finishing up. Try again in a moment.");
  }
  if (active && !active.finished) {
    await active.session.send(wireContent(text, input.attachments ?? []), { otid: input.otid });
    const known = conversations.get(input.conversationId!);
    if (!known) throw new Error("Conversation is not loaded.");
    return known;
  }

  let conversation: ConversationSummary;
  if (input.conversationId) {
    conversation =
      conversations.get(input.conversationId) ??
      toConversationSummary(await sdk.conversations.retrieve(input.conversationId));
    if (!conversation.title) {
      conversation = toConversationSummary(
        await sdk.conversations.update(conversation.id, { summary: titleFrom(text) }),
      );
    }
  } else {
    conversation = toConversationSummary(
      await sdk.conversations.create({ agentId: input.agentId, summary: titleFrom(text) }),
    );
  }

  rememberCwd(conversation.id, input.cwd);
  setAgentId(conversation.agentId);
  conversation = {
    ...conversation,
    cwd: input.cwd,
    updatedAt: Date.now(),
    // The session applies this as the conversation's model override.
    ...(input.model ? { model: input.model } : {}),
  };
  conversations.set(conversation.id, conversation);

  const turn: Turn = {
    conversationId: conversation.id,
    accumulator: createTranscriptAccumulator(),
    sent: new Map(),
    approvals: new Map(),
    activity: "Starting",
    flushTimer: null,
    stopped: false,
    finished: false,
    session: sdk.resumeSession(conversation.id, {
      cwd: input.cwd,
      permissionMode: getPermissionMode(),
      ...(input.model ? { model: input.model } : {}),
      // computer overrides are only valid on cloud sessions (the SDK rejects
      // them on local/remote clients). In private/local mode execution is
      // this machine's app server by construction — the override is void.
      ...((sdk as { backend?: string }).backend === "cloud" && input.computer
        ? { computer: input.computer }
        : {}),
      // Wire accepts "max" (CLI catalog) though the SDK type omits it.
      ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort as import("@letta-ai/letta-agent-sdk").ReasoningEffort } : {}),
      canUseTool: (toolName, toolInput, context) =>
        new Promise<CanUseToolResponse>((resolve) => {
          const request: ApprovalRequest = {
            requestId: context?.requestId ?? randomUUID(),
            toolCallId: context?.toolCallId ?? null,
            toolName,
            input: toolInput,
            suggestions: context?.permissionSuggestions ?? [],
          };
          turn.approvals.set(request.requestId, { request, resolve });
          // Make sure the tool call is on screen before asking about it.
          flushRows(turn);
          emit({ type: "approval.requested", conversationId: turn.conversationId, request });
        }),
    }),
  };
  turns.set(conversation.id, turn);
  emit({ type: "turn.started", conversationId: conversation.id });
  void runTurn(turn, text, input.otid, input.attachments ?? []);

  return conversation;
}

export async function stopTurn(conversationId: string): Promise<void> {
  const turn = turns.get(conversationId);
  if (!turn || turn.stopped) return;
  turn.stopped = true;
  settleApprovals(turn, "Stopped by the user.");
  setActivity(turn, "Stopping");
  // If the runtime does not wind the turn down promptly, end it locally.
  setTimeout(() => finishTurn(turn), STOP_GRACE_MS).unref();
  await turn.session.abort().catch(() => undefined);
}

export function respondApproval(
  conversationId: string,
  requestId: string,
  decision: ApprovalDecision,
): void {
  const turn = turns.get(conversationId);
  const pending = turn?.approvals.get(requestId);
  if (!turn || !pending) return;
  turn.approvals.delete(requestId);
  pending.resolve(
    decision.behavior === "allow"
      ? {
          behavior: "allow",
          ...(decision.updatedInput ? { updatedInput: decision.updatedInput } : {}),
          ...(decision.suggestionIds ? { updatedPermissions: decision.suggestionIds } : {}),
        }
      : { behavior: "deny", message: decision.message || "Denied by the user." },
  );
  emit({ type: "approval.resolved", conversationId, requestId });
}

/** Apply a permission mode change to turns that are already running. */
export function applyPermissionMode(): void {
  const permissionMode = getPermissionMode();
  for (const turn of turns.values()) {
    void turn.session.changeDeviceState({ permissionMode }).catch(() => undefined);
  }
}
