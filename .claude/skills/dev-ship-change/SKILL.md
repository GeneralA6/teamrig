---
name: dev-ship-change
description: Land a finished teamrig change through small signed commits, a dist rebuild, the version raise, npm run check, a push through the local gate and a rebase-merged pull request.
---

# Ship a change

1. Before you build, settle the change's reach (CONTRIBUTING.md, Where a change lives): all users by default, so a
   team's value is a config key with a default and a how-to is a plugin skill; teamrig development only for this
   repo's own tooling. Write it in the task's description.
2. Work on a branch cut from the newest main: `git fetch origin && git switch -c <branch> origin/main`, named
   `<type>/<id>-<slug>` such as `feat/t12-parse-input` (CONTRIBUTING.md, Branches and releases). A worktree works
   too: `teamrig worktree add --task <id>` names the branch and runs the setup, or `git worktree add -b <branch>
   <path> origin/main`, then `npm ci` in it.
3. Commit each logical change once its step passes, with `git commit -s`. Subjects follow the log, `area: what`
   (`cli:`, `config:`, `hooks:`, `docs:`, `test:`, `ci:`, `tools:`). A commit past 400 changed non-test lines or 15
   non-test files carries a `Large-commit: <reason>` line.
4. After a `src/` change, run `npm run build` and commit `plugins/teamrig/dist` on its own
   (`build: rebuild the plugin dist`): the `dist-fresh` check refuses a dist that does not match the source.
5. A change under `plugins/teamrig/` raises the version: `plugins/teamrig/.claude-plugin/plugin.json` and
   `src/core/version.ts` (a test holds them equal), in their own commit, `plugin: version X.Y.Z, <why>`. While the
   version is 0.x, the minor for a feature or a change that breaks how people use it, else the patch. Installs move
   only when this version rises. Check it with `node tools/ci/plugin-version-cli.ts`.
6. `npm run check`: every gate CI runs, on your tree.
7. `git push -u origin <branch>`: the pre-push hook runs the local gate (`tools/ci/local.ts`, its checks listed in
   `tools/ci/local-checks.ts`) on the committed tree. Never `--no-verify`.
8. Open the pull request and fill in the template (`.github/pull_request_template.md`): its `## Reach` always, its
   `## Alternatives` when the change settles a design question. A pull request `tools/ship` opens takes its text from
   `--note-file`: start that file with a `Reach:` line. The repository is public: a security fix's commits, pull
   request text, comments and test names describe the hardening, never how to get past the old code, nor the private
   report or review by its id ([SECURITY.md](../../../SECURITY.md)). It is rebase-merged once
   every check passes on its head, and the branch is deleted.

## Traps

- Main moved while you worked: the merge catches the branch up itself when the version raise and the dist each sit
  in a commit of their own (CONTRIBUTING.md, A version clash). When it refuses, rebase onto `origin/main` by hand and
  set the version raise again from main's version.
- The local gate proves a committed tree, so it refuses uncommitted changes: commit or stash them first.
- A missing sign-off: `git commit --amend -s` for the last commit; the `commit-msg` hook from `npm run setup` catches
  it before the push.

Last verified: 2026-11-15
