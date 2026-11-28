/**
 * Update-checker tests (Phase 1 contract, v2r4).
 * The derivation function + tag validation are pure — tested directly.
 * The full state machine needs an Electron harness; the pure core is
 * where the contract's failure modes live (equal→failure, older→failure,
 * newer→failure, no-prior→failure, recovery).
 */
import { describe, expect, it } from "vitest";

// Mirror of the derivation (update-checker.ts keeps it module-private —
// same decision-record pattern as LM's comparator tests). Keep in sync.
const TAG_RE = /^v\d+\.\d+\.\d+$/;

function versionSegments(tag: string): number[] | null {
  if (!TAG_RE.test(tag)) return null;
  return tag.slice(1).split(".").map(Number);
}

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

type Derived = { state: string; version: string | null; lastCheckError: string | null };

function derive(
  observed: { tag: string } | null,
  attempt: { error: string | null; at: number },
  installed: string,
): Derived {
  const observedTag = observed?.tag ?? null;
  const error = attempt.error;
  return {
    version: observedTag,
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

describe("update-checker: tag validation (v2r2 #1)", () => {
  it("accepts v-prefixed three-segment tags", () => {
    expect(TAG_RE.test("v0.4.0")).toBe(true);
    expect(TAG_RE.test("v1.2.3")).toBe(true);
  });
  it("rejects bare tags", () => {
    expect(TAG_RE.test("0.4.0")).toBe(false);
  });
  it("rejects suffixed tags", () => {
    expect(TAG_RE.test("v0.4.0-x")).toBe(false);
    expect(TAG_RE.test("v0.4.0-ls.1")).toBe(false);
  });
  it("rejects short and malformed", () => {
    expect(TAG_RE.test("v0.4")).toBe(false);
    expect(TAG_RE.test("v0.4.0?evil=1")).toBe(false);
    expect(TAG_RE.test("v0.4.0/../../etc")).toBe(false);
    expect(TAG_RE.test("")).toBe(false);
  });
});

describe("update-checker: version comparison", () => {
  it("strictly newer", () => {
    expect(isNewer("v0.5.0", "v0.4.0")).toBe(true);
    expect(isNewer("v1.0.0", "v0.99.99")).toBe(true);
    expect(isNewer("v0.4.1", "v0.4.0")).toBe(true);
  });
  it("equal is not newer", () => {
    expect(isNewer("v0.4.0", "v0.4.0")).toBe(false);
  });
  it("older is not newer (no downgrade)", () => {
    expect(isNewer("v0.3.0", "v0.4.0")).toBe(false);
  });
  it("malformed compares false, never throws", () => {
    expect(isNewer("garbage", "v0.4.0")).toBe(false);
    expect(isNewer("v0.4.0", "garbage")).toBe(false);
  });
});

describe("update-checker: stale-result derivation (v2r4 correction)", () => {
  const now = Date.now();
  const failure = { error: "timeout", at: now };
  const success = { error: null, at: now };

  it("equal→failure stays up-to-date, never available (THE counterexample)", () => {
    // Successful check observed v0.4.0 == installed; a later check times
    // out. The v2r3 bug would flip this to available. The corrected rule
    // derives from the SUCCESSFUL observation: up-to-date + stale error.
    const after = derive({ tag: "v0.4.0" }, failure, "v0.4.0");
    expect(after.state).toBe("up-to-date");
    expect(after.version).toBe("v0.4.0");
    expect(after.lastCheckError).toBe("timeout");
  });

  it("older→failure stays up-to-date (misordered publish visible, never offered)", () => {
    const after = derive({ tag: "v0.3.0" }, failure, "v0.4.0");
    expect(after.state).toBe("up-to-date");
    expect(after.version).toBe("v0.3.0");
  });

  it("newer→failure stays available (the version exists despite the hiccup)", () => {
    const after = derive({ tag: "v0.5.0" }, failure, "v0.4.0");
    expect(after.state).toBe("available");
    expect(after.version).toBe("v0.5.0");
    expect(after.lastCheckError).toBe("timeout");
  });

  it("no-prior→failure is error (never a banner from nothing)", () => {
    const after = derive(null, failure, "v0.4.0");
    expect(after.state).toBe("error");
    expect(after.version).toBeNull();
  });

  it("recovery: success after failure recomputes cleanly", () => {
    const after = derive({ tag: "v0.5.0" }, success, "v0.4.0");
    expect(after.state).toBe("available");
    expect(after.lastCheckError).toBeNull();
  });

  it("first-success equal is up-to-date", () => {
    const after = derive({ tag: "v0.4.0" }, success, "v0.4.0");
    expect(after.state).toBe("up-to-date");
  });
});

describe("update-checker: no-prior no-attempt is idle, not error", () => {
  it("idle before any check", () => {
    const after = derive(null, { error: null, at: Date.now() }, "v0.4.0");
    expect(after.state).toBe("idle");
  });
});
