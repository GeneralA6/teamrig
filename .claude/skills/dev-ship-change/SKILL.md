---
name: dev-ship-change
description: Land a finished teamrig change through small signed commits with Conventional subjects, a dist rebuild, npm run check, a push through the local gate and a rebase-merged pull request.
---

# Ship a change

1. Before you build, settle the change's reach (CONTRIBUTING.md, Where a change lives): all users by default, so a
   team's value is a config key with a default and a how-to is a plugin skill; teamrig development only for this
   repo's own tooling. Write it in the task's description.
2. Work on a branch cut from the newest main: `git fetch origin && git switch -c <branch> origin/main`, named
   `<type>/<id>-<slug>` such as `feat/t12-parse-input` (CONTRIBUTING.md, Branches and releases). A worktree works
   too: `teamrig worktree add --task <id>` names the branch and runs the setup, or `git worktree add -b <branch>
   <path> origin/main`, then `npm ci` in it.
3. Commit each logical change once its step passes, with `git commit -s`. Subjects are Conventional Commits,
   `<type>(<area>): <what>` with the area optional (`feat(cli): ...`, `fix(ship): ...`, `docs: ...`); the
   `commit subjects` check fails any other (CONTRIBUTING.md, Branches and releases). A commit past 400 changed non-test lines or 15
   non-test files carries a `Large-commit: <reason>` line.
4. After a `src/` change, run `npm run build` and commit `plugins/teamrig/dist` on its own
   (`build: rebuild the plugin dist`): the `dist-fresh` check refuses a dist that does not match the source.
5. Never raise the version in `plugins/teamrig/.claude-plugin/plugin.json` or `src/core/version.ts`: the release
   pull request does, from the subjects. While the version is 0.x, a `feat` or a breaking change (`!`) raises the
   minor, a `fix` or `perf` the patch, so pick the type for what the change does for users.
6. `npm run check`: every gate CI runs, on your tree.
7. `git push -u origin <branch>`: the pre-push hook runs the local gate's light checks (`tools/ci/local.ts`, its
   lists in `tools/ci/local-checks.ts`) on the committed tree, about 45 s; GitHub CI runs the rest on the pull request.
   Never `--no-verify`.
8. Open the pull request and fill in the template (`.github/pull_request_template.md`): its `## Reach` always, its
   `## Alternatives` when the change settles a design question. A pull request `tools/ship` opens takes its text from
   `--note-file`: give that file a `## Reach` section. The merge opens no pull request without it (`pullSections` in
   `tools/ship/repos.json`), refusing before it waits on any check; one already open without it merges with a warning
   line. The repository is public: a security fix's branch name, commits, pull request text, comments and test names
   describe the hardening, never how to get past the old code, nor the private report or review by its id
   ([SECURITY.md](../../../SECURITY.md)). It is rebase-merged once every check passes on its head, and the branch is
   deleted.

## Traps

- Queue a `tools/ship` run without `--merge` as `--kind test`, and only a `--merge` run as `--kind ship`: the queue
  refuses a run whose kind does not fit, as only a merge moves main and holds the host's one ship slot.
- Main moved while you worked: the merge catches the branch up itself when the dist sits in a commit of its own
  (`tools/ship/merge.ts`). When it refuses, rebase onto `origin/main` by hand and rebuild the dist.
- `tools/ship` run without `--merge`, for an approval, leaves the work alone on the head: it builds the dist only to
  run the checks, then takes it back. The `--merge` run commits the dist once, on the base it lands on, and the
  approval still holds, as it reads the change apart from the dist.
- The local gate proves a committed tree, so it refuses uncommitted changes: commit or stash them first.
- The pre-push hook's light checks leave the suite to CI: a failing spec shows on the pull request, not at the push.
  Run `npm run check` yourself first when the change reaches far.
- With `"mergeChecks": "changed"` on the repository in `tools/ship/repos.json`, the pre-push hook and the `--merge`
  run take the short checks (scrub, DCO, typecheck, the changed files' specs) and leave the whole suite to required
  CI; a spec only a changed file's neighbour misses fails there, not here. Run `npm run check` yourself first when
  the change reaches far.
- A missing sign-off: `git commit --amend -s` for the last commit; the `commit-msg` hook from `npm run setup` catches
  it before the push.

Last verified: 2026-11-17
