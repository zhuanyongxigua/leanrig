#!/usr/bin/env node
import { program } from "commander";
import pc from "picocolors";
import {
  registerAdapter,
  getAdapter,
  listAdapters,
} from "./adapters/types.js";
import { claudeCodeAdapter } from "./adapters/claude-code/index.js";
import { codexAdapter } from "./adapters/codex/index.js";
import { renderFindings } from "./core/report.js";
import {
  runInstall,
  runRollback,
  runDiff,
} from "./core/installer.js";

// Register built-in adapters
registerAdapter(claudeCodeAdapter);
registerAdapter(codexAdapter);

const DEFAULT_HARNESS = "claude-code";

function resolveAdapter(harness: string | undefined) {
  const name = harness ?? DEFAULT_HARNESS;
  const adapter = getAdapter(name);
  if (!adapter) {
    const available = listAdapters().join(", ");
    console.error(
      pc.red(`Unknown harness: "${name}". Available: ${available}`)
    );
    process.exit(1);
  }
  return adapter;
}

/**
 * Wrap an async command action so any thrown error renders as a clean
 * one-line message and exits non-zero, instead of dumping a Node stack
 * trace. Expected refusals (e.g. installing over an existing profile) and
 * unexpected failures both surface the same way.
 */
function action<A extends unknown[]>(
  fn: (...args: A) => Promise<void>
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(pc.red(`error: ${(err as Error).message}`));
      process.exit(1);
    }
  };
}

program
  .name("leanrig")
  .description("Install safe, reversible cost-control profiles into AI coding agent harnesses.")
  .version("0.4.0");

// doctor
program
  .command("doctor [harness]")
  .description("Read-only audit of your harness configuration.")
  .option("--json", "Output findings as JSON (for scripts and the leanrig-doctor skill)", false)
  .action(action(async (harness: string | undefined, opts: { json: boolean }) => {
    const adapter = resolveAdapter(harness);
    const detectResult = await adapter.detect();
    const findings = await adapter.doctor();
    if (opts.json) {
      // Machine-readable: only the findings go to stdout. Keep the
      // not-detected note on stderr so it never corrupts the JSON.
      if (!detectResult.installed) {
        console.error(`Harness "${adapter.name}" not detected: ${detectResult.detail ?? ""}`);
      }
      console.log(JSON.stringify(findings, null, 2));
      return;
    }
    if (!detectResult.installed) {
      console.log(pc.yellow(`Harness "${adapter.name}" not detected: ${detectResult.detail ?? ""}`));
    }
    renderFindings(findings);
  }));

// install
program
  .command("install <harness>")
  .description("Install a profile into a harness.")
  .requiredOption("--profile <name>", "Profile name to install")
  .option("--dry-run", "Print plan without writing anything", false)
  .option("--force", "Overwrite colliding files and user-edited files", false)
  .action(action(async (harness: string, opts: { profile: string; dryRun: boolean; force: boolean }) => {
    const adapter = resolveAdapter(harness);
    const plan = await adapter.planInstall(opts.profile, { force: opts.force });
    const result = await runInstall(plan, { dryRun: opts.dryRun, force: opts.force });
    renderFindings(result.findings);
    if (result.noOp) {
      console.log(pc.dim("(No changes made.)"));
    }
  }));

// diff
program
  .command("diff [harness]")
  .description("Show what changed in installed files since the install.")
  .action(action(async (harness?: string) => {
    const adapter = resolveAdapter(harness);
    const result = await runDiff(adapter.name);
    renderFindings(result.findings);
  }));

// rollback
program
  .command("rollback [harness]")
  .description("Restore the pre-install state.")
  .option("--force", "Restore even user-edited files", false)
  .action(action(async (harness: string | undefined, opts: { force: boolean }) => {
    const adapter = resolveAdapter(harness);
    const result = await runRollback(adapter.name, { force: opts.force });
    renderFindings(result.findings);
  }));

// profiles
program
  .command("profiles [harness]")
  .description("List available profiles for a harness.")
  .action(action(async (harness?: string) => {
    const adapter = resolveAdapter(harness);
    const profiles = await adapter.listProfiles();
    if (profiles.length === 0) {
      console.log(pc.dim("No profiles found."));
    } else {
      console.log(pc.bold(`Profiles for ${adapter.name}:`));
      for (const p of profiles) {
        console.log(`  ${p}`);
      }
    }
  }));

// tools — read-only registry: what's installed + official install commands.
// leanrig never installs third-party tools; it shows the commands for you to run.
program
  .command("tools [harness]")
  .description("List third-party cost-saving tools, install status, and their official install commands.")
  .option("--json", "Output the registry as JSON (for scripts and the leanrig-doctor skill)", false)
  .action(action(async (harness: string | undefined, opts: { json: boolean }) => {
    const adapter = resolveAdapter(harness);
    if (!adapter.listTools) {
      if (opts.json) {
        console.log("[]");
      } else {
        console.log(pc.dim(`No tools registry for harness "${adapter.name}".`));
      }
      return;
    }
    const entries = await adapter.listTools();

    if (opts.json) {
      const out = entries.map(({ spec, status }) => ({
        ...spec,
        installed: status.installed,
        detail: status.detail,
      }));
      console.log(JSON.stringify(out, null, 2));
      return;
    }

    if (entries.length === 0) {
      console.log(pc.dim("No tools in registry."));
      return;
    }
    console.log(pc.bold(`Tools for ${adapter.name}:`));
    for (const { spec, status } of entries) {
      const statusStr = status.installed
        ? pc.green("installed")
        : pc.dim("not installed");
      console.log(`  ${pc.bold(spec.id)}  [${statusStr}]  ${spec.license}`);
      console.log(`    ${spec.description}`);
      if (spec.overlaps) {
        console.log(pc.yellow(`    overlap: ${spec.overlaps}`));
      }
      if (status.installed) {
        if (status.detail) console.log(pc.dim(`    ${status.detail}`));
      } else {
        const indented = spec.install
          .split("\n")
          .map((l) => `      ${l}`)
          .join("\n");
        console.log(pc.dim(`    install (run yourself — leanrig won't):`));
        console.log(pc.dim(indented));
      }
    }
    console.log(
      pc.dim(
        "\nleanrig shows official install commands but never runs them. " +
          "Copy/paste to install through each tool's own channel."
      )
    );
  }));

// bench
program
  .command("bench")
  .description("Benchmark token usage (planned).")
  .action(() => {
    console.log(pc.dim("bench: planned — not yet implemented."));
  });

program.parse(process.argv);
