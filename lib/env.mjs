// OCP env-var parsing helpers.
//
// Fail-closed positive-integer parsing for numeric caps (body size, image
// byte/count limits). A misconfigured cap must NEVER silently disable a guard:
// `parseInt("unlimited", 10)` is NaN and `x > NaN` is always false, so a naive
// parse of CLAUDE_MAX_BODY_SIZE=unlimited would remove the body-size limit
// entirely (unbounded body → OOM). Likewise CLAUDE_MAX_BODY_SIZE=5MB naively
// parses to 5 (bytes) and bricks the proxy. So a present-but-invalid value is
// REJECTED (default kept, caller warns), not accepted. (PR #154 review F3.)
//
// Pure (no env access, no IO) so it is unit-testable without a live server.

// Parse `raw` as a strictly-positive base-10 integer of bytes/count (no unit
// suffix). Returns { value, ok, reason }:
//   - missing/empty        → { value: def, ok: true }               (use default)
//   - valid positive int   → { value: n,  ok: true }
//   - anything else        → { value: def, ok: false, reason }      (fail closed)
// Rejects: NaN ("unlimited"), non-positive ("0", "-1"), unit-suffixed ("5MB"),
// and fractional/ambiguous ("20.5", "0x10") values — String(n) !== trimmed catches
// any input parseInt only partially consumed.
export function parsePositiveInt(raw, def) {
  if (raw === undefined || raw === null || raw === "") return { value: def, ok: true };
  const trimmed = String(raw).trim();
  const n = parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0 || String(n) !== trimmed) {
    return { value: def, ok: false, reason: "not a strictly-positive integer (bytes/count, no unit suffix)" };
  }
  return { value: n, ok: true };
}

// ── CLAUDE_TOOLS: which built-in tools the default (-p) spawn is OFFERED ─────────────────────────
//
// Resolves the raw environment value to the argument for `claude --tools`, or null when the
// variable is absent, so no flag is passed and the CLI's own default set applies.
//
//   absent                          → null         (no --tools; behaviour unchanged)
//   "" / whitespace / commas only   → ""           (disable every built-in tool)
//   "none", any case, as the whole value → ""      (the same, spelled so it survives Windows)
//   " Bash , Read "                 → "Bash,Read"
//
// EMPTY MEANS NONE -- the opposite of OCP_TUI_TOOLS (lib/tui/session.mjs), where empty or
// whitespace-only means unset and every tool stays on. That divergence is deliberate, and it
// follows from what each variable is for. OCP_TUI_TOOLS is an opt-in NARROWING of a tool-using
// pane, so a stray blank must not silently disable tools an agent depends on. CLAUDE_TOOLS exists
// to RESTRICT, so a blank fails closed: the worst case is an instance that cannot use tools, which
// is loud, rather than one that can, which is silent. `claude --help` itself defines "" as
// "disable all tools", and this keeps that meaning rather than inverting it.
//
// WHY A "none" SENTINEL AS WELL. An empty environment variable does not survive Windows' own
// shells: PowerShell 5.1 `$env:CLAUDE_TOOLS = ""` and cmd `set CLAUDE_TOOLS=` both DELETE the
// variable [measured]. Deleted reads as absent and absent means every tool, so on those shells the
// empty spelling fails open, silently -- the very defect this variable exists to fix. "none"
// survives every shell. It is matched only as the WHOLE value, so a tool list is never
// reinterpreted.
//
// Split on commas only, never on whitespace: a scoped name such as "Bash(git commit:*)" contains a
// space. CLAUDE_ALLOWED_TOOLS is split the same way.
export function resolveToolsEnv(raw) {
  if (raw === undefined || raw === null) return null;
  const entries = String(raw).split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.length === 1 && entries[0].toLowerCase() === "none") return "";
  return entries.join(",");
}

// Boot gate: CLAUDE_TOOLS cannot be honoured in TUI mode, so REFUSE rather than ignore it.
//
// A TUI pane never reaches buildCliArgs; its tool surface is OCP_TUI_TOOLS / OCP_TUI_FULL_TOOLS,
// so CLAUDE_TOOLS is inert there. OCP_LOCAL_TOOLS sits in exactly the same position and only
// WARNS. The difference is the direction each one fails in. Ignoring OCP_LOCAL_TOOLS leaves the
// model believing it has no tools, which is safe. Ignoring CLAUDE_TOOLS leaves a restriction the
// operator asked for unapplied, with every built-in tool on, which is not. And a line in a boot log
// is exactly the signal that let the instance that prompted this run with every tool for its
// whole life while the log said so.
//
// Nor can it be translated: OCP_TUI_TOOLS reads empty as "every tool", so there is no faithful
// rewrite of a "" into it. Returns the fatal message, or null. The caller exits.
export function toolsModeError({ tools, tuiMode }) {
  if (tools === null || tools === undefined || !tuiMode) return null;
  return "CLAUDE_TOOLS is set but CLAUDE_TUI_MODE=true. CLAUDE_TOOLS governs only the default (-p) spawn -- a TUI pane never reads it -- so the restriction would be silently ignored with every built-in tool left on. Unset CLAUDE_TOOLS, or turn TUI mode off; in TUI mode the tool surface is OCP_TUI_TOOLS, whose empty value means every tool, not none.";
}

// CLAUDE_ALLOWED_TOOLS set to empty is the misconfiguration this whole variable was found from: it
// reads as "no tools" and resolves to the default set, every tool on. It cannot be made to mean
// "no tools" -- --allowedTools only pre-approves -- and changing what it resolves to would re-rule
// the grandfathered /health field that reports it (Class B.2, ADR 0006). So the fix is to say so
// at boot. Whitespace and bare commas count as empty. Returns the warning, or null.
export function allowedToolsEmptyWarning(raw) {
  if (raw === undefined || raw === null) return null;
  if (String(raw).split(",").some((s) => s.trim() !== "")) return null;
  return "CLAUDE_ALLOWED_TOOLS is set but empty. It only PRE-APPROVES tools and cannot remove one, so the default set still applies and every built-in tool is available. To disable tools on the default path, set CLAUDE_TOOLS=none.";
}
