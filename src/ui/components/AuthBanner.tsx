import { useAppStore } from "../store";

/**
 * The remote-registration spawn's OAuth device-flow, surfaced. When the
 * spawned `letta server` needs sign-in (no stored key), it opens the browser
 * itself — but focus-stealing and headless moments lose that window. This
 * banner gives the user the link (re-openable), the user code, and live
 * status until the flow completes.
 */
export function AuthBanner() {
  const auth = useAppStore((state) => state.remoteAuth);

  if (auth.status === "idle" || auth.status === "done") return null;

  if (auth.status === "failed") {
    return (
      <div
        role="alert"
        className="fixed left-1/2 top-4 z-[60] flex max-w-lg -translate-x-1/2 items-start gap-3 rounded-xl border border-error/20 bg-error-light px-4 py-3 shadow-elevated"
      >
        <span className="min-w-0 break-words text-sm text-error">
          {auth.reason === "replacement"
            ? "This machine's remote went offline and restoring it needs sign-in"
            : "Remote sign-in didn't complete"}
          {auth.error ? `: ${auth.error}` : "."} Switch the execution mode off and on to retry.
        </span>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="fixed left-1/2 top-4 z-[60] flex max-w-lg -translate-x-1/2 items-start gap-3 rounded-xl border border-accent/30 bg-surface px-4 py-3 shadow-elevated"
    >
      <div className="min-w-0">
        <div className="text-sm font-medium text-ink-900">
          {auth.reason === "replacement"
            ? "This machine's remote went offline — authorize to restore it"
            : "Go to your browser to authorize this app"}
        </div>
        <div className="mt-1 text-xs text-muted">
          {auth.userCode ? (
            <>
              Your code: <span className="font-mono text-ink-900">{auth.userCode}</span>
            </>
          ) : (
            "Waiting for the sign-in page…"
          )}
        </div>
        {auth.url && (
          <button
            type="button"
            className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-ink-900 hover:bg-surface-tertiary"
            onClick={() => {
              void window.bridge.openRemoteAuthUrl({ url: auth.url! });
            }}
          >
            Open the authorization page
          </button>
        )}
      </div>
    </div>
  );
}
