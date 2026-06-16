# LeanRig — Design (v0.1)

Internal contract for implementation. README is the marketing surface; this file is the engineering truth.

## Goal

A CLI (`leanrig`) that installs **safe, reversible cost-control profiles** into AI coding agent harnesses. v0.1 ships one adapter: **claude-code**.

Commands (v0.1):

```
leanrig doctor [harness]                      # read-only audit of token waste
leanrig install <harness> --profile <name>    # install a profile (--dry-run, --force)
leanrig diff [harness]                        # what changed since install (vs backup)
leanrig rollback [harness]                    # restore pre-install state (--force)
leanrig profiles [harness]                    # list available profiles
leanrig bench                                 # stub in v0.1: prints roadmap notice
```

Default harness: `claude-code`.

## Non-goals (v0.1)

- No benchmark engine (stub only).
- No command-rewriting for arbitrary Bash and no PreToolUse Bash hooks.
- No integration with third-party tools (LeanCTX, squeez, ccusage) beyond doctor *detection*.
- No telemetry, no network calls at runtime.

## Stack

- TypeScript, Node >= 20, ESM (`"type": "module"`).
- Runtime deps: `commander`, `picocolors`, `diff`, `smol-toml`. Nothing else.
  - `smol-toml` (zero-dependency, ESM, parse+serialize) was added for the **codex** adapter:
    Codex config lives in `~/.codex/config.toml`, and per-key merge of TOML (mirroring the JSON
    `deepMerge` used for Claude Code's `settings.json`) needs a real TOML reader/writer. Chosen over
    `@iarna/toml` for being actively maintained, ESM-native, and supporting serialization. This is the
    one deliberate widening of the "nothing else" rule; any further runtime dep needs the same justification.
- Dev deps: `typescript`, `vitest`, `@types/node`.
- Build: `tsc` → `dist/`. Bin: `dist/index.js` (shebang).
- npm package `leanrig` (same as the CLI command; GitHub repo may differ); `files`: `dist`, `assets`, `profiles`, `README.md`, `LICENSE`.

## Layout

```
src/
  index.ts                  # commander CLI entry
  commands/                 # thin command handlers; logic lives in core/adapters
  core/
    paths.ts                # LEANRIG_HOME (~/.leanrig), per-adapter config dirs
    state.ts                # ~/.leanrig/state.json (install history)
    manifest.ts             # manifest types + io
    backup.ts               # snapshot/restore engine
    installer.ts            # executes InstallPlan (dry-run, backup, write, merge, manifest)
    jsonMerge.ts            # deep merge for settings.json patches
    diffRender.ts           # unified diff rendering (uses `diff` package)
    report.ts               # Finding {level: ok|info|warn}, terminal renderer
  adapters/
    types.ts                # Adapter interface
    claude-code/
      index.ts              # detect(), doctor(), planInstall()
      doctorChecks.ts
assets/claude-code/         # template files (shipped in package, copied on install)
  agents/  skills/  output-styles/  hooks/  statusline/
profiles/claude-code/       # safe.json balanced.json
test/                       # vitest; all fs tests run against tmp dirs
docs/claude-code-facts.md   # verified doc facts (env vars, schemas) — source of truth for adapter
```

## Core concepts

### Adapter

```ts
interface Adapter {
  name: string;                       // "claude-code"
  detect(): Promise<DetectResult>;    // installed? config dir? version?
  doctor(): Promise<Finding[]>;       // read-only
  planInstall(profileName: string): Promise<InstallPlan>;
}
```

The engine (installer/backup/rollback/diff) is **harness-agnostic**: no claude-specific strings outside `adapters/claude-code/` and its assets/profiles dirs.

### InstallPlan

```ts
interface PlannedFile { assetId: string; targetAbs: string; content: string; executable?: boolean }
interface SettingsPatch { fileAbs: string; merge: Record<string, unknown> }  // deep-merged
interface InstallPlan { harness: string; profile: string; files: PlannedFile[]; settings?: SettingsPatch }
```

### Profiles

JSON, may `extends` another profile (single inheritance, assets unioned, vars/settings deep-merged, child wins).

```json
{
  "name": "balanced",
  "extends": "safe",
  "description": "...",
  "assets": ["agents/explorer", "agents/worker", "agents/reviewer", "skills/delegate"],
  "vars": { "explorerModel": "haiku", "workerModel": "sonnet", "reviewerModel": "sonnet" },
  "settings": { "env": { "BASH_MAX_OUTPUT_LENGTH": "20000" } }
}
```

Assets are templates with `{{var}}` substitution from `vars`. Installed claude files are prefixed `leanrig-` (e.g. `agents/leanrig-explorer.md`) so ownership is unambiguous.

### Manifest + state

Every install writes `~/.leanrig/backups/<id>/manifest.json`:

```json
{
  "version": 1, "harness": "claude-code", "profile": "balanced",
  "createdAt": "...", "configDir": "/Users/x/.claude",
  "files": [{ "target": "...", "existedBefore": false, "backupRelPath": null, "writtenHash": "sha256..." }],
  "settings": { "path": "...", "backupRelPath": "...", "writtenHash": "..." }
}
```

`~/.leanrig/state.json` keeps the install list + last install id per harness. `LEANRIG_HOME` env var overrides `~/.leanrig` (required for tests).

## Safety invariants (reviewer: verify each)

1. Any file we modify or overwrite is copied into the backup dir **first**.
2. Rollback only (a) deletes files with `existedBefore: false`, (b) restores backups, (c) for the CLAUDE.md append entry, surgically removes only the marked block (`<!-- leanrig:start -->`..`<!-- leanrig:end -->`), preserving surrounding user content; if the markers are gone it restores the full backup under `--force`. It never touches unlisted files.
3. If a target file exists with different content and was not written by us → **skip + warn**; overwrite only with `--force` (still backed up).
4. If a manifest file's current hash ≠ `writtenHash` (user edited it after install), rollback/overwrite of that file requires `--force`.
5. `--dry-run` writes nothing anywhere (including `~/.leanrig`).
6. settings.json is parsed, deep-merged, and re-serialized (2-space indent); rollback restores the backed-up file wholesale.
7. Doctor is strictly read-only.
8. Re-installing the same profile over itself with no drift is a no-op (idempotent; reported as such).
9. **One active layer per harness.** Backups always capture the user's *true pre-leanrig* state, never a prior leanrig install. A single `rollback` always returns the configDir to that true original, no matter how many times the user re-installed. Re-installing when an active install exists is implemented as *internal rollback-to-original, then fresh install* — it never stacks a layer over leanrig's own files. Installing a **different** profile while one is active is refused unless `--force` (message: "<harness> already has profile '<X>' installed. Run `leanrig rollback` first, or re-run with --force to replace it."). With `--force`, the replace path runs the internal rollback (force) then installs the new profile.

## Doctor checks (claude-code)

Read-only; sources: `$CLAUDE_CONFIG_DIR` or `~/.claude`, `~/.claude.json`, project `./CLAUDE.md` + `./.claude/`, `./.mcp.json`. Checks: CLAUDE.md size (warn > 200 lines per official guidance); output-limit env caps unset (`BASH_MAX_OUTPUT_LENGTH`, `MAX_MCP_OUTPUT_TOKENS`, `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, subagent cap per facts doc); `CLAUDE_CODE_SUBAGENT_MODEL` set (overrides per-agent routing); agents missing `model` frontmatter; MCP server count; output style / statusline / hooks presence; leanrig backup state. Exact env names and schemas come from `docs/claude-code-facts.md` — do not invent them.

## Testing

Vitest. All fs tests run with `LEANRIG_HOME` and `CLAUDE_CONFIG_DIR` pointed at per-test tmp dirs — **tests must never touch the real `~/.claude` or `~/.leanrig`**. Required coverage: jsonMerge apply semantics; install→rollback byte-exact roundtrip (created files removed, modified files restored); collision policy (skip vs `--force`); user-edit detection via hash; dry-run writes nothing; profile inheritance resolution.

## Third-party tools — recommender, not installer (`tools` + leanrig-doctor skill)

LeanRig **recommends third-party tools and shows their official install commands, but never installs them.** The repo and npm package contain only our own code plus a metadata registry (name, license, source URL, official install/remove commands as text). We never vendor third-party code, prompts, or binaries, never run remote scripts (`curl | bash`), and never run a tool's installer on the user's behalf. The user installs through each tool's own channel.

This replaces the earlier `add`/`remove` design: leanrig only writes its **own** reversible config (profiles); everything third-party is guidance. That removes the highest-risk, highest-maintenance code (running `npm install -g` / `claude plugin install`, the per-key settings un-merge engine) and keeps the trust story simple.

### Commands

```
leanrig tools [harness] [--json]   # list registry entries + read-only install detection + official install commands
leanrig doctor [harness] [--json]  # audit; --json feeds the leanrig-doctor skill
```

`tools` is read-only: it detects what's already installed and prints each tool's official `install` string for the user to copy/paste. There is no `add`/`remove`.

### ToolSpec (adapter-provided registry; engine stays harness-agnostic)

```ts
interface ToolSpec {
  id: string;             // "ccusage-statusline" | "caveman" | "squeez" | "lean-ctx"
  title: string;
  description: string;    // what it saves, one line
  license: string;        // SPDX, from facts doc
  source: string;         // homepage/repo URL
  install: string;        // official install instructions — DISPLAYED, never executed
  remove?: string;        // official uninstall instructions — displayed
  overlaps?: string;      // human-readable overlap warning shown by tools + doctor
}

interface ToolStatus { installed: boolean; detail?: string }
```

Adapter gains optional **read-only** methods: `listTools?()`, `detectTool?(id)`. There is no `planAddTool`/`planRemoveTool` and no `ToolPlan`. Adapters without these simply have no tools.

### Engine: `core/tools.ts`

Reduced to a read-only `CommandRunner` (`run(argv): {code, stdout, stderr}`, real impl `child_process.spawnSync`, no `shell: true`) used **only for detection probes** (`claude plugin list`, `lean-ctx --version`). Tests inject a fake runner — **tests never execute real npm/claude/squeez commands**. No manifests, no settings un-merge, no `~/.leanrig/tools/` state.

### Registry contents (facts from docs/claude-code-facts.md "Third-party tools" table)

- `ccusage-statusline` — install = settings.json `statusLine` snippet; overlap: replaces any current statusLine, incl. leanrig's.
- `caveman` — install = `claude plugin marketplace add` + `claude plugin install`; overlap: stacks with Token Saver output style; pick one.
- `squeez` — install = `npm install -g squeez` + `squeez setup`; overlap: composes with `BASH_MAX_OUTPUT_LENGTH`; doctor notes redundancy.
- `lean-ctx` — install = `brew tap` + `brew install`.

### leanrig-doctor skill (the diagnose → recommend bridge)

A Claude Code skill shipped as an asset (`assets/claude-code/skills/doctor/SKILL.md`, installed by `balanced`+). The deterministic CLI measures; the skill judges. It runs `leanrig doctor --json` + `leanrig tools --json`, then uses the model to map findings → prioritized fixes (config-level wins first via `leanrig install`, then third-party tools that match an actual finding), respecting `overlaps` and skipping already-installed tools. It presents official install commands; it never runs third-party installers.

### Doctor additions

- Detect each registry tool (info-level: "third-party tool X detected").
- Overlap notes: squeez detected AND `BASH_MAX_OUTPUT_LENGTH` set → info (double compression, generally fine but worth knowing); caveman detected AND `outputStyle` set → info.

### Safety rules (extend the v0.1 invariants)

10. The npm package never contains third-party code, prompt text, or binaries — registry metadata only.
11. leanrig never installs or uninstalls third-party software: registry `install`/`remove` strings are displayed for the user to run, never executed. Detection probes are read-only argv (no shell), and nothing is piped from the network into an interpreter.
12. `tools` and the leanrig-doctor skill surface license + source + official commands so the user chooses and installs deliberately.

## Roadmap

`bench`; more adapters (codex, gemini-cli, opencode); default-on tool-output hooks.
