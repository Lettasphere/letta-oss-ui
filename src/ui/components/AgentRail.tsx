/**
 * Thin agent rail — avatars down the left edge (initial-based, stable
 * per-agent color), status dot (working = any active turn), tooltip name.
 * Selects the agent like the old dropdown did; that dropdown remains for
 * settings/new-agent access. Unread indicator rides the selected agent.
 */
import { useEffect, useState } from "react";

import { useAppStore } from "../store";

/** Persisted rail layout: pinned agents first, then saved order, then API order. */
interface RailLayout {
  order: string[];
  pinned: string[];
}

function useRailLayout(agentIds: string[]): RailLayout & {
  togglePin: (id: string) => void;
  moveUp: (id: string) => void;
  moveDown: (id: string) => void;
} {
  const [layout, setLayout] = useState<RailLayout>({ order: [], pinned: [] });
  // Hydrate the persisted order/pins on mount — without this every session
  // starts empty (moves were no-ops on an unpopulated list).
  useEffect(() => {
    void window.bridge
      .getAgentLayout()
      .then((saved) => setLayout({ order: saved.order ?? [], pinned: saved.pinned ?? [] }))
      .catch(() => undefined);
  }, []);
  const persist = (next: RailLayout) => {
    setLayout(next);
    void window.bridge.setAgentLayout(next);
  };
  return {
    ...layout,
    togglePin: (id) =>
      persist({
        ...layout,
        pinned: layout.pinned.includes(id)
          ? layout.pinned.filter((p) => p !== id)
          : [...layout.pinned, id],
      }),
    moveUp: (id) => {
      // Seed: if the id isn't in the saved order yet (fresh agent / never
      // moved), materialize the CURRENT display order first, then swap.
      let list = [...layout.order];
      if (!list.includes(id)) list = [...agentIds];
      const idx = list.indexOf(id);
      if (idx > 0) {
        list.splice(idx - 1, 0, list.splice(idx, 1)[0]!);
        persist({ ...layout, order: list });
      }
    },
    moveDown: (id) => {
      let list = [...layout.order];
      if (!list.includes(id)) list = [...agentIds];
      const idx = list.indexOf(id);
      if (idx >= 0 && idx < list.length - 1) {
        list.splice(idx + 1, 0, list.splice(idx, 1)[0]!);
        persist({ ...layout, order: list });
      }
    },
  };
}

/** Bundled canonical agent art, keyed by agent id prefix — falls back to
 *  the initial+color circle for agents without generated identity art. */
const AGENT_ART: Record<string, string> = {
  "agent-b499137a": new URL("../assets/agents/agent-b499137a.png", import.meta.url).toString(),
  "agent-a237fa13": new URL("../assets/agents/agent-a237fa13.png", import.meta.url).toString(),
  "agent-edc25b5d": new URL("../assets/agents/agent-edc25b5d.png", import.meta.url).toString(),
  "agent-8e405fb7": new URL("../assets/agents/agent-8e405fb7.png", import.meta.url).toString(),
  "agent-5b2254e8": new URL("../assets/agents/agent-5b2254e8.png", import.meta.url).toString(),
  "agent-e6f1a549": new URL("../assets/agents/agent-e6f1a549.png", import.meta.url).toString(),
};

function artFor(agentId: string): string | undefined {
  for (const [prefix, url] of Object.entries(AGENT_ART)) {
    if (agentId.startsWith(prefix)) return url;
  }
  return undefined;
}

/** Deterministic color per agent name — stable across sessions, no storage. */
function colorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  const hues = [210, 265, 320, 15, 40, 90, 140, 175];
  const hue = hues[Math.abs(hash) % hues.length];
  return `hsl(${hue} 55% 45%)`;
}

function initial(name: string): string {
  const trimmed = name.trim();
  return trimmed ? trimmed[0]!.toUpperCase() : "?";
}

export function AgentRail() {
  const agents = useAppStore((state) => state.agents);
  const agentId = useAppStore((state) => state.agentId);
  const selectAgent = useAppStore((state) => state.selectAgent);
  const rail = useRailLayout(agents.map((a) => a.id));
  const [menuFor, setMenuFor] = useState<string | null>(null);
  // Cross-agent unread: poll each agent's latest conversation activity and
  // compare against the read cursors (persisted per conversation). An agent
  // is UNREAD when its latest conversation has activity newer than its cursor.
  const [railStatus, setRailStatus] = useState<
    Record<string, { latestAt: string | null; latestConversationId: string | null }>
  >({});
  const readCursors = useAppStore((state) => state.readCursors);

  const noteConversationAgent = useAppStore((state) => state.noteConversationAgent);

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      const next: typeof railStatus = {};
      await Promise.all(
        agents.map(async (agent) => {
          try {
            const s = await window.bridge.agentRailStatus({ agentId: agent.id });
            next[agent.id] = { latestAt: s.latestAt, latestConversationId: s.latestConversationId };
            // Index the polled conversation -> agent: turn events for it can
            // now resolve this agent even when its list was never loaded.
            if (s.latestConversationId) noteConversationAgent(s.latestConversationId, agent.id);
          } catch {
            /* agent unreachable — leave absent = no dot */
          }
        }),
      );
      if (!cancelled) setRailStatus(next);
    };
    void poll();
    const timer = setInterval(() => void poll(), 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [agents, noteConversationAgent]);

  const agentReadFloors = useAppStore((state) => state.agentReadFloors);
  const agentActivity = useAppStore((state) => state.agentActivity);

  // The SELECTED agent's unread derives from the SAME state the sidebar
  // renders (loaded conversations + cursors + floor) — never the 30s poll,
  // which lags and de-syncs. Unselected agents use the poll (their lists
  // aren't loaded).
  const conversations = useAppStore((state) => state.conversations);

  const activeConvId = useAppStore((state) => state.activeId);

  const unreadFor = (id: string): boolean => {
    if (id === agentId) {
      // Same exemption as the sidebar: the OPEN conversation is read by
      // definition. Turn streaming bumps its updatedAt continuously; the
      // cursor only lands at turn end — without the exemption the rail
      // flags the agent unread WHILE you watch it work.
      return conversations.some(
        (c) =>
          c.id !== activeConvId &&
          Math.max(readCursors[c.id] ?? 0, agentReadFloors[id] ?? 0) < c.updatedAt,
      );
    }
    // Unselected agents: LIVE event-driven freshness first — any
    // conversation.updated for this agent bumped agentActivity. The 30s
    // poll is the cron-only backstop (fires that emit no events).
    // RUNNING conversations don't count as unread: tool output streaming
    // is work-in-progress, not a response waiting to be read (Harry:
    // "unread only when the agent finished or awaits a human decision").
    if (workingAgents.has(id)) return false;
    const floor = agentReadFloors[id] ?? 0;
    const liveAt = agentActivity[id];
    if (liveAt !== undefined) return liveAt > floor;
    const s = railStatus[id];
    if (!s?.latestAt || !s.latestConversationId) return false;
    const cursor = Math.max(
      readCursors[s.latestConversationId] ?? 0,
      floor,
    );
    return new Date(s.latestAt).getTime() > cursor;
  };

  // Order: pinned first (by pin order), then saved order, then API order.
  const rank = (id: string) => {
    const pin = rail.pinned.indexOf(id);
    if (pin !== -1) return pin;
    const ord = rail.order.indexOf(id);
    return ord !== -1 ? rail.pinned.length + ord : rail.pinned.length + rail.order.length + 999;
  };
  const ordered = [...agents].sort((a, b) => rank(a.id) - rank(b.id));
  // Cross-agent working: any live turn, resolved to its agent via the
  // conversation->agent index. Shows on EVERY agent's avatar (selected or
  // not) — a running agent is running wherever you're looking.
  const runningConversations = useAppStore((state) => state.runningConversations);
  const conversationAgentIndex = useAppStore((state) => state.conversationAgentIndex);
  const workingAgents = new Set<string>();
  for (const convId of runningConversations) {
    const owner = conversationAgentIndex[convId];
    if (owner) workingAgents.add(owner);
  }
  // Belt 1: the selected agent's own chat state also counts (index may lag).
  const working = useAppStore((state) => {
    if (!state.agentId || !state.activeId) return false;
    return Boolean(state.chats[state.activeId]?.running);
  });
  if (working && agentId) workingAgents.add(agentId);
  // Belt 2: API-side runs (gate reviews on other agents' own convs, crons,
  // device work) emit NO turn.started to us — but they DO bump agentActivity
  // via conversation.updated. A very recent unread bump on a NON-selected
  // agent = that agent is producing output right now = working.
  const now = Date.now();
  for (const agent of agents) {
    if (agent.id === agentId) continue; // selected: chat state covers it
    const at = agentActivity[agent.id] ?? 0;
    const read = agentReadFloors[agent.id] ?? 0;
    if (at > now - 90_000 && at > read) workingAgents.add(agent.id);
  }

  if (agents.length === 0) return null;

  return (
    <nav
      aria-label="Agents"
      className="flex w-16 shrink-0 flex-col items-center gap-2 border-r border-border bg-sidebar py-3"
    >
      {ordered.map((agent) => {
        const selected = agent.id === agentId;
        return (
          <button
            key={agent.id}
            type="button"
            onClick={() => agent.id !== agentId && void selectAgent(agent.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenuFor(menuFor === agent.id ? null : agent.id);
            }}
            title={agent.name}
            aria-label={agent.name}
            aria-pressed={selected}
            className="group relative rounded-full outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {artFor(agent.id) ? (
              <img
                src={artFor(agent.id)}
                alt={agent.name}
                decoding="async"
                className={`h-11 w-11 rounded-full object-cover transition-transform ${selected ? "ring-2 ring-accent ring-offset-2 ring-offset-sidebar" : "opacity-80 hover:opacity-100"}`}
              />
            ) : (
              <span
                className={`flex h-11 w-11 items-center justify-center rounded-full text-sm font-semibold text-white transition-transform ${selected ? "ring-2 ring-accent ring-offset-2 ring-offset-sidebar" : "opacity-80 hover:opacity-100"}`}
                style={{ backgroundColor: colorFor(agent.name) }}
              >
                {initial(agent.name)}
              </span>
            )}
            {menuFor === agent.id && (
              <span className="absolute left-14 top-0 z-50 flex flex-col gap-0.5 rounded-lg border border-border bg-surface px-1 py-1 shadow-elevated">
                <button type="button" className="rounded px-2.5 py-1 text-left text-xs text-ink-800 hover:bg-surface-tertiary" onClick={() => { rail.togglePin(agent.id); setMenuFor(null); }}>
                  {rail.pinned.includes(agent.id) ? "Unpin" : "Pin to top"}
                </button>
                <button type="button" className="rounded px-2.5 py-1 text-left text-xs text-ink-800 hover:bg-surface-tertiary disabled:opacity-40" disabled={rank(agent.id) <= (rail.pinned.includes(agent.id) ? 1 : rail.pinned.length + 1)} onClick={() => { rail.moveUp(agent.id); setMenuFor(null); }}>
                  Move up
                </button>
                <button type="button" className="rounded px-2.5 py-1 text-left text-xs text-ink-800 hover:bg-surface-tertiary disabled:opacity-40" disabled={rank(agent.id) >= ordered.length - 1} onClick={() => { rail.moveDown(agent.id); setMenuFor(null); }}>
                  Move down
                </button>
              </span>
            )}
            {unreadFor(agent.id) && (
              <span
                className="absolute -top-0.5 -right-0.5 h-3 w-3 rounded-full border-2 border-sidebar"
                style={{ backgroundColor: "#e0a030" }}
                title="Unread activity"
              />
            )}
            {workingAgents.has(agent.id) && (
              <span
                className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-sidebar bg-accent animate-pulse"
                title="Working"
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}
