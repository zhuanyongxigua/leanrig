# LeanRig

[![npm](https://img.shields.io/npm/v/leanrig)](https://www.npmjs.com/package/leanrig)
[![license](https://img.shields.io/npm/l/leanrig)](./LICENSE)

**Put your AI coding agent on a budget.**

LeanRig reduces AI coding-agent token usage and API costs. Its core idea is **subagent delegation**: your premium model stays the coordinator and does the judgment, while routine, low-stakes work — search, file discovery, implementation, log reading — is delegated to cheaper, better-fit models. It audits where your setup wastes tokens and installs safe, reversible cost-saving profiles (cheap-model routing, concise output, tool-output caps). Everything LeanRig writes is backed up and rollback-able.

Built for Claude Code and Codex, via a harness-agnostic adapter design.

## Install

```bash
npm install -g leanrig
```

Or run it without installing:

```bash
npx leanrig doctor
```

Requires Node >= 20.

## Quick start

```bash
leanrig doctor                                  # find where you're wasting tokens (read-only)
leanrig install claude-code --profile safe      # start conservative; --dry-run to preview
leanrig diff                                    # see exactly what changed
leanrig rollback                                # undo everything, byte-exact
```

## Why

You hit your usage limits halfway through the day. Your API bill says the model spent more on reading test logs than writing code. Sound familiar?

Modern coding agents are powerful. They are also extremely good at wasting context.

They read too much. They summarize too much. They keep stale instructions around. They send huge tool outputs back into the conversation. They use premium models for cheap work. They explain obvious things. They forget that every useless token compounds — into burned rate limits and a bigger bill.

LeanRig gives your agent a budget.

## What LeanRig does

LeanRig installs safe, reversible cost-saving profiles for agent harnesses.

The core mechanism is **subagent delegation** — the premium model coordinates and judges; cheaper, better-fit models do the labor. On Claude Code (shipped) it can configure:

- a delegation directive + skill (so the main model actually routes labor to subagents)
- cheap exploration agents (search, file discovery, log reading)
- bounded worker subagents (implementation, tests)
- independent reviewers (first-pass review)
- terse output styles
- tool-output limits
- context hygiene rules
- usage-aware statusline
- backup, diff, and rollback

The goal is not to make the model dumber.

The goal is to stop paying premium prices for low-value work.

## The basic idea

Use the expensive model for judgment. Use cheaper models for work.

```
Premium model:
  planning
  architecture
  conflict resolution
  final synthesis

Cheaper workers:
  grep
  file discovery
  implementation
  tests
  log reading
  first-pass review
  repetitive edits
```

LeanRig turns that into an installable profile.

## Profiles

### `safe`

Minimal changes. Good defaults. Concise output style, cheap subagents with explicit models, no aggressive truncation, easy rollback.

```bash
leanrig install claude-code --profile safe
```

### `balanced`

Recommended. The premium model stays the **main coordinator**; routine work is pushed to cheaper subagents:

```
Premium main session (whatever you launch with — no top-level model is set)
  ├─ haiku explorer   (search, file discovery, log reading)
  ├─ sonnet worker    (implementation, tests)
  └─ sonnet reviewer  (first-pass review)
```

Everything in `safe`, plus worker/reviewer subagents, a delegation skill, the `leanrig-doctor` recommend skill, tool-output caps, a usage statusline, and a clearly-marked, reversible delegation directive appended to your `CLAUDE.md` (so the main model actually routes labor to the cheap subagents).

```bash
leanrig install claude-code --profile balanced
```

## Commands

| Command | What it does |
|---|---|
| `leanrig doctor` | Find token waste in your current setup |
| `leanrig install claude-code --profile <p>` | Install a profile (`--dry-run` to preview) |
| `leanrig diff` | Show exactly what LeanRig changed |
| `leanrig rollback` | Restore your previous config |
| `leanrig profiles` | List available profiles |
| `leanrig tools` | List third-party cost-saving tools, what's installed, and how to install them |

## Recommends tools, never installs them

The token-saving ecosystem is fragmented: one tool compresses output, another compresses Bash logs, another tracks spend. LeanRig is the **map**, not the installer: it detects what you already have and shows each tool's **official** install command for you to run. It never installs third-party software on your behalf, never vendors it, never runs `curl | bash`.

```
$ leanrig tools

Tools for claude-code:
  ccusage-statusline  [not installed]  MIT
    Shows model, cost, context, and rate-limit info in the terminal statusline.
    install (run yourself — leanrig won't):
      Add to ~/.claude/settings.json:
        "statusLine": { "type": "command", "command": "npx -y ccusage statusline", "padding": 0 }
  caveman             [not installed]  MIT
    Makes Claude talk like a caveman — cuts ~75% of output tokens.
    install: claude plugin marketplace add JuliusBrussee/caveman && claude plugin install caveman@caveman
  squeez              [not installed]  Apache-2.0  ...
  lean-ctx            [not installed]  Apache-2.0  ...
```

Want a recommendation instead of a catalog? The **`leanrig-doctor` skill** (installed by the `balanced` profile) runs `leanrig doctor --json` + `leanrig tools --json`, then uses the model's judgment to tell you *which* tools fit your actual setup — and hands you the exact commands to run. LeanRig measures; the skill recommends; you install.

## Doctor

```
$ leanrig doctor

Claude Code detected

WARN  CLAUDE.md is 914 lines
      This is loaded into context by default.
      Move task-specific instructions into skills.

WARN  haiku-explorer has no model field
      It may inherit your main premium model.

WARN  CLAUDE_CODE_SUBAGENT_MODEL is set
      This overrides per-agent model routing.

OK    rollback backup available
OK    statusline installed
```

## Not just output compression

Output compression helps. But most waste is not "the assistant wrote too many words."

Real waste comes from repeated file reads, huge test logs, long command output, stale session history, bloated project memory, overpowered model routing, verbose subagent reports, MCP overhead, and premium models doing cheap tasks.

LeanRig attacks the whole stack.

## Safety

Every install is backed up. Every change is visible. Every profile is reversible.

```bash
leanrig install claude-code --profile balanced --dry-run   # preview first
leanrig diff                                               # see what changed
leanrig rollback                                           # undo everything
```

LeanRig never deletes your files, never overwrites modified files without `--force`, and keeps a manifest of everything it touches. The one file it writes *into* rather than alongside is `CLAUDE.md` (balanced+): it **appends** a block wrapped in `<!-- leanrig:start -->` / `<!-- leanrig:end -->`, never overwriting your content, and `rollback` removes only that block — your own edits stay.

## Harness-agnostic

LeanRig is designed around adapters. The same delegation idea — premium coordinator, cheap labor — maps onto any agent that has model routing, profiles, and a project-instruction file.

Shipped: `claude-code`, `codex`.

Planned: `gemini-cli`, `opencode`, `cursor-agent`, `aider`, `cline`.

```bash
leanrig install <harness> --profile <profile>
leanrig doctor <harness>
```

The `codex` adapter delegates to Codex CLI's native subagents (`~/.codex/agents/*.toml`), caps tool output via `config.toml` (`tool_output_token_limit`), and appends the delegation directive to `AGENTS.md` — all backed up and reversible. Codex has no command-backed statusline or output-style, so those Claude Code pieces have no codex equivalent; the reviewer subagent omits its model so it inherits your main session model (the review gate is never downgraded).

## Philosophy

- Premium tokens are for judgment. Cheap tokens are for labor.
- Context is a budget.
- Logs are radioactive. Summarize them before they touch the main session.
- Summaries should earn their keep.
- The best token is the one your agent never sends.
- Every agent needs a spending limit.

## FAQ

**Why is Claude Code using so many tokens?**
Usually: large CLAUDE.md loaded every session, uncapped Bash/MCP tool output flowing into context, subagents inheriting your premium model, and verbose responses. Run `leanrig doctor` — it points at each one.

**How do I reduce Claude Code costs without making it dumber?**
Route judgment to the expensive model and labor to cheap ones, cap tool output instead of compressing answers, and keep error messages verbatim. That's exactly what the `safe` and `balanced` profiles do — and they never touch code-writing instructions.

**How do I see what Claude Code is costing me?**
`leanrig tools` shows you `ccusage-statusline` and the exact command to put model, context usage, and session cost in your statusline — you run it yourself through ccusage's official channel.

**Will this break my existing setup?**
Every file is backed up before it's touched, `leanrig diff` shows every change, and one `leanrig rollback` restores your exact pre-install state.

## Status

Experimental (v0.2). Built for people who use AI coding agents heavily and are tired of watching them burn context on avoidable noise.

Use `safe` first. Use `balanced` when you trust it.

## License

MIT

## Dev

```bash
npm install          # install dependencies
npm run build        # tsc -> dist/
npm test             # vitest unit tests
npm run e2e          # end-to-end install/rollback roundtrip (uses throwaway tmp dirs)
```

Requirements: Node >= 20, npm >= 9.
