# Contributing

## Development

```sh
npm ci                # also points git at .githooks (scrub + DCO sign-off checks, the local gate before each push, no push to main)
npm run setup         # the same hook setup, for a clone installed with --ignore-scripts (npm run check fails until it runs)
npm run check         # that git runs the repo hooks, then CI's gates on your tree: typecheck, tests with the coverage gate, build, dist checks, pictures, config reference, doc links, scrub
npm run docs:images   # redraws the pictures in docs/images
npm run docs:config   # redraws docs/configuration.md from the config schema
npm run docs:check    # checks relative links, anchors and Mermaid diagram types in the top-level and docs/ Markdown
node tools/ci/local.ts # the local gate: every CI check on the committed tree, once per tree (the pre-push hook runs it)
```

The pictures in the docs are drawn in code (`tools/docs/`), the commands screen by running the real CLI for a made-up
team, and [the configuration reference](docs/configuration.md) from each key's `description` in
`plugins/teamrig/config.schema.json`, so none can drift from the code or from what the CLI prints: the checks fail until
they are redrawn. To change a key's text, edit its `description` and run `npm run docs:config`. The sections below give
the test and sign-off rules.

## How we work
Every contributor, and every Claude Code session opened in this repo, works the same way. [CLAUDE.md](CLAUDE.md) holds
the rules that apply on every turn, and the project skills in `.claude/skills/` the steps of each repeated job:

| Skill | Use it for |
| --- | --- |
| [`dev-add-command`](.claude/skills/dev-add-command/SKILL.md) | a new CLI command, or a flag on one |
| [`dev-add-config-key`](.claude/skills/dev-add-config-key/SKILL.md) | a new key in the team config |
| [`dev-update-docs`](.claude/skills/dev-update-docs/SKILL.md) | the docs a change must update, and the checks that hold them to the code |
| [`dev-ship-change`](.claude/skills/dev-ship-change/SKILL.md) | from the last commit to the merge: dist, version raise, checks, push, pull request |

- **One branch per change**, cut from the newest `origin/main` (see [Branches and releases](#branches-and-releases)).
- **One logical change per commit**: a fix with its tests, a refactor apart from what it enables, a mechanical change
  alone, each committed once its step passes, so a reviewer reads one idea at a time and a bad step reverts alone. A
  commit past 400 changed non-test lines or 15 non-test files carries a `Large-commit: <reason>` line saying why it
  cannot be split; these are the limits teamrig itself applies to a team's pushes.
- **Docs in the same pull request** as the change they describe, so `main` never documents what it does not do.
- **Typed code with no casts**: no `any`, no `as unknown as`; narrow `unknown` with a type guard.
- **The why in plain words, where the reader finds it**: a comment says why the code is as it is, with a task or issue
  id only as a trace and never a path outside the repo; a pull request that settles a design question fills in the
  template's `## Alternatives` (the options weighed and why this one won). There is no decisions folder: the reasons
  live in the code, its issues and its pull requests, and [how it works](docs/how-it-works.md) shows how the parts fit.
- When a step in a skill turns out wrong, fix the skill in the same pull request.

## Sign-off (DCO)
Every commit must carry a `Signed-off-by:` line that matches the commit author, certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). Add it with:

```sh
git commit -s
```

The `commit-msg` hook (set by `npm ci` or `npm run setup`) and the local gate both reject a commit without it.

## Tests
Every change ships tests, so the next change cannot break it unnoticed:
- A new behaviour gets a test that would fail without it. A bug fix gets a regression test that
  fails on the old code: run it before the fix and watch it fail.
- Tests live beside the code as `<name>.test.ts` under `src/` or `tools/` (`node:test`), and run
  on Linux, Windows and macOS. Build paths with `path.join`, never with literal separators.
- Use the fakes in `src/testing/` and `tools/lib/fake-git.ts` instead of real time, disks or git
  where a unit test fits; spawn the real entry point (`process.execPath`) to test a CLI.
- No skipped or todo tests: a test that does not run catches nothing.

`npm run check` runs every gate CI runs on the tree; the local gate also checks each pushed commit's sign-off and scrubs it,
which the git hooks `npm ci` sets do before each commit. Its coverage gate (`npm run coverage`) fails when:
- any test fails, or is skipped or todo;
- a source file under `src/` or `tools/` is loaded by no test, new and uncommitted files included;
- a file, or the total, falls below the floors in `tools/ci/coverage.json`;
- a test file is named or placed so `npm test` would never run it;
- the run prints nothing for `suiteIdleSeconds` in `tools/ci/coverage.json` (300 when unset): it is stopped with every
  process it started, so a test that never ends cannot hold the host. On a busy host (under 25% of its CPU idle when
  the limit passes) the run gets the limit again, up to three limits in all, as other steps' test runs can slow it
  that long.

Never lower a floor to pass a change. A file that truly cannot reach one (for example an error
path that needs a real disk failure) gets an entry under `exceptions` in `tools/ci/coverage.json`
with a reason the reviewer accepts; the gate reports the entry once the file no longer needs it.

## Stored files
A file teamrig keeps carries a format number (such as `USAGE_FORMAT` or `EVENT_VERSION`). A teamrig that
rewrites a file of its own format keeps only the fields it knows, and may read one holding a value it cannot
read as damaged. So a field added to a stored file, at any depth, or a value an older teamrig cannot read, is a
new format: raise the number in the same change and keep reading the older formats, so an older teamrig still
running in some tab refuses the file (`NewerDataError`) instead of dropping the field. A store that overwrites
a file refuses a newer format before it writes (`writableObject` for a one-object file, `assertWritable` for a
log, both in `src/core/jsonl.ts`); a store without that check needs one first. A test pins the fields of the
current format with `fieldPaths` (`src/testing/field-paths.ts`), as `src/budget/store.test.ts` does for the
usage files.

The register's event log (`EVENT_VERSION`) is an exception: a field an older reader can ignore takes no new number.
Compaction copies each kept line as written, so no rewrite drops the field, and the header of
`src/register/events.ts` lists each field added this way. A line an older teamrig must not act on still raises the
number, as the `moved` record did.

The task pane (teamrig-pane) reads through a copy of the modules `src/read/index.ts` reaches, kept in its
`hooks/core`. A raise of a format among them needs that copy re-synced (the pane's `dev-sync-core` skill): until
then the pane counts each line of the new format as one from a newer teamrig and skips it. The pane's gate
(`scripts/sync-core.ts --formats`) fails while its copy trails `main`, so the pane cannot ship behind it.

## The local gate
CI (`.github/workflows/ci.yml`) runs on each pull request and each push to `main`, but every job skips while the
repository is private, where GitHub Actions minutes bill, so it checks only once the repository is public. Its
`every check passed` job passes only when every other job did: the one check `main` requires (see
[Pull requests](#pull-requests)). Whether CI runs or not, the `pre-push` hook that `npm ci` sets runs every check CI
runs (`tools/ci/local.ts`; the list is `tools/ci/local-checks.ts`) on the commit being pushed:
- It refuses a push to `main`, before any check: every change lands through a pull request. On GitHub,
  `.github/workflows/main-push-alert.yml` opens an issue when main changes outside a pull request anyway (from a
  clone without the hooks), so the owner hears of it; a commit made in GitHub's web editor raises none.
- It proves a committed tree: it refuses uncommitted changes, and a pushed commit that is not checked out.
- It stops at the first failing check and prints its output.
- A pass is recorded in the clone's git folder (`local-ci/<tree>.json`, shared by its worktrees), so a tree is
  checked once; a new commit is checked again. Only the runner writes a record: the pass-record guard refuses a
  session's own write of one (`hook pass-record-guard`).
- It cannot be skipped: never push with `--no-verify`.

It runs on one machine and one Node, so a failure that only another OS or Node version shows goes unseen until
the repository is public.

## Branches and releases
- Every change is its own branch off `main` and lands through a pull request once every check
  passes on its head (the local gate until the repository is public); it is rebase-merged and the branch is deleted.
- Each commit is one logical change. The `size rule` (`tools/ci/size-rule-cli.ts`, run by the local gate, CI
  and `npm run check`) fails a commit over 400 changed non-test lines or 15 non-test files whose message has
  no `Large-commit: <reason>` line: the push guard's rule at its defaults, so a pull request meets it too.
- Nothing is pushed to `main` directly, and release tags are set only by the maintainer.
- Installs take the version in `plugins/teamrig/.claude-plugin/plugin.json`, not the newest commit:
  `claude plugin update` moves an install only when that version rises. So a change to anything under
  `plugins/teamrig/` (the dist included, so every change to `src/`) raises it, as MAJOR.MINOR.PATCH:
  while it is 0.x, the minor for a new feature or a change that breaks how people use it, the patch
  for a fix. The `plugin version gate` (`tools/ci/plugin-version-cli.ts`, run by the local gate and `npm run check`)
  fails a pull request that does not, and one that gives the marketplace entry a version of its own,
  which Claude Code ignores. How users update: [Updating the plugin](docs/how-it-works.md#updating-the-plugin).

## Pull requests
- **From a fork**: fork the repository, branch off its `main`, and open the pull request against this repository's
  `main`. CI runs it with no secrets and a read-only token, and an outside contributor's run waits for the
  maintainer to approve it.
- **Your commit e-mail**: the `Signed-off-by:` line carries your commit e-mail, and the scrub refuses an e-mail
  address in a commit message unless it is one of GitHub's no-reply addresses. Before your first commit, set the
  no-reply address GitHub shows under Settings, Emails: `git config user.email <id>+<user>@users.noreply.github.com`.
- **A version clash**: when `main` moves on with a version raise of its own, rebase onto it. `plugin.json`,
  `src/core/version.ts` and the dist clash: take `main`'s side, raise the version above it again and rebuild the dist
  (`npm run build`), each in its own commit as before.
- **Review**: a code owner (`.github/CODEOWNERS`: the maintainer) reviews the code and approves the last push, and a
  new push dismisses an approval given before it. A change to the git hooks, CI, the scrub or teamrig's guards
  (`.githooks/`, `.github/`, `tools/scrub/`, `tools/ci/`, `src/hooks/`, `src/push-guard/`, `src/secret-guard/`,
  `src/package-guard/`, `src/permissions/`) also gets a security review.
- **Rules on `main`**: `.github/rulesets/` holds the repository's two rulesets for `main`, imported under Settings,
  Rules, Rulesets. `main` lets no one push, force-push or delete it and takes a change only through a pull request,
  rebase-merged once its `every check passed` check passed on the newest `main`; `main review` asks a code owner
  to approve the last push, which only the maintainer's own pull requests skip. `tools/ci/rulesets.test.ts` holds
  them to `ci.yml` and `.github/CODEOWNERS`.

## Scrub checks
Two checks keep private data out of the history:
1. **Generic** (in this repo, run by the hooks, the local gate and CI): absolute home paths, e-mail addresses,
   IP addresses, internal host names and the secret shapes teamrig's secret guard refuses: common tokens,
   credentials in a URL or an Authorization or API key header, and literals given to a secret-like name.
2. **Private denylist** (optional, never committed): a file of your own terms, wired in with
   `git config --local teamrig.scrubDenylist <path>`. Once configured, the hooks fail closed if
   the file is missing. The scrub runs only inside the repo's work tree, where that setting is read, and refuses
   anywhere else rather than pass on the generic check alone.

Write test data that looks like a secret by building it at runtime (for example
`'ghp' + '_' + 'x'.repeat(36)`), so the source never holds the literal.
