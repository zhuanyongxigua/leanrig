import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";
import { parse as parseToml } from "smol-toml";
import { runInstall, runRollback } from "../src/core/installer.js";
import { mergeTomlString } from "../src/core/tomlMerge.js";

/**
 * The codex adapter reads CODEX_HOME at call time and resolves profiles/assets
 * from the real package root. Tests point CODEX_HOME + LEANRIG_HOME at tmp dirs
 * so nothing touches the real ~/.codex or ~/.leanrig.
 */
function setupTmpEnv() {
  const leanrigHome = fs.mkdtempSync(path.join(os.tmpdir(), "leanrig-codex-home-"));
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), "leanrig-codex-cfg-"));
  process.env["LEANRIG_HOME"] = leanrigHome;
  process.env["CODEX_HOME"] = codexHome;
  return {
    leanrigHome,
    codexHome,
    cleanup() {
      delete process.env["LEANRIG_HOME"];
      delete process.env["CODEX_HOME"];
      fs.rmSync(leanrigHome, { recursive: true, force: true });
      fs.rmSync(codexHome, { recursive: true, force: true });
    },
  };
}

async function getPlan(profileName: string) {
  const { codexAdapter } = await import("../src/adapters/codex/index.js");
  return codexAdapter.planInstall(profileName, { force: false });
}

// ---------------------------------------------------------------------------
// tomlMerge unit
// ---------------------------------------------------------------------------
describe("mergeTomlString", () => {
  it("preserves existing user keys and adds patch keys", () => {
    const existing = `model = "gpt-5.5"\napproval_policy = "on-request"\n\n[mcp_servers.foo]\ncommand = "x"\n`;
    const merged = mergeTomlString(existing, { tool_output_token_limit: 12000 });
    const parsed = parseToml(merged) as Record<string, unknown>;
    expect(parsed["model"]).toBe("gpt-5.5");
    expect(parsed["approval_policy"]).toBe("on-request");
    expect(parsed["tool_output_token_limit"]).toBe(12000);
    // nested user table untouched
    expect((parsed["mcp_servers"] as any).foo.command).toBe("x");
  });

  it("patch wins on key conflict", () => {
    const merged = mergeTomlString(`tool_output_token_limit = 99\n`, {
      tool_output_token_limit: 12000,
    });
    const parsed = parseToml(merged) as Record<string, unknown>;
    expect(parsed["tool_output_token_limit"]).toBe(12000);
  });

  it("treats a malformed existing document as empty (never throws)", () => {
    const merged = mergeTomlString(`this is = = not valid toml [[[`, {
      model: "gpt-5.4-mini",
    });
    const parsed = parseToml(merged) as Record<string, unknown>;
    expect(parsed["model"]).toBe("gpt-5.4-mini");
  });

  it("empty base yields just the patch", () => {
    const merged = mergeTomlString("", { tool_output_token_limit: 12000 });
    expect(parseToml(merged)).toEqual({ tool_output_token_limit: 12000 });
  });
});

// ---------------------------------------------------------------------------
// Profile plan resolution
// ---------------------------------------------------------------------------
describe("codex profile plan resolution", () => {
  let env: ReturnType<typeof setupTmpEnv>;
  beforeEach(() => {
    env = setupTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  function assertNoUnresolvedPlaceholders(plan: Awaited<ReturnType<typeof getPlan>>) {
    for (const file of plan.files) {
      expect(file.content, `Unresolved {{ in ${file.targetAbs}`).not.toMatch(/\{\{/);
    }
    if (plan.tomlBlock) {
      expect(plan.tomlBlock.block).not.toMatch(/\{\{/);
    }
  }

  it("safe: explorer agent + toml output cap (config.toml block), no statusline/output-style", async () => {
    const plan = await getPlan("safe");
    const targets = plan.files.map((f) => f.targetAbs);
    expect(targets.some((t) => t.endsWith("agents/leanrig-explorer.toml"))).toBe(true);
    // codex has no statusline or output-style assets
    expect(targets.some((t) => t.includes("statusline"))).toBe(false);
    expect(targets.some((t) => t.includes("output-style"))).toBe(false);
    // config.toml is a block-append (TOML `#` markers), NOT a settings merge —
    // so a hand-written config.toml is never reparsed/reserialized.
    expect(plan.settings).toBeUndefined();
    expect(plan.tomlBlock).toBeDefined();
    expect(plan.tomlBlock!.fileAbs.endsWith("config.toml")).toBe(true);
    expect(plan.tomlBlock!.markerStart).toBe("# leanrig:start");
    expect(plan.tomlBlock!.block).toMatch(/tool_output_token_limit\s*=\s*12000/);
    assertNoUnresolvedPlaceholders(plan);
  });

  it("balanced: includes worker + reviewer; appends AGENTS.md delegation block", async () => {
    const plan = await getPlan("balanced");
    const targets = plan.files.map((f) => f.targetAbs);
    expect(targets.some((t) => t.endsWith("agents/leanrig-explorer.toml"))).toBe(true);
    expect(targets.some((t) => t.endsWith("agents/leanrig-worker.toml"))).toBe(true);
    expect(targets.some((t) => t.endsWith("agents/leanrig-reviewer.toml"))).toBe(true);
    expect(plan.claudeMd).toBeDefined();
    expect(plan.claudeMd!.fileAbs.endsWith("AGENTS.md")).toBe(true);
    expect(plan.claudeMd!.block).toMatch(/leanrig-explorer|delegat/i);
    assertNoUnresolvedPlaceholders(plan);
  });

  it("balanced: sets no top-level model — premium stays the main coordinator", async () => {
    const plan = await getPlan("balanced");
    // The config.toml block must not pin a top-level model.
    expect(plan.tomlBlock!.block).not.toMatch(/^\s*model\s*=/m);
  });

  it("reviewer agent omits the model key so it inherits the main session model", async () => {
    const plan = await getPlan("balanced");
    const reviewer = plan.files.find((f) => f.targetAbs.endsWith("leanrig-reviewer.toml"));
    expect(reviewer).toBeDefined();
    // No active `model = ...` assignment (commented-out rationale is fine).
    expect(reviewer!.content).not.toMatch(/^\s*model\s*=/m);
  });
});

// ---------------------------------------------------------------------------
// Install -> rollback roundtrip (real assets, tmp config dir)
// ---------------------------------------------------------------------------
describe("codex install -> rollback roundtrip", () => {
  let env: ReturnType<typeof setupTmpEnv>;
  beforeEach(() => {
    env = setupTmpEnv();
  });
  afterEach(() => {
    env.cleanup();
  });

  it("config.toml: appends a TOML block preserving user content + comments verbatim, then restores byte-exact", async () => {
    const configToml = path.join(env.codexHome, "config.toml");
    // A hand-written config.toml with a COMMENT — the thing a reparse/reserialize
    // would destroy. Block-append must leave every original byte intact.
    const original = `model = "gpt-5.5"  # my preferred model\napproval_policy = "on-request"\n\n[mcp_servers.foo]\ncommand = "x"\n`;
    fs.writeFileSync(configToml, original, "utf8");

    const plan = await getPlan("balanced");
    await runInstall(plan, { dryRun: false, force: false });

    const afterInstall = fs.readFileSync(configToml, "utf8");
    // Block is PREPENDED (top-level keys must precede any [table]); the user's
    // original content (INCLUDING the comment) is preserved verbatim as a suffix.
    expect(afterInstall.endsWith(original)).toBe(true);
    expect(afterInstall).toContain("# my preferred model");
    // leanrig's block uses TOML `#` markers and sits at the top.
    expect(afterInstall.indexOf("# leanrig:start")).toBeLessThan(afterInstall.indexOf("[mcp_servers.foo]"));
    expect(afterInstall).toContain("# leanrig:end");
    expect(afterInstall).toMatch(/tool_output_token_limit\s*=\s*12000/);
    // The merged document parses with the cap as a genuine TOP-LEVEL key
    // (the bug this whole change fixes: a trailing block would scope it under
    // [mcp_servers.foo]).
    const parsed = parseToml(afterInstall) as Record<string, unknown>;
    expect(parsed["model"]).toBe("gpt-5.5");
    expect(parsed["tool_output_token_limit"]).toBe(12000);
    expect((parsed["mcp_servers"] as any).foo.command).toBe("x");

    // Agent TOMLs created.
    expect(fs.existsSync(path.join(env.codexHome, "agents/leanrig-worker.toml"))).toBe(true);

    await runRollback("codex", { force: false });

    // config.toml back to byte-exact original; agents removed.
    expect(fs.readFileSync(configToml, "utf8")).toBe(original);
    expect(fs.existsSync(path.join(env.codexHome, "agents/leanrig-worker.toml"))).toBe(false);
  });

  it("AGENTS.md: appends block on install, removes only the block on rollback", async () => {
    const agentsMd = path.join(env.codexHome, "AGENTS.md");
    const original = `# My notes\n\nKeep tests green.\n`;
    fs.writeFileSync(agentsMd, original, "utf8");

    const plan = await getPlan("balanced");
    await runInstall(plan, { dryRun: false, force: false });

    const afterInstall = fs.readFileSync(agentsMd, "utf8");
    expect(afterInstall).toContain("# My notes");
    expect(afterInstall).toContain("<!-- leanrig:start -->");
    expect(afterInstall).toMatch(/leanrig-explorer/);

    await runRollback("codex", { force: false });

    // User content intact, leanrig block gone.
    const afterRollback = fs.readFileSync(agentsMd, "utf8");
    expect(afterRollback).toContain("# My notes");
    expect(afterRollback).not.toContain("<!-- leanrig:start -->");
  });

  it("re-install of the same profile is a no-op", async () => {
    const plan = await getPlan("safe");
    await runInstall(plan, { dryRun: false, force: false });
    const plan2 = await getPlan("safe");
    const result = await runInstall(plan2, { dryRun: false, force: false });
    expect(result.noOp).toBe(true);
  });
});
