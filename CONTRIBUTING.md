# Contributing

## Development

```sh
npm ci
npm run setup         # points git at .githooks (scrub + DCO sign-off checks, and the local gate before each push)
npm run check         # CI's gates on your tree: typecheck, tests with the coverage gate, build, dist checks, pictures, config reference, doc links, scrub
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
- When a step in a skill turns out wrong, fix the skill in the same pull request.

## Sign-off (DCO)
Every commit must carry a `Signed-off-by:` line that matches the commit author, certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). Add it with:

```sh
git commit -s
```

The `commit-msg` hook (installed by `npm run setup`) and the local gate both reject a commit without it.

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
which the git hooks from `npm run setup` do before each commit. Its coverage gate (`npm run coverage`) fails when:
- any test fails, or is skipped or todo;
- a source file under `src/` or `tools/` is loaded by no test, new and uncommitted files included;
- a file, or the total, falls below the floors in `tools/ci/coverage.json`;
- a test file is named or placed so `npm test` would never run it.

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

## The local gate
CI (`.github/workflows/ci.yml`) is paused until it is turned back on, and runs only when started by hand.
Until then the `pre-push` hook from `npm run setup` runs every check CI runs (`tools/ci/local.ts`; the list is
`tools/ci/local-checks.ts`) on the commit being pushed:
- It proves a committed tree: it refuses uncommitted changes, and a pushed commit that is not checked out.
- It stops at the first failing check and prints its output.
- A pass is recorded in the clone's git folder (`local-ci/<tree>.json`, shared by its worktrees), so a tree is
  checked once; a new commit is checked again.
- It cannot be skipped: never push with `--no-verify`.

It runs on one machine and one Node, so a failure that only another OS or Node version shows goes unseen until
CI runs again.

## Branches and releases
- Every change is its own branch off `main` and lands through a pull request once every check
  passes on its head (the local gate while CI is paused); it is rebase-merged and the branch is deleted.
- Nothing is pushed to `main` directly, and release tags are set only by the maintainer.
- Installs take the version in `plugins/teamrig/.claude-plugin/plugin.json`, not the newest commit:
  `claude plugin update` moves an install only when that version rises. So a change to anything under
  `plugins/teamrig/` (the dist included, so every change to `src/`) raises it, as MAJOR.MINOR.PATCH:
  while it is 0.x, the minor for a new feature or a change that breaks how people use it, the patch
  for a fix. The `plugin version gate` (`tools/ci/plugin-version-cli.ts`, run by the local gate and `npm run check`)
  fails a pull request that does not, and one that gives the marketplace entry a version of its own,
  which Claude Code ignores. How users update: [Updating the plugin](docs/how-it-works.md#updating-the-plugin).

## Scrub checks
Two checks keep private data out of the history:
1. **Generic** (in this repo, run by the hooks, the local gate and CI): absolute home paths, e-mail addresses,
   IP addresses, internal host names and common secret formats.
2. **Private denylist** (optional, never committed): a file of your own terms, wired in with
   `git config --local teamrig.scrubDenylist <path>`. Once configured, the hooks fail closed if
   the file is missing.

Write test data that looks like a secret by building it at runtime (for example
`'ghp' + '_' + 'x'.repeat(36)`), so the source never holds the literal.
