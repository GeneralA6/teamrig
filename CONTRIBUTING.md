# Contributing

## Development

```sh
npm ci
npm run setup         # points git at .githooks (scrub + DCO sign-off checks)
npm run check         # CI's gates on your tree: typecheck, tests with the coverage gate, build, dist checks, pictures, doc links, scrub
npm run docs:images   # redraws the pictures in docs/images
npm run docs:check    # checks relative links, anchors and Mermaid diagram types in the top-level and docs/ Markdown
```

The pictures in the docs are drawn in code (`tools/docs/`), and the commands screen by running the real CLI for a
made-up team, so none can drift from the code or from what the CLI prints: CI fails until they are redrawn. The
sections below give the test and sign-off rules.

## Sign-off (DCO)
Every commit must carry a `Signed-off-by:` line that matches the commit author, certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). Add it with:

```sh
git commit -s
```

The `commit-msg` hook (installed by `npm run setup`) and CI both reject a commit without it.

## Tests
Every change ships tests, so the next change cannot break it unnoticed:
- A new behaviour gets a test that would fail without it. A bug fix gets a regression test that
  fails on the old code: run it before the fix and watch it fail.
- Tests live beside the code as `<name>.test.ts` under `src/` or `tools/` (`node:test`), and run
  on Linux, Windows and macOS. Build paths with `path.join`, never with literal separators.
- Use the fakes in `src/testing/` and `tools/lib/fake-git.ts` instead of real time, disks or git
  where a unit test fits; spawn the real entry point (`process.execPath`) to test a CLI.
- No skipped or todo tests: a test that does not run catches nothing.

`npm run check` runs every gate CI runs on the tree; CI also checks each pushed commit's sign-off and scrubs it, which the
git hooks from `npm run setup` do before each commit. Its coverage gate (`npm run coverage`) fails when:
- any test fails, or is skipped or todo;
- a source file under `src/` or `tools/` is loaded by no test, new and uncommitted files included;
- a file, or the total, falls below the floors in `tools/ci/coverage.json`;
- a test file is named or placed so `npm test` would never run it.

Never lower a floor to pass a change. A file that truly cannot reach one (for example an error
path that needs a real disk failure) gets an entry under `exceptions` in `tools/ci/coverage.json`
with a reason the reviewer accepts; the gate reports the entry once the file no longer needs it.

## Branches and releases
- Every change is its own branch off `main` and lands through a pull request once every CI check
  passes on its head; it is rebase-merged and the branch is deleted.
- Nothing is pushed to `main` directly, and release tags are set only by the maintainer.
- Installs take the version in `plugins/teamrig/.claude-plugin/plugin.json`, not the newest commit:
  `claude plugin update` moves an install only when that version rises. So a change to anything under
  `plugins/teamrig/` (the dist included, so every change to `src/`) raises it, as MAJOR.MINOR.PATCH:
  while it is 0.x, the minor for a new feature or a change that breaks how people use it, the patch
  for a fix. CI's `plugin version gate` (`tools/ci/plugin-version-cli.ts`, also run by `npm run check`)
  fails a pull request that does not, and one that gives the marketplace entry a version of its own,
  which Claude Code ignores. How users update: [Updating the plugin](docs/how-it-works.md#updating-the-plugin).

## Scrub checks
Two checks keep private data out of the history:
1. **Generic** (in this repo, run by the hooks and CI): absolute home paths, e-mail addresses,
   IP addresses, internal host names and common secret formats.
2. **Private denylist** (optional, never committed): a file of your own terms, wired in with
   `git config --local teamrig.scrubDenylist <path>`. Once configured, the hooks fail closed if
   the file is missing.

Write test data that looks like a secret by building it at runtime (for example
`'ghp' + '_' + 'x'.repeat(36)`), so the source never holds the literal.
