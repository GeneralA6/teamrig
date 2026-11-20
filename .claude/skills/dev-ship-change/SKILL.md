---
name: dev-ship-change
description: Land a finished teamrig change through small signed commits with Conventional subjects, npm run check, a push through the local gate and a rebase-merged pull request.
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
4. Commit no dist: main ignores `plugins/teamrig/dist`. `npm run build` writes it for the specs and checks that load
   it, and the release workflow builds it and publishes it to the `release` branch, which installs read.
5. Never raise the version in `plugins/teamrig/.claude-plugin/plugin.json` or `src/core/version.ts`: the release
   pull request does, from the subjects. While the version is 0.x, a `feat` or a breaking change (`!`) raises the
   minor, a `fix` or `perf` the patch, so pick the type for what the change does for users.
6. `npm run check`: every gate CI runs, on your tree.
7. `git push -u origin <branch>`: the pre-push hook runs the local gate's light checks (`tools/ci/local.ts`, its
   lists in `tools/ci/local-checks.ts`) on the committed tree, about 45 s; GitHub CI runs the rest on the pull request.
   Never `--no-verify`.
8. Open the pull request and fill in the template (`.github/pull_request_template.md`): its `## Reach` and
   `## Risks` always ([What a change is held to](../../../CONTRIBUTING.md#what-a-change-is-held-to)). A pull request
   `tools/ship` opens takes its text from `--note-file`: give that file a `## Reach` and a `## Risks` section. The
   merge opens no pull request without them (`pullSections` in
   `tools/ship/repos.json`), refusing before it waits on any check; one already open without it merges with a warning
   line. The repository is public: a security fix's branch name, commits, pull request text, comments and test names
   describe the hardening, never how to get past the old code, nor the private report or review by its id
   ([SECURITY.md](../../../SECURITY.md)). It is rebase-merged once every check passes on its head, and the branch is
   deleted.

## Traps

- Queue a `tools/ship` run without `--merge` as `--kind test`, and only a `--merge` run as `--kind ship`: the queue
  refuses a run whose kind does not fit, as only a merge moves main and holds the host's one ship slot.
- Main moved while you worked: the merge catches the branch up itself (`tools/ship/merge.ts`), dropping a
  `build: rebuild the plugin dist` commit a branch cut before main stopped tracking the dist still carries. When it
  refuses, rebase onto `origin/main` by hand.
- Each catch-up or hand rebase pushes a new `<stem>-N` branch with its own pull request. Once a merge or `ship.ts pr`
  holds the newest one, it closes each older open pull request of that stem whose work commits the new head carries,
  with a comment linking the new one (`tools/ship/superseded.ts`). A pull request with work the new head lacks stays
  open, and the merge's warning line names the commits.
- `tools/ship` builds the dist only to run the checks and commits none, as main tracks none; a run without
  `--merge`, for an approval, leaves the work alone on the head.
- The local gate proves a committed tree, so it refuses uncommitted changes: commit or stash them first.
- The pre-push hook's light checks leave the suite to CI: a failing spec shows on the pull request, not at the push.
  Run `npm run check` yourself first when the change reaches far.
- With `"mergeChecks": "changed"` on the repository in `tools/ship/repos.json`, the pre-push hook and the `--merge`
  run take the short checks (scrub, DCO, size rule, commit subjects, typecheck, the changed files' specs) and
  leave the whole suite to required CI; a spec only a changed file's neighbour misses fails there, not here. A change
  to the gate itself (hooks, workflows, `tools/ci`, `tools/ship`, the push guard, the package or a tsconfig) runs
  every check. Run `npm run check` yourself first when
  the change reaches far.
- A missing sign-off: `git commit --amend -s` for the last commit; the `commit-msg` hook from `npm run setup` catches
  it before the push.
- A branch you pushed yourself gets no pull request from your own gh login: only the ship token may open one. Run
  `node tools/ship/ship.ts pr <repo dir> --head <branch> --approved <sha> --note-file <pr.md>`: it opens the pull
  request of origin's head when that head is the approved sha and clears on that approval as a merge would, takes
  the merge's title and body, runs no gate, merges nothing and prints the URL (an open one is found, not opened again).

Last verified: 2026-11-20
