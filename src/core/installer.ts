import fs from "fs";
import path from "path";
import pc from "picocolors";
import {
  hashContent,
  hashFile,
  generateBackupId,
  backupFile,
  restoreFile,
  deleteAndPruneDirs,
} from "./backup.js";
import { deepMerge } from "./jsonMerge.js";
import { mergeTomlString } from "./tomlMerge.js";
import {
  writeManifest,
  readManifest,
  type Manifest,
  type ManifestFile,
  type ManifestClaudeMd,
} from "./manifest.js";
import { addInstall, removeInstall, getLastInstallId } from "./state.js";
import { leanrigHome } from "./paths.js";
import type { Finding } from "./report.js";

export interface PlannedFile {
  assetId: string;
  targetAbs: string;
  content: string;
  executable?: boolean;
}

export interface SettingsPatch {
  fileAbs: string;
  merge: Record<string, unknown>;
  /**
   * Serialization format of the target settings file. Defaults to "json"
   * (Claude Code's settings.json). "toml" is used by the codex adapter, whose
   * config lives in ~/.codex/config.toml. The deep-merge semantics are identical;
   * only parse/stringify differ. Backup, hashing, rollback, and diff operate on
   * raw bytes and are format-agnostic.
   */
  format?: "json" | "toml";
}

/**
 * Append a marker-delimited block to a user-owned text file. Appended, never
 * overwritten; idempotent (re-install is a no-op if the block is present);
 * rollback removes only the block, preserving surrounding user content
 * byte-for-byte (including comments and formatting outside the block).
 *
 * Used for Claude Code's CLAUDE.md and Codex's AGENTS.md (Markdown comment
 * markers, the default), and for Codex's config.toml (TOML `#` comment markers
 * — passed explicitly). This append-only approach is why a complex hand-written
 * config.toml is never reparsed/reserialized: only a trailing block is added.
 */
export interface ClaudeMdPatch {
  fileAbs: string;
  block: string;
  /** Opening marker line. Defaults to the Markdown `<!-- leanrig:start -->`. */
  markerStart?: string;
  /** Closing marker line. Defaults to the Markdown `<!-- leanrig:end -->`. */
  markerEnd?: string;
  /**
   * Place the block at the TOP of the file instead of the bottom. Required for
   * TOML config.toml: a trailing block would be parsed as belonging to whatever
   * `[table]` the file happens to end inside, so top-level scalar keys must be
   * prepended (before any table header) to stay top-level. Defaults to false
   * (append) for Markdown targets.
   */
  prepend?: boolean;
}

/** Resolved block-append computation for one patch (internal). */
interface BlockPlan {
  start: string;
  end: string;
  /** Final file content, or null when the block is already present (no-op). */
  newContent: string | null;
  unchanged: boolean;
}

export interface InstallPlan {
  harness: string;
  profile: string;
  configDir: string;
  files: PlannedFile[];
  settings?: SettingsPatch;
  /** Markdown block-append target (CLAUDE.md / AGENTS.md). */
  claudeMd?: ClaudeMdPatch;
  /**
   * A SECOND block-append target, used by the codex adapter for config.toml so
   * a complex hand-written TOML file is never reparsed/reserialized — leanrig's
   * keys are appended as a `#`-marker-wrapped trailing block instead (TOML's
   * last-wins semantics make the appended scalars take effect). Same append /
   * idempotent / surgical-rollback guarantees as `claudeMd`.
   */
  tomlBlock?: ClaudeMdPatch;
}

/** Default (Markdown) marker comments wrapping leanrig's appended block. */
export const CLAUDE_MD_START = "<!-- leanrig:start -->";
export const CLAUDE_MD_END = "<!-- leanrig:end -->";

/**
 * Final file content after appending leanrig's block, or null when the block is
 * already present (idempotent no-op). Markers are passed in so the same routine
 * serves Markdown (CLAUDE.md/AGENTS.md) and TOML (config.toml).
 */
function buildClaudeMdContent(
  current: string,
  block: string,
  markerStart: string,
  markerEnd: string,
  prepend = false
): string | null {
  if (current.includes(markerStart)) return null;
  const wrapped = `${markerStart}\n${block.trim()}\n${markerEnd}\n`;
  if (prepend) {
    // Top-of-file: the block's top-level keys must precede any [table] header
    // so they are parsed as top-level (TOML scoping). Keep the user's content
    // verbatim after a blank-line separator.
    const rest = current.replace(/^\s*/, "");
    return rest.length > 0 ? `${wrapped}\n${rest}` : wrapped;
  }
  const base = current.replace(/\s*$/, "");
  return base.length > 0 ? `${base}\n\n${wrapped}` : wrapped;
}

export interface InstallOptions {
  dryRun: boolean;
  force: boolean;
}

export interface InstallResult {
  findings: Finding[];
  /** true if nothing was written (all-unchanged no-op) */
  noOp: boolean;
}

/** Load the manifest for the most recent install of `harness`, if any. */
function loadPreviousManifest(harness: string): Manifest | null {
  const lastId = getLastInstallId(harness);
  if (!lastId) return null;
  const backupDir = path.join(leanrigHome(), "backups", lastId);
  const manifest = readManifest(backupDir);
  if (!manifest) {
    // State claims an active install but its manifest is gone/unreadable.
    // Returning null here would make install() treat the harness as fresh and
    // stack a new backup layer over leanrig's own files (re-opening the
    // rollback-layering bug invariant #9 prevents). Fail loudly instead.
    throw new Error(
      `leanrig state references install "${lastId}" for ${harness}, but its manifest is ` +
        `missing or unreadable (${path.join(backupDir, "manifest.json")}). State may be corrupted. ` +
        `Remove ${path.join(leanrigHome(), "state.json")} or restore the backup before retrying.`
    );
  }
  return manifest;
}

/** Compute what the merged settings content would be (JSON or TOML). */
function computeMergedSettings(
  fileAbs: string,
  merge: Record<string, unknown>,
  format: "json" | "toml" = "json"
): string {
  const existing = fs.existsSync(fileAbs)
    ? fs.readFileSync(fileAbs, "utf8")
    : "";
  if (format === "toml") {
    return mergeTomlString(existing, merge);
  }
  let base: Record<string, unknown> = {};
  if (existing.trim().length > 0) {
    try {
      base = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      base = {};
    }
  }
  const merged = deepMerge(base, merge);
  return JSON.stringify(merged, null, 2) + "\n";
}

export async function runInstall(
  plan: InstallPlan,
  opts: InstallOptions
): Promise<InstallResult> {
  const findings: Finding[] = [];
  const prevManifest = loadPreviousManifest(plan.harness);

  // Build a lookup: target -> writtenHash from previous manifest
  const prevHashes = new Map<string, string>();
  if (prevManifest) {
    for (const f of prevManifest.files) {
      prevHashes.set(f.target, f.writtenHash);
    }
    if (prevManifest.settings) {
      prevHashes.set(prevManifest.settings.path, prevManifest.settings.writtenHash);
    }
  }

  // --- Collision detection pass ---
  type FileAction = "create" | "overwrite" | "skip" | "unchanged";
  const fileActions = new Map<string, FileAction>();

  for (const pf of plan.files) {
    const existsNow = fs.existsSync(pf.targetAbs);
    if (!existsNow) {
      fileActions.set(pf.targetAbs, "create");
      continue;
    }
    const currentContent = fs.readFileSync(pf.targetAbs, "utf8");
    const currentHash = hashContent(currentContent);
    const newHash = hashContent(pf.content);

    if (currentHash === newHash) {
      fileActions.set(pf.targetAbs, "unchanged");
      continue;
    }

    const prevHash = prevHashes.get(pf.targetAbs);
    if (prevHash === undefined) {
      // Not from a previous leanrig install
      if (opts.force) {
        fileActions.set(pf.targetAbs, "overwrite");
        findings.push({
          level: "warn",
          title: `Overwriting non-leanrig file (--force): ${pf.targetAbs}`,
        });
      } else {
        fileActions.set(pf.targetAbs, "skip");
        findings.push({
          level: "warn",
          title: `Skipping collision (not from leanrig): ${pf.targetAbs}`,
          detail: "Use --force to overwrite.",
        });
      }
    } else {
      // From a previous leanrig install — check if user edited it since
      if (currentHash !== prevHash && !opts.force) {
        // User hand-edited after install; protect it
        fileActions.set(pf.targetAbs, "skip");
        findings.push({
          level: "warn",
          title: `Skipping (modified since install): ${pf.targetAbs}`,
          detail: "Use --force to overwrite.",
        });
      } else {
        // Untouched since install, or --force supplied → overwrite
        fileActions.set(pf.targetAbs, "overwrite");
      }
    }
  }

  // Determine settings action
  let settingsAction: FileAction = "create";
  let mergedSettingsContent = "";
  if (plan.settings) {
    mergedSettingsContent = computeMergedSettings(
      plan.settings.fileAbs,
      plan.settings.merge,
      plan.settings.format ?? "json"
    );
    if (fs.existsSync(plan.settings.fileAbs)) {
      const currentHash = hashFile(plan.settings.fileAbs);
      const mergedHash = hashContent(mergedSettingsContent);
      if (currentHash === mergedHash) {
        settingsAction = "unchanged";
      } else {
        settingsAction = "overwrite";
      }
    }
  }

  // Determine block-append actions (append-only, idempotent). Markers default
  // to Markdown comments but a patch may override them (codex's config.toml uses
  // TOML `#` comments). `claudeMd` is the Markdown target (CLAUDE.md/AGENTS.md);
  // `tomlBlock` is the optional second target (codex config.toml).
  const computeBlock = (patch: ClaudeMdPatch | undefined): BlockPlan => {
    const start = patch?.markerStart ?? CLAUDE_MD_START;
    const end = patch?.markerEnd ?? CLAUDE_MD_END;
    if (!patch) return { start, end, newContent: null, unchanged: true };
    const current = fs.existsSync(patch.fileAbs)
      ? fs.readFileSync(patch.fileAbs, "utf8")
      : "";
    const newContent = buildClaudeMdContent(
      current,
      patch.block,
      start,
      end,
      patch.prepend ?? false
    );
    return { start, end, newContent, unchanged: newContent === null };
  };
  const claudeMdPlan = computeBlock(plan.claudeMd);
  const tomlBlockPlan = computeBlock(plan.tomlBlock);
  const claudeMdNewContent = claudeMdPlan.newContent;
  const claudeMdUnchanged = claudeMdPlan.unchanged;

  // Check if everything is unchanged (re-install same profile = no-op)
  const allFilesUnchanged = [...fileActions.values()].every(
    (a) => a === "unchanged" || a === "skip"
  );
  const settingsUnchanged = !plan.settings || settingsAction === "unchanged";

  if (opts.dryRun) {
    // Print plan, write nothing
    console.log(pc.bold("\nDry-run plan:"));
    for (const pf of plan.files) {
      const action = fileActions.get(pf.targetAbs) ?? "create";
      const label = actionLabel(action);
      console.log(`  ${label}  ${pf.targetAbs}`);
    }
    if (plan.settings) {
      const label = actionLabel(settingsAction);
      console.log(`  ${label}  ${plan.settings.fileAbs} (settings merge)`);
      const backupId = generateBackupId();
      const backupDir = path.join(leanrigHome(), "backups", backupId);
      console.log(pc.dim(`  (backup would go to ${backupDir})`));
    }
    if (plan.claudeMd) {
      const label = actionLabel(claudeMdUnchanged ? "unchanged" : "append");
      console.log(`  ${label}  ${plan.claudeMd.fileAbs} (${path.basename(plan.claudeMd.fileAbs)} block, appended)`);
    }
    if (plan.tomlBlock) {
      const label = actionLabel(tomlBlockPlan.unchanged ? "unchanged" : "append");
      const where = plan.tomlBlock.prepend ? "prepended" : "appended";
      console.log(`  ${label}  ${plan.tomlBlock.fileAbs} (${path.basename(plan.tomlBlock.fileAbs)} block, ${where})`);
    }
    // Reflect the real replace/refuse behavior so the preview isn't misleading.
    if (
      prevManifest &&
      !(allFilesUnchanged && settingsUnchanged && claudeMdUnchanged && tomlBlockPlan.unchanged)
    ) {
      if (prevManifest.profile !== plan.profile && !opts.force) {
        console.log(
          pc.yellow(
            `  note: profile "${prevManifest.profile}" is already installed — this would be REFUSED. ` +
              `Rollback first or use --force to replace.`
          )
        );
      } else {
        console.log(
          pc.dim(
            `  note: would replace the existing "${prevManifest.profile}" install (internal rollback to original, then reinstall).`
          )
        );
      }
    }
    findings.push({ level: "info", title: "Dry-run: no files written." });
    return { findings, noOp: false };
  }

  // Check no-op BEFORE doing anything
  if (allFilesUnchanged && settingsUnchanged && claudeMdUnchanged && tomlBlockPlan.unchanged) {
    findings.push({
      level: "ok",
      title: `Profile "${plan.profile}" already installed — nothing to do.`,
    });
    return { findings, noOp: true };
  }

  // --- One-active-layer invariant ---
  // If there is already an active install for this harness AND we are about to
  // write something (not a no-op), we must NOT stack a new backup layer on top
  // of leanrig's own files. Instead:
  //   1. If a DIFFERENT profile is requested without --force, refuse.
  //   2. Otherwise, internally roll back the existing install (force=true so
  //      even user-edited files revert to true original), then proceed with a
  //      fresh install. This guarantees exactly one active layer whose backups
  //      always reflect the true pre-leanrig disk state.
  if (prevManifest) {
    const differentProfile = prevManifest.profile !== plan.profile;
    if (differentProfile && !opts.force) {
      // Refuse: user must explicitly opt in to replacing
      throw new Error(
        `${plan.harness} already has profile '${prevManifest.profile}' installed. ` +
          `Run \`leanrig rollback\` first, or re-run with --force to replace it.`
      );
    }
    // Internal rollback: restore to true original before fresh install.
    // This must use force=true so even user-edited files are reverted.
    await runRollback(plan.harness, { force: true });
    // After internal rollback the disk is at true original and state has no
    // active install for this harness.  Re-compute file actions from scratch.
    return runInstall(plan, opts);
  }

  // --- Actual install ---
  const backupId = generateBackupId();
  const backupDir = path.join(leanrigHome(), "backups", backupId);
  fs.mkdirSync(backupDir, { recursive: true });

  const manifestFiles: ManifestFile[] = [];

  for (const pf of plan.files) {
    // FIX 5: guard that every target stays inside configDir
    const rel = path.relative(plan.configDir, pf.targetAbs);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(
        `Security: target "${pf.targetAbs}" escapes configDir "${plan.configDir}". Aborting.`
      );
    }

    const action = fileActions.get(pf.targetAbs) ?? "create";

    if (action === "skip") {
      findings.push({
        level: "warn",
        title: `Skipped: ${pf.targetAbs}`,
      });
      continue;
    }

    const existedBefore = fs.existsSync(pf.targetAbs);
    let backupRelPath: string | null = null;

    if (existedBefore) {
      backupRelPath = `files/${path.basename(pf.targetAbs)}`;
      // Make unique if needed
      let counter = 0;
      let unique = backupRelPath;
      while (fs.existsSync(path.join(backupDir, unique))) {
        unique = `files/${counter}_${path.basename(pf.targetAbs)}`;
        counter++;
      }
      backupRelPath = unique;
      backupFile(pf.targetAbs, backupDir, backupRelPath);
    }

    if (action !== "unchanged") {
      fs.mkdirSync(path.dirname(pf.targetAbs), { recursive: true });
      fs.writeFileSync(pf.targetAbs, pf.content, "utf8");
      if (pf.executable) {
        fs.chmodSync(pf.targetAbs, 0o755);
      }
    }

    const writtenHash = hashContent(pf.content);
    manifestFiles.push({
      target: pf.targetAbs,
      existedBefore,
      backupRelPath,
      writtenHash,
    });

    findings.push({
      level: "ok",
      title: `${action === "unchanged" ? "Unchanged" : action === "create" ? "Created" : "Updated"}: ${pf.targetAbs}`,
    });
  }

  // Settings
  let manifestSettings: Manifest["settings"] = undefined;
  if (plan.settings && settingsAction !== "unchanged") {
    const existedBefore = fs.existsSync(plan.settings.fileAbs);
    let backupRelPath: string | null = null;
    if (existedBefore) {
      backupRelPath = `${path.basename(plan.settings.fileAbs)}.bak`;
      backupFile(plan.settings.fileAbs, backupDir, backupRelPath);
    }
    fs.mkdirSync(path.dirname(plan.settings.fileAbs), { recursive: true });
    fs.writeFileSync(plan.settings.fileAbs, mergedSettingsContent, "utf8");
    const writtenHash = hashContent(mergedSettingsContent);
    manifestSettings = {
      path: plan.settings.fileAbs,
      existedBefore,
      backupRelPath,
      writtenHash,
    };
    findings.push({
      level: "ok",
      title: `Settings merged: ${plan.settings.fileAbs}`,
    });
  } else if (plan.settings && settingsAction === "unchanged") {
    findings.push({
      level: "ok",
      title: `Settings unchanged: ${plan.settings.fileAbs}`,
    });
  }

  // Block-append targets (append-only; full file backed up for the
  // markers-gone path). Shared by the Markdown target (CLAUDE.md/AGENTS.md) and
  // the optional TOML target (codex config.toml). Both basenames differ within
  // a single install, so `${basename}.bak` backup names never collide.
  const writeBlock = (
    patch: ClaudeMdPatch | undefined,
    blockPlan: BlockPlan
  ): ManifestClaudeMd | undefined => {
    if (patch && blockPlan.newContent !== null) {
      const fileAbs = patch.fileAbs;
      const existedBefore = fs.existsSync(fileAbs);
      let backupRelPath: string | null = null;
      if (existedBefore) {
        backupRelPath = `${path.basename(fileAbs)}.bak`;
        backupFile(fileAbs, backupDir, backupRelPath);
      }
      fs.mkdirSync(path.dirname(fileAbs), { recursive: true });
      fs.writeFileSync(fileAbs, blockPlan.newContent, "utf8");
      findings.push({
        level: "ok",
        title: `${existedBefore ? "Appended leanrig block to" : "Created"}: ${fileAbs}`,
      });
      return {
        path: fileAbs,
        existedBefore,
        backupRelPath,
        writtenHash: hashContent(blockPlan.newContent),
        blockStart: blockPlan.start,
        blockEnd: blockPlan.end,
      };
    }
    if (patch) {
      findings.push({
        level: "ok",
        title: `${path.basename(patch.fileAbs)} block already present: ${patch.fileAbs}`,
      });
    }
    return undefined;
  };

  const manifestClaudeMd = writeBlock(plan.claudeMd, claudeMdPlan);
  const manifestTomlBlock = writeBlock(plan.tomlBlock, tomlBlockPlan);

  // Write manifest
  const manifest: Manifest = {
    version: 1,
    harness: plan.harness,
    profile: plan.profile,
    createdAt: new Date().toISOString(),
    configDir: plan.configDir,
    files: manifestFiles,
    settings: manifestSettings,
    claudeMd: manifestClaudeMd,
    tomlBlock: manifestTomlBlock,
  };
  writeManifest(backupDir, manifest);

  // Update state
  addInstall({
    id: backupId,
    harness: plan.harness,
    profile: plan.profile,
    createdAt: manifest.createdAt,
  });

  return { findings, noOp: false };
}

function actionLabel(action: string): string {
  switch (action) {
    case "create":
      return pc.green("create  ");
    case "overwrite":
      return pc.yellow("overwrite");
    case "skip":
      return pc.yellow("skip    ");
    case "unchanged":
      return pc.dim("unchanged");
    case "append":
      return pc.green("append  ");
    default:
      return action;
  }
}

export interface RollbackOptions {
  force: boolean;
}

export interface RollbackResult {
  findings: Finding[];
}

export async function runRollback(
  harness: string,
  opts: RollbackOptions
): Promise<RollbackResult> {
  const findings: Finding[] = [];
  const lastId = getLastInstallId(harness);
  if (!lastId) {
    findings.push({
      level: "warn",
      title: `No install found for harness "${harness}".`,
    });
    return { findings };
  }

  const backupDir = path.join(leanrigHome(), "backups", lastId);
  const manifest = readManifest(backupDir);
  if (!manifest) {
    findings.push({
      level: "warn",
      title: `Manifest not found in ${backupDir}`,
    });
    return { findings };
  }

  // Track whether any target was left in place (user-edited, no --force). A
  // partial rollback must NOT de-register the install or delete its backup —
  // the user needs both intact to finish with --force later.
  let skippedAny = false;

  for (const mf of manifest.files) {
    if (!fs.existsSync(mf.target)) {
      if (!mf.existedBefore) {
        // Already gone — fine
        findings.push({ level: "ok", title: `Already removed: ${mf.target}` });
        continue;
      } else {
        findings.push({
          level: "warn",
          title: `File to restore is missing: ${mf.target}`,
        });
        continue;
      }
    }

    // Check if user edited after install
    const currentHash = hashFile(mf.target);
    if (currentHash !== mf.writtenHash) {
      if (!opts.force) {
        findings.push({
          level: "warn",
          title: `Skipping (user-edited after install): ${mf.target}`,
          detail: "Use --force to restore anyway.",
        });
        skippedAny = true;
        continue;
      } else {
        findings.push({
          level: "warn",
          title: `Restoring user-edited file (--force): ${mf.target}`,
        });
      }
    }

    if (!mf.existedBefore) {
      deleteAndPruneDirs(mf.target, manifest.configDir);
      findings.push({ level: "ok", title: `Deleted: ${mf.target}` });
    } else if (mf.backupRelPath) {
      restoreFile(backupDir, mf.backupRelPath, mf.target);
      findings.push({ level: "ok", title: `Restored: ${mf.target}` });
    }
  }

  // Settings rollback
  if (manifest.settings) {
    const s = manifest.settings;
    const settingsExists = fs.existsSync(s.path);

    if (settingsExists) {
      const currentHash = hashFile(s.path);
      if (currentHash !== s.writtenHash) {
        if (!opts.force) {
          findings.push({
            level: "warn",
            title: `Skipping settings (user-edited after install): ${s.path}`,
            detail: "Use --force to restore anyway.",
          });
          skippedAny = true;
        } else {
          findings.push({
            level: "warn",
            title: `Restoring user-edited settings (--force): ${s.path}`,
          });
          if (!s.existedBefore) {
            fs.unlinkSync(s.path);
          } else if (s.backupRelPath) {
            restoreFile(backupDir, s.backupRelPath, s.path);
          }
        }
      } else {
        if (!s.existedBefore) {
          fs.unlinkSync(s.path);
          findings.push({ level: "ok", title: `Deleted settings: ${s.path}` });
        } else if (s.backupRelPath) {
          restoreFile(backupDir, s.backupRelPath, s.path);
          findings.push({
            level: "ok",
            title: `Restored settings: ${s.path}`,
          });
        }
      }
    }
  }

  // Block rollback: surgically remove only leanrig's marked block, preserving
  // the user's surrounding content byte-for-byte. If the markers are gone (user
  // edited them away), fall back to the full backup under --force. Shared by the
  // Markdown target (CLAUDE.md/AGENTS.md) and the TOML target (codex config.toml);
  // messages are named after the actual file. Returns true if it skipped.
  const rollbackBlock = (c: ManifestClaudeMd): boolean => {
    const mdName = path.basename(c.path);
    if (!fs.existsSync(c.path)) {
      findings.push({
        level: c.existedBefore ? "warn" : "ok",
        title: c.existedBefore
          ? `${mdName} to restore is missing: ${c.path}`
          : `Already removed: ${c.path}`,
      });
      return false;
    }
    const current = fs.readFileSync(c.path, "utf8");
    const startIdx = current.indexOf(c.blockStart);
    const endIdx = current.indexOf(c.blockEnd);
    if (startIdx !== -1 && endIdx > startIdx) {
      // Splice out [blockStart .. blockEnd], collapsing the blank-line
      // separator we inserted before it.
      const before = current.slice(0, startIdx).replace(/\n+$/, "");
      const after = current
        .slice(endIdx + c.blockEnd.length)
        .replace(/^\n+/, "");
      const joined =
        before.length > 0 && after.length > 0
          ? `${before}\n\n${after}`
          : before + after;
      if (joined.trim().length === 0) {
        if (!c.existedBefore) {
          deleteAndPruneDirs(c.path, manifest.configDir);
          findings.push({
            level: "ok",
            title: `Deleted ${mdName} (created by leanrig): ${c.path}`,
          });
        } else if (c.backupRelPath) {
          restoreFile(backupDir, c.backupRelPath, c.path);
          findings.push({ level: "ok", title: `Restored ${mdName}: ${c.path}` });
        }
      } else {
        fs.writeFileSync(c.path, joined.replace(/\s*$/, "\n"), "utf8");
        findings.push({
          level: "ok",
          title: `Removed leanrig block from ${mdName}: ${c.path}`,
        });
      }
      return false;
    }
    // Markers not found — user removed/altered them.
    if (!opts.force) {
      findings.push({
        level: "warn",
        title: `Skipping ${mdName} (leanrig block markers not found): ${c.path}`,
        detail: "Use --force to restore the pre-install backup.",
      });
      return true;
    } else if (!c.existedBefore) {
      deleteAndPruneDirs(c.path, manifest.configDir);
      findings.push({
        level: "warn",
        title: `Deleted ${mdName} (--force, markers gone): ${c.path}`,
      });
    } else if (c.backupRelPath) {
      restoreFile(backupDir, c.backupRelPath, c.path);
      findings.push({
        level: "warn",
        title: `Restored ${mdName} from backup (--force): ${c.path}`,
      });
    }
    return false;
  };

  if (manifest.claudeMd && rollbackBlock(manifest.claudeMd)) skippedAny = true;
  if (manifest.tomlBlock && rollbackBlock(manifest.tomlBlock)) skippedAny = true;

  if (skippedAny) {
    // Partial rollback: leave the install registered AND its backup on disk so
    // the user can complete it with --force. De-registering now would strand the
    // remaining leanrig files with no way to roll them back.
    findings.push({
      level: "warn",
      title: `Rollback incomplete for "${harness}": some files were edited after install and were left in place.`,
      detail: "Re-run `leanrig rollback --force` to finish.",
    });
    return { findings };
  }

  removeInstall(harness, lastId);
  // Backup dir has served its purpose now that the install is fully reverted.
  // Removing it keeps ~/.leanrig/backups from growing without bound across
  // repeated install/rollback (and internal replace) cycles.
  fs.rmSync(backupDir, { recursive: true, force: true });
  return { findings };
}

export interface DiffResult {
  findings: Finding[];
}

export async function runDiff(harness: string): Promise<DiffResult> {
  const { createTwoFilesPatch } = await import("diff");
  const findings: Finding[] = [];

  const lastId = getLastInstallId(harness);
  if (!lastId) {
    findings.push({
      level: "warn",
      title: `No install found for harness "${harness}".`,
    });
    return { findings };
  }

  const backupDir = path.join(leanrigHome(), "backups", lastId);
  const manifest = readManifest(backupDir);
  if (!manifest) {
    findings.push({
      level: "warn",
      title: `Manifest not found in ${backupDir}`,
    });
    return { findings };
  }

  for (const mf of manifest.files) {
    const targetExists = fs.existsSync(mf.target);
    const currentContent = targetExists
      ? fs.readFileSync(mf.target, "utf8")
      : "";

    const backupContent =
      mf.backupRelPath && mf.existedBefore
        ? fs.readFileSync(path.join(backupDir, mf.backupRelPath), "utf8")
        : "";

    const currentHash = hashContent(currentContent);

    if (!targetExists) {
      findings.push({
        level: "info",
        title: `Deleted since install: ${mf.target}`,
      });
      continue;
    }

    if (currentHash === mf.writtenHash) {
      findings.push({ level: "ok", title: `Unchanged: ${mf.target}` });
      continue;
    }

    findings.push({
      level: "warn",
      title: `Modified since install: ${mf.target}`,
    });

    const patch = createTwoFilesPatch(
      "backup" + (mf.backupRelPath ? `/${mf.backupRelPath}` : " (none)"),
      mf.target,
      backupContent,
      currentContent,
      "",
      ""
    );
    console.log(patch);
  }

  return { findings };
}
