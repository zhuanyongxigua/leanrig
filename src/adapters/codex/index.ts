import fs from "fs";
import path from "path";
import { homeDir, packageRoot } from "../../core/paths.js";
import type { Adapter, DetectResult, AdapterInstallOptions } from "../types.js";
import type { Finding } from "../../core/report.js";
import type {
  InstallPlan,
  PlannedFile,
  ClaudeMdPatch,
} from "../../core/installer.js";
import { deepMerge } from "../../core/jsonMerge.js";
import { stringify as stringifyToml } from "smol-toml";

// ---------------------------------------------------------------------------
// Asset ID -> { src path relative to assets/codex/, target filename }
//
// Codex subagents live as TOML files under <configDir>/agents/. Unlike Claude
// Code there is no output-style and no command-backed statusline, so those
// assets have no codex equivalent.
// ---------------------------------------------------------------------------
interface AssetMapping {
  src: string;
  target: string;
  executable?: boolean;
}

const ASSET_MAP: Record<string, AssetMapping> = {
  "agents/explorer": {
    src: "agents/explorer.toml",
    target: "agents/leanrig-explorer.toml",
  },
  "agents/worker": {
    src: "agents/worker.toml",
    target: "agents/leanrig-worker.toml",
  },
  "agents/reviewer": {
    src: "agents/reviewer.toml",
    target: "agents/leanrig-reviewer.toml",
  },
};

// ---------------------------------------------------------------------------
// Profile JSON shape
// ---------------------------------------------------------------------------
interface ProfileJson {
  name: string;
  extends?: string;
  description?: string;
  assets?: string[];
  vars?: Record<string, string>;
  settings?: Record<string, unknown>;
  /** Asset id under assets/codex/agents-md/ to append to AGENTS.md. */
  agentsMd?: string;
}

interface ResolvedProfile {
  assets: string[];
  vars: Record<string, string>;
  settings: Record<string, unknown>;
  agentsMd?: string;
}

/** Load and resolve profile with single-inheritance `extends`. */
function resolveProfile(
  name: string,
  profilesDir: string,
  seen: Set<string> = new Set()
): ResolvedProfile {
  if (seen.has(name)) {
    throw new Error(
      `Cyclic profile inheritance detected: ${[...seen, name].join(" -> ")}`
    );
  }
  seen.add(name);

  const profilePath = path.join(profilesDir, `${name}.json`);
  if (!fs.existsSync(profilePath)) {
    throw new Error(`Profile "${name}" not found at ${profilePath}`);
  }
  const raw = fs.readFileSync(profilePath, "utf8");
  const p = JSON.parse(raw) as ProfileJson;

  if (!p.extends) {
    return {
      assets: p.assets ?? [],
      vars: p.vars ?? {},
      settings: p.settings ?? {},
      agentsMd: p.agentsMd,
    };
  }

  const parent = resolveProfile(p.extends, profilesDir, seen);

  // Child assets APPEND to parent (union, parent-first, no duplicates).
  const childAssets = p.assets ?? [];
  const mergedAssets = [...parent.assets];
  for (const a of childAssets) {
    if (!mergedAssets.includes(a)) mergedAssets.push(a);
  }

  const mergedVars: Record<string, string> = {
    ...parent.vars,
    ...(p.vars ?? {}),
  };

  const mergedSettings = deepMerge(
    parent.settings,
    (p.settings ?? {}) as Record<string, unknown>
  );

  return {
    assets: mergedAssets,
    vars: mergedVars,
    settings: mergedSettings,
    // Child wins; otherwise inherit the parent's AGENTS.md block.
    agentsMd: p.agentsMd ?? parent.agentsMd,
  };
}

/** Substitute {{var}} placeholders. Throws on unresolved. */
function substituteVars(content: string, vars: Record<string, string>): string {
  return content.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    if (!(key in vars)) {
      throw new Error(`Unresolved placeholder: {{${key}}}`);
    }
    return vars[key]!;
  });
}

/** Substitute {{configDir}} in settings string values. */
function substituteConfigDir(
  obj: Record<string, unknown>,
  configDir: string
): Record<string, unknown> {
  const jsonStr = JSON.stringify(obj).replace(/\{\{configDir\}\}/g, configDir);
  return JSON.parse(jsonStr) as Record<string, unknown>;
}

/** Codex config dir: reads CODEX_HOME at call time, else ~/.codex. */
function getConfigDir(): string {
  return process.env["CODEX_HOME"] ?? path.join(homeDir(), ".codex");
}

// ---------------------------------------------------------------------------
// Adapter implementation
// ---------------------------------------------------------------------------
//
// NOTE: detect()/doctor() deliberately do NOT shell out to `codex --version`.
// `leanrig doctor` advertises itself as a read-only audit, but the codex CLI's
// own startup is not side-effect-free (observed on codex-cli 0.139.0: a plain
// `codex --version` attempts to create PATH aliases). Probing it would break the
// read-only contract, so installation is detected purely from the config dir's
// existence — same approach as the claude-code adapter.
export const codexAdapter: Adapter = {
  name: "codex",

  async detect(): Promise<DetectResult> {
    const configDir = getConfigDir();
    const installed = fs.existsSync(configDir);
    return {
      installed,
      configDir,
      detail: installed
        ? `Config dir found: ${configDir}`
        : `Config dir not found: ${configDir}`,
    };
  },

  async doctor(): Promise<Finding[]> {
    const configDir = getConfigDir();
    const installed = fs.existsSync(configDir);

    const header: Finding = installed
      ? {
          level: "info",
          title: "Codex detected",
          detail: configDir,
        }
      : {
          level: "warn",
          title: "Codex config dir not found",
          detail: `Expected: ${configDir}. Set CODEX_HOME or install Codex CLI.`,
        };

    const findings: Finding[] = [header];

    // Output-cap check: recommend tool_output_token_limit if config.toml lacks it.
    const configToml = path.join(configDir, "config.toml");
    if (installed && fs.existsSync(configToml)) {
      const raw = fs.readFileSync(configToml, "utf8");
      if (!/^\s*tool_output_token_limit\s*=/m.test(raw)) {
        findings.push({
          level: "info",
          title: "tool_output_token_limit not set in config.toml",
          detail:
            "Uncapped tool output flows into context. The safe/balanced profiles set this.",
        });
      }
    }

    return findings;
  },

  async listProfiles(): Promise<string[]> {
    const pkgRoot = packageRoot();
    const profilesDir = path.join(pkgRoot, "profiles", "codex");
    if (!fs.existsSync(profilesDir)) return [];
    return fs
      .readdirSync(profilesDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => path.basename(f, ".json"));
  },

  async planInstall(
    profileName: string,
    _opts: AdapterInstallOptions
  ): Promise<InstallPlan> {
    const configDir = getConfigDir();
    const pkgRoot = packageRoot();
    const profilesDir = path.join(pkgRoot, "profiles", "codex");
    const assetsDir = path.join(pkgRoot, "assets", "codex");

    const resolved = resolveProfile(profileName, profilesDir);

    const plannedFiles: PlannedFile[] = [];
    for (const assetId of resolved.assets) {
      const mapping = ASSET_MAP[assetId];
      if (!mapping) {
        throw new Error(
          `Unknown asset id: "${assetId}". Known ids: ${Object.keys(ASSET_MAP).join(", ")}`
        );
      }
      const srcPath = path.join(assetsDir, mapping.src);
      if (!fs.existsSync(srcPath)) {
        throw new Error(`Asset file not found: ${srcPath}`);
      }
      const rawContent = fs.readFileSync(srcPath, "utf8");
      const content = substituteVars(rawContent, resolved.vars);
      const targetAbs = path.join(configDir, mapping.target);

      plannedFiles.push({
        assetId,
        targetAbs,
        content,
        executable: mapping.executable,
      });
    }

    // config.toml: append a `#`-marker-wrapped TOML block rather than merging.
    // A user's config.toml is often a large hand-written file (model providers,
    // dozens of trusted projects, MCP servers, comments). Reparsing/reserializing
    // it via smol-toml would drop comments and reorder keys, so instead leanrig's
    // keys are rendered as a trailing TOML fragment and appended; TOML's
    // last-value-wins semantics make the appended scalar keys take effect, and
    // rollback removes only that block — the rest of the file is byte-for-byte
    // untouched. (This mirrors the AGENTS.md block-append below.)
    let tomlBlockPatch: ClaudeMdPatch | undefined;
    if (Object.keys(resolved.settings).length > 0) {
      const resolvedSettings = substituteConfigDir(resolved.settings, configDir);
      // IMPORTANT: profile `settings` must stay FLAT (top-level scalar keys only).
      // The block is prepended above the user's tables; if a profile ever nests a
      // value, stringifyToml emits a `[table]` header mid-block and any scalar
      // after it would scope under that table instead of top-level. Keep codex
      // profile settings limited to top-level scalars (e.g. tool_output_token_limit).
      const block = stringifyToml(resolvedSettings).trimEnd();
      tomlBlockPatch = {
        fileAbs: path.join(configDir, "config.toml"),
        block,
        markerStart: "# leanrig:start",
        markerEnd: "# leanrig:end",
        // Prepend: top-level keys must precede any [table] header to stay
        // top-level (a trailing block would be scoped to the file's last table).
        prepend: true,
      };
    }

    // Codex's AGENTS.md is the analog of Claude Code's CLAUDE.md: a Markdown
    // instructions file. We reuse the same marker-block append mechanism
    // (ClaudeMdPatch) — append-only, idempotent, surgically removable.
    let agentsMdPatch: ClaudeMdPatch | undefined;
    if (resolved.agentsMd) {
      const srcPath = path.join(
        assetsDir,
        "agents-md",
        `${resolved.agentsMd}.md`
      );
      if (!fs.existsSync(srcPath)) {
        throw new Error(`AGENTS.md asset not found: ${srcPath}`);
      }
      const block = substituteVars(fs.readFileSync(srcPath, "utf8"), resolved.vars);
      agentsMdPatch = { fileAbs: path.join(configDir, "AGENTS.md"), block };
    }

    return {
      harness: "codex",
      profile: profileName,
      configDir,
      files: plannedFiles,
      claudeMd: agentsMdPatch,
      tomlBlock: tomlBlockPatch,
    };
  },
};
