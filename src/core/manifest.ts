import fs from "fs";
import path from "path";

export interface ManifestFile {
  target: string;
  existedBefore: boolean;
  backupRelPath: string | null;
  writtenHash: string;
}

export interface ManifestSettings {
  path: string;
  existedBefore: boolean;
  backupRelPath: string | null;
  writtenHash: string;
}

/**
 * Record of a marker-delimited block appended to the user's CLAUDE.md.
 * Unlike a whole-file asset, install appends a block (never overwrites) and
 * rollback removes only that block, preserving the user's surrounding content.
 * The full pre-install file is still backed up for the markers-missing path.
 */
export interface ManifestClaudeMd {
  path: string;
  existedBefore: boolean;
  backupRelPath: string | null;
  writtenHash: string;
  blockStart: string;
  blockEnd: string;
}

export interface Manifest {
  version: 1;
  harness: string;
  profile: string;
  createdAt: string;
  configDir: string;
  files: ManifestFile[];
  settings?: ManifestSettings;
  claudeMd?: ManifestClaudeMd;
  /** Second block-append target (codex config.toml); same shape as claudeMd. */
  tomlBlock?: ManifestClaudeMd;
}

export function writeManifest(backupDir: string, manifest: Manifest): void {
  fs.mkdirSync(backupDir, { recursive: true });
  const dest = path.join(backupDir, "manifest.json");
  fs.writeFileSync(dest, JSON.stringify(manifest, null, 2) + "\n", "utf8");
}

export function readManifest(backupDir: string): Manifest | null {
  const src = path.join(backupDir, "manifest.json");
  if (!fs.existsSync(src)) return null;
  const raw = fs.readFileSync(src, "utf8");
  return JSON.parse(raw) as Manifest;
}
