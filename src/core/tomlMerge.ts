import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { deepMerge } from "./jsonMerge.js";

/**
 * Deep-merge a TOML `patch` (already a plain object) onto the parsed contents
 * of an existing TOML document string.
 *
 * smol-toml parses TOML into ordinary JS objects/arrays/scalars, so the actual
 * merge reuses `deepMerge` — identical semantics to Claude Code's settings.json
 * merge (plain objects recurse, arrays/scalars/null are replaced by the patch).
 * Only the (de)serialization differs.
 *
 * `existing` is the raw current file contents ("" if the file does not exist);
 * a malformed existing document is treated as empty (mirrors computeMergedSettings'
 * tolerance for an unparseable settings.json) so a broken file never blocks install.
 */
export function mergeTomlString(
  existing: string,
  patch: Record<string, unknown>
): string {
  let base: Record<string, unknown> = {};
  if (existing.trim().length > 0) {
    try {
      base = parseToml(existing) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  const merged = deepMerge(base, patch);
  // smol-toml emits no trailing newline; add one for POSIX-friendly files.
  return stringifyToml(merged) + "\n";
}
