/**
 * Thin agent rail — avatars down the left edge (initial-based, stable
 * per-agent color), status dot (working = any active turn), tooltip name.
 * Selects the agent like the old dropdown did; that dropdown remains for
 * settings/new-agent access. Unread indicator rides the selected agent.
 */
import { useState } from "react";

import { useAppStore } from "../store";

/** Persisted rail layout: pinned agents first, then saved order, then API order. */
interface RailLayout {
  order: string[];
  pinned: string[];
}

function useRailLayout(): RailLayout & {
  togglePin: (id: string) => void;
  moveUp: (id: string) => void;
  moveDown: (id: string) => void;
} {
  const [layout, setLayout] = useState<RailLayout>({ order: [], pinned: [] });
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
      const list = [...layout.order];
      const idx = list.indexOf(id);
      if (idx > 0) {
        list.splice(idx - 1, 0, list.splice(idx, 1)[0]!);
        persist({ ...layout, order: list });
      }
    },
    moveDown: (id) => {
      const list = [...layout.order];
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
  const rail = useRailLayout();
  const [menuFor, setMenuFor] = useState<string | null>(null);

  // Order: pinned first (by pin order), then saved order, then API order.
  const rank = (id: string) => {
    const pin = rail.pinned.indexOf(id);
    if (pin !== -1) return pin;
    const ord = rail.order.indexOf(id);
    return ord !== -1 ? rail.pinned.length + ord : rail.pinned.length + rail.order.length + 999;
  };
  const ordered = [...agents].sort((a, b) => rank(a.id) - rank(b.id));
  // Working signal: the active agent's active conversation is running a turn.
  const working = useAppStore((state) => {
    if (!state.agentId || !state.activeId) return false;
    return Boolean(state.chats[state.activeId]?.running);
  });

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
            {selected && working && (
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
