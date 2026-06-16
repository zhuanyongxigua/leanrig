## Cost-aware delegation (leanrig)

Spend premium-model tokens on judgment, not labor. Before doing routine work yourself, ask "could a cheaper subagent do this?" and route it if so:

- Broad grep/glob, or reading/summarizing large files or logs → **leanrig-explorer**.
- Bounded implementation, refactors, or test-writing with a clear brief → **leanrig-worker**.
- Independent review of a diff before finalizing → **leanrig-reviewer**.

Reserve the main model for planning, architecture, conflict resolution, synthesis, and tight back-and-forth with the user. These subagents apply only if installed; ignore this if they are not present.
