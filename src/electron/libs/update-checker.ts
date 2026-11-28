/**
 * Update checker — Phase 1 (manual browser flow), per the ACCEPTED v2r4
 * contract (~/lettasphere-desktop-update-v2r4.md, Uncia review trail
 * v1→v2→v2r2→v2r3→v2r4).
 *
 * What this is: a main-process state machine that polls GitHub's selected
 * latest release and tells the renderer when a NEWER version exists. The
 * update action opens the canonical release page in the browser — no
 * in-app download, no install, no electron-updater. Phase 2 (in-app
 * install) is blocked on a separate trust/shutdown contract.
 *
 * Contract decisions locked by the reviews:
 * - Strict v-tag validation: /^v\d+\.\d+\.\d+$/ — bare/suffixed/malformed
 *   tags are errors, never announcements (v2r2 #1).
 * - GitHub's /releases/latest selection is THE release policy; version-aware
 *   no-downgrade guard backstops it; observed-older-than-installed surfaces
 *   a warning, never an offer (v2r3 #2, v2r4 fold-in).
 * - State derivation is a pure function of (successfully-observed tag,
 *   installed version, last-attempt outcome) — a failed recheck can NEVER
 *   convert an equal/older tag into available (v2r4 correction).
 * - One snapshot, one seq, full broadcast on every mutation; subscribe-first
 *   renderer protocol with stale-event discard (v2r2 #1).
 * - Dismissal: strict process-lifetime (Harry's stated requirement); the
 *   re-arm-on-newer-version extension is documented but OFF (v2r4 note).
 * - Rate limits: 429 AND 403-with-headers honored; server deadlines win
 *   over the fixed backoff; malformed headers fall back to fixed; no 2h
 *   cap — a valid later deadline is honored with an honest Settings
 *   message (v2r4 implementation note 1).
 */
import { app, shell } from "electron";

import type { AppEvent, UpdateSnapshot } from "../types.js";

/** Fixed constants — the canonical URL is CONSTRUCTED, never from API fields. */
const REPO = "Lettasphere/letta-oss-ui";
const RELEASES_LATEST_URL = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE_PREFIX = `https://github.com/${REPO}/releases/tag/`;

const TAG_RE = /^v\d+\.\d+\.\d+$/;

/** Check cadence: launch (10s after ready), then every 24h. */
const LAUNCH_DELAY_MS = 10_000;
const SCHEDULED_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Manual-check throttle. */
const MANUAL_THROTTLE_MS = 30_000;
/** Fetch timeout — exactly-once via the flight token. */
const FETCH_TIMEOUT_MS = 10_000;
/** Fixed backoff when the server gives no deadline. */
const FIXED_BACKOFF_MS = 60 * 60 * 1000;

type State = UpdateSnapshot & {
  /** Backoff deadline (ms epoch): checks before this are suppressed. */
  retryNotBefore: number;
};

let emit: ((event: AppEvent) => void) | null = null;
let state: State = freshState();
let scheduledTimer: NodeJS.Timeout | null = null;
let flight: { token: number } | null = null;
let lastManualCheckAt = 0;
let initialized = false;

function freshState(): State {
  return {
    seq: 0,
    state: "idle",
    version: null,
    releaseUrl: null,
    lastAttemptAt: null,
    lastSuccessfulCheckAt: null,
    lastCheckError: null,
    dismissedFor: null,
    retryNotBefore: 0,
  };
}

/** THE single mutation path: seq++, broadcast the complete snapshot. */
function mutate(patch: Partial<State>): void {
  state = { ...state, ...patch, seq: state.seq + 1 };
  emit?.({ type: "update.state", snapshot: publicSnapshot() });
}

function publicSnapshot(): UpdateSnapshot {
  // Destructure-drop the internal backoff field; the public snapshot
  // (per the type) carries only the contract fields.
  const { retryNotBefore, ...pub } = state;
  void retryNotBefore;
  return pub;
}

/**
 * Parse a version to numeric segments. Accepts BOTH forms:
 * - Release TAGS ("v1.2.3") — strict v-required, from GitHub
 * - INSTALLED versions ("1.2.3" / "0.3.1") — app.getVersion() has NO v
 *   prefix (it reads package.json). The v1 bug: the tag regex was applied
 *   to both sides, so the installed version always parsed null and
 *   isNewer returned false — every release read "up to date" (Harry's
 *   on-device report, Nov 28: 0.3.1 install + 0.3.2 live = "matches or
 *   is older").
 */
function versionSegments(tag: string): number[] | null {
  const body = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d+\.\d+\.\d+$/.test(body)) return null;
  return body.split(".").map(Number);
}

/** Strict comparison: positive iff a > b. Null segments = incomparable. */
function isNewer(candidate: string, installed: string): boolean {
  const a = versionSegments(candidate);
  const b = versionSegments(installed);
  if (!a || !b) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/**
 * State derivation — the pure function from the v2r4 contract.
 * NEVER converts an equal/older observed tag into "available" on failure.
 */
function derive(
  observed: { tag: string } | null,
  attempt: { error: string | null; at: number },
  installed: string,
): Pick<State, "state" | "version" | "releaseUrl" | "lastAttemptAt" | "lastSuccessfulCheckAt" | "lastCheckError"> {
  const observedTag = observed?.tag ?? null;
  const error = attempt.error;
  return {
    version: observedTag,
    releaseUrl: observedTag ? `${RELEASE_PAGE_PREFIX}${observedTag}` : null,
    lastAttemptAt: attempt.at,
    lastSuccessfulCheckAt: observed ? attempt.at : null,
    lastCheckError: error,
    state: observed
      ? isNewer(observed.tag, installed)
        ? "available"
        : "up-to-date"
      : error
        ? "error"
        : "idle",
  };
}

/** Extract a rate-limit deadline from a response (429 or 403-with-headers). */
function rateLimitDeadline(res: Response): number | null {
  const retryAfter = res.headers.get("Retry-After");
  if (retryAfter !== null) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Date.now() + Math.min(seconds, 2 * 60 * 60) * 1000;
    }
  }
  const reset = res.headers.get("X-RateLimit-Reset");
  if (reset !== null) {
    const epochSeconds = Number(reset);
    if (Number.isFinite(epochSeconds) && epochSeconds > 0) {
      // Clock skew guard: a corrupt future timestamp can't disable checks
      // for more than 2h (v2r4 note: honored, not capped silently — the
      // Settings message states the actual deadline).
      const deadline = epochSeconds * 1000;
      const maxDeadline = Date.now() + 2 * 60 * 60 * 1000;
      return Math.min(deadline, maxDeadline);
    }
  }
  return null;
}

async function performCheck(): Promise<void> {
  if (!emit) return;
  const installed = app.getVersion();
  const attemptAt = Date.now();
  const token = { token: 0 };
  // performCheck OWNS the flight slot: the late-completion guard compares
  // against THIS token (the last write). startCheck's wrapper clears the
  // slot when performCheck settles — single owner, reliable cleanup. (The
  // v1 wrapper minted a second token that this line immediately replaced:
  // the cleanup compared the wrong token — dead code — flight leaked, and
  // every check after the first silently no-opped. Uncia #29 finding.)
  flight = token;

  mutate({ state: "checking" });

  let observed: { tag: string } | null = null;
  let error: string | null = null;
  let backoff: number = FIXED_BACKOFF_MS;

  try {
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    const res = await fetch(RELEASES_LATEST_URL, {
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
    clearTimeout(abortTimer);

    if (res.status === 429 || (res.status === 403 && rateLimitDeadline(res) !== null)) {
      const deadline = rateLimitDeadline(res);
      if (deadline !== null) {
        backoff = Math.max(deadline - Date.now(), 0);
        error = `Rate limited — next check ${new Date(deadline).toLocaleTimeString()}`;
      }
    } else if (res.status === 404) {
      error = "No releases found.";
    } else if (!res.ok) {
      error = `Update check failed (HTTP ${res.status}).`;
    } else {
      const release = (await res.json()) as {
        tag_name?: unknown;
        draft?: unknown;
        prerelease?: unknown;
      };
      const tag = typeof release.tag_name === "string" ? release.tag_name : null;
      // Defense in depth: reject drafts/prereleases even though /latest
      // should exclude them (v2r2 #4).
      if (release.draft === true || release.prerelease === true) {
        error = "Latest release is a draft or prerelease — skipping.";
      } else if (!tag || !TAG_RE.test(tag)) {
        error = `Release tag malformed (expected v-prefixed, got ${tag ?? "none"}).`;
      } else {
        observed = { tag };
      }
    }
  } catch (e) {
    error = e instanceof Error && e.name === "AbortError" ? "Update check timed out." : `Update check failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  // Flight token: a late completion (timed-out response arriving after
  // abort) still lands here, but only the CURRENT flight may mutate.
  if (flight !== token) return;

  const derived = derive(observed, { error, at: attemptAt }, installed);
  mutate({ ...derived, retryNotBefore: error ? Date.now() + backoff : Date.now() });
}

export function initUpdateChecker(emitter: (event: AppEvent) => void): void {
  emit = emitter;
  initialized = true;
  // Dev mode: explicit unsupported state — no checks, no false buttons.
  if (!app.isPackaged) {
    mutate({ state: "unsupported" });
    return;
  }
  const first = setTimeout(() => {
    void startCheck();
    scheduledTimer = setInterval(() => void startCheck(), SCHEDULED_INTERVAL_MS);
    scheduledTimer.unref?.();
  }, LAUNCH_DELAY_MS);
  first.unref?.();
}

/** Manual check (Settings button): throttle + single-flight + backoff gate. */
export async function manualCheck(): Promise<UpdateSnapshot> {
  if (!initialized || state.state === "unsupported") return publicSnapshot();
  const now = Date.now();
  if (now < state.retryNotBefore) {
    return publicSnapshot(); // suppressed — Settings renders the deadline
  }
  if (now - lastManualCheckAt < MANUAL_THROTTLE_MS) {
    return publicSnapshot();
  }
  lastManualCheckAt = now;
  await startCheck();
  return publicSnapshot();
}

/**
 * Opportunistic check on navigation (Harry, Nov 28: "some sort of check
 * every time there's a conversation or agent switch"). Same throttle and
 * backoff gates as manual — navigation frequency would otherwise hammer
 * the API. Fire-and-forget: the state lands via the broadcast; the caller
 * never awaits.
 */
export function checkOnNavigation(): void {
  if (!initialized || state.state === "unsupported") return;
  const now = Date.now();
  if (now < state.retryNotBefore) return;
  if (now - lastManualCheckAt < MANUAL_THROTTLE_MS) return;
  lastManualCheckAt = now;
  void startCheck();
}

async function startCheck(): Promise<void> {
  // Single-flight: an in-flight check owns the mutation slot. performCheck
  // assigns the token (last write wins); the wrapper's finally clears the
  // slot unconditionally when performCheck settles — single owner, reliable
  // cleanup. No second token: the v1 wrapper's own token made the cleanup
  // dead code (flight leak → all checks after the first silently no-opped).
  if (flight) return;
  flight = { token: 0 };
  try {
    await performCheck();
  } finally {
    flight = null;
  }
}

/** Dismissal: strict process-lifetime (re-arm OFF per v2r4). */
export function dismissUpdateBanner(): UpdateSnapshot {
  mutate({ dismissedFor: state.version });
  return publicSnapshot();
}

/** Snapshot for subscribe-first renderer protocol. */
export function getUpdateSnapshot(): UpdateSnapshot {
  return publicSnapshot();
}

/**
 * Stale-install advisory: GitHub's selected latest is NOT newer than the
 * installed version (equal or older). The v2r3 #2 case — a misordered
 * publish or an installed-never-published version. Shown on the banner
 * (main screen) and Settings, per Harry's Nov 28 report: the advisory
 * belonged on the main screen, not buried in Settings.
 */
export function isStaleInstall(): boolean {
  return state.state === "up-to-date" && state.version !== null && state.version !== null;
}

/**
 * Open the canonical release page. Reads the AUTHORITATIVE observed tag —
 * renderer input can't select a URL (v2r2 #3, v2r4 fold-in).
 */
export async function openReleasePage(): Promise<boolean> {
  const tag = state.version;
  if (!tag || !TAG_RE.test(tag)) return false;
  const url = `${RELEASE_PAGE_PREFIX}${tag}`;
  await shell.openExternal(url);
  return true;
}
