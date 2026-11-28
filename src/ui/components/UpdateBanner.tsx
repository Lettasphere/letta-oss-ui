/**
 * Update banner (Phase 1, manual browser flow — v2r4 contract).
 *
 * Renders at the top of the chat view when a NEWER release is observed
 * (state === "available") and the user hasn't dismissed the banner this
 * process. The single action opens the canonical release page in the
 * browser — the URL is main-process constructed from the observed tag;
 * this component can't select a URL. Dismissal is process-lifetime
 * (Harry's requirement: re-show on launch); the newer-version re-arm
 * extension is OFF per the v2r4 note.
 */
import { CloseIcon } from "./icons.js";

import { useAppStore } from "../store";

export function UpdateBanner() {
  const update = useAppStore((state) => state.update);
  // Available → the update banner. Up-to-date with an observed version →
  // the advisory line (matched/older install — Harry: it belongs on the
  // main screen, not just Settings). Both dismissable per-version.
  const isUpdate = update.state === "available" && update.version !== null;
  const isAdvisory =
    update.state === "up-to-date" && update.version !== null && update.version !== undefined;
  const dismissed = update.dismissedFor === update.version;
  const show = (isUpdate || isAdvisory) && !dismissed;
  if (!show) return null;

  if (isAdvisory) {
    return (
      <div
        role="status"
        className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-border bg-surface-tertiary px-3 py-2 text-xs text-muted"
      >
        <span>
          {`Running ${update.version?.replace(/^v/, "")} — GitHub's latest matches or is older. No newer release found.`}
        </span>
        <button
          type="button"
          aria-label="Dismiss advisory"
          className="ml-auto rounded-md p-1 hover:bg-surface"
          onClick={() => {
            void window.bridge.dismissUpdateBanner();
          }}
        >
          <CloseIcon className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }

  return (
    <div
      role="alert"
      className="mx-3 mt-2 flex items-center gap-2 rounded-lg border border-border bg-surface-tertiary px-3 py-2 text-xs text-muted"
    >
      <span className="font-medium text-ink-800">
        ⬆ Lettasphere Desktop {update.version?.replace(/^v/, "")} is available.
      </span>
      <button
        type="button"
        className="rounded-md bg-accent px-2 py-1 font-medium text-white hover:opacity-90"
        onClick={() => {
          void window.bridge.openReleasePage();
        }}
      >
        Get the update
      </button>
      <button
        type="button"
        aria-label="Dismiss update banner"
        className="ml-auto rounded-md p-1 hover:bg-surface"
        onClick={() => {
          void window.bridge.dismissUpdateBanner();
        }}
      >
        <CloseIcon className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
