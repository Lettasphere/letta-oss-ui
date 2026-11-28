/**
 * Updates tab (Phase 1, manual browser flow — v2r4 contract).
 * Current version + update state + manual check + the browser action.
 * Stale-honest: availability claims cite lastSuccessfulCheckAt; errors
 * cite lastAttemptAt. A known-available version survives failed rechecks
 * (the error line rides alongside, never replacing the availability).
 */
import { useEffect, useState } from "react";

import { useAppStore } from "../store";

export function UpdateSection() {
  const update = useAppStore((state) => state.update);
  const [checking, setChecking] = useState(false);
  const version = update.version?.replace(/^v/, "") ?? null;

  const onCheck = async () => {
    setChecking(true);
    try {
      await window.bridge.checkForUpdates();
    } finally {
      // The store's update slice refreshes via the broadcast event; the
      // local flag only covers the button's in-flight disable.
      setChecking(false);
    }
  };

  const staleNote =
    update.lastCheckError && update.version
      ? ` · last check failed: ${update.lastCheckError}`
      : update.lastCheckError
        ? ` · ${update.lastCheckError}`
        : "";
  const checkedNote = update.lastSuccessfulCheckAt
    ? ` · checked ${timeAgo(update.lastSuccessfulCheckAt)}`
    : "";

  return (
    <section className="mt-3 space-y-3">
      <div className="flex items-center gap-3">
        <CurrentVersion />
      </div>

      {update.state === "unsupported" && (
        <p className="text-sm text-muted">
          Updates are unsupported in development builds. Package the app to enable update checks.
        </p>
      )}

      {update.state !== "unsupported" && (
        <>
          <div className="text-sm text-ink-700">
            {update.state === "available" && version && (
              <>
                <span className="font-medium">{version} is available</span>
                <span className="text-muted">{staleNote || checkedNote}</span>
                <button
                  type="button"
                  className="ml-3 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
                  onClick={() => void window.bridge.openReleasePage()}
                >
                  Get the update
                </button>
              </>
            )}
            {update.state === "up-to-date" && (
              <>
                Up to date
                <span className="text-muted">{staleNote || checkedNote}</span>
              </>
            )}
            {update.state === "checking" && <span className="text-muted">Checking…</span>}
            {update.state === "idle" && <span className="text-muted">Not checked yet this session.</span>}
            {update.state === "error" && (
              <>
                <span className="text-red-600">{update.lastCheckError ?? "Update check failed."}</span>
              </>
            )}
          </div>

          {/* The version note: an observed-older-than-installed release
              surfaces as a warning, never an offer (v2r3 #2). */}
          {update.state === "up-to-date" && update.version && version && (
            <p className="text-xs text-muted">
              {`GitHub's selected latest (${version}) matches or is older than your installed version — no newer release found under this policy.`}
            </p>
          )}

          <button
            type="button"
            disabled={checking || update.state === "checking"}
            className="rounded-md border border-border px-3 py-1.5 text-sm text-ink-700 hover:bg-surface-tertiary disabled:opacity-40"
            onClick={() => void onCheck()}
          >
            {checking || update.state === "checking" ? "Checking…" : "Check for updates"}
          </button>
        </>
      )}
    </section>
  );
}

function timeAgo(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}


function CurrentVersion() {
  const [v, setV] = useState<string | null>(null);
  useEffect(() => {
    void window.bridge.getAppVersion().then(setV).catch(() => setV(null));
  }, []);
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-ink-700">
        Current version: <span className="font-medium">{v ?? "…"}</span>
      </span>
    </div>
  );
}
