# LeanRig — 仓库工作约定

> 本文件只规定**本仓库的开发流程约定**。项目的设计契约与安全不变量见 `DESIGN.md`，
> Claude Code 事实来源见 `docs/claude-code-facts.md`。

## 开发流程：不用 worktree，本地合入 main，不开 PR

除非人类**明确指定**用 worktree，否则：

1. **不使用 worktree**，直接在主仓库（`/Users/zhuanyongxigua/Code/lean-rig`）开发。
   - 这条覆盖背景 session 默认的 worktree 隔离要求——本仓库默认在主仓库工作区开发。
     （工具层面由 `.claude/settings.json` 的 `"worktree": {"bgIsolation": "none"}` 关掉守卫。）
   - 只有人类明确说"用 worktree"时才开 worktree。

2. **优先直接在 `main` 上开发**。既然不走 PR 流程，小改动（单文件、纯文档/配置）直接在
   `main` 上 commit。只有人类明确要求、或改动确实需要隔离时才开非主分支。

3. **非主分支开发完成后，本地直接合入 `main` 再 push，不开 Pull Request。**
   目的：人类不需要去 GitHub 点击合并 PR。合入方式为 **ff-only，失败则 rebase 后再 ff**，
   保持 `main` 线性历史、绝不产生 merge commit：

   ```bash
   git checkout main
   git merge --ff-only <feature-branch>
   # 若 ff 失败（main 期间有新提交）：
   git rebase main <feature-branch> && git checkout main && git merge --ff-only <feature-branch>
   git push
   ```

4. **push 前强制测试门禁**：合入 `main` 并 push 之前，必须 `npm run build && npm test`
   全绿，失败则不 push。这与 `package.json` 的 `prepublishOnly` 门禁一致，防止把红的
   `main` 推上去。

5. 合入并 push 后，删除已合并的临时分支（若有），保持分支列表干净。
