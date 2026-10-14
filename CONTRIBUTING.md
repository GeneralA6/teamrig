# Contributing

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

`npm run check` runs every gate CI runs. Its coverage gate (`npm run coverage`) fails when:
- any test fails, or is skipped or todo;
- a source file under `src/` or `tools/` is loaded by no test, new and uncommitted files included;
- a file, or the total, falls below the floors in `tools/ci/coverage.json`;
- a test file is named or placed so `npm test` would never run it.

Never lower a floor to pass a change. A file that truly cannot reach one (for example an error
path that needs a real disk failure) gets an entry under `exceptions` in `tools/ci/coverage.json`
with a reason the reviewer accepts; the gate reports the entry once the file no longer needs it.

## Branches and releases
- Work lands on `dev` through pull requests or direct pushes by the maintainer's agents.
- `main` and release tags are moved only by the maintainer, after review. Installs track `main`.

## Scrub checks
Two checks keep private data out of the history:
1. **Generic** (in this repo, run by the hooks and CI): absolute home paths, e-mail addresses,
   IP addresses, internal host names and common secret formats.
2. **Private denylist** (optional, never committed): a file of your own terms, wired in with
   `git config --local teamrig.scrubDenylist <path>`. Once configured, the hooks fail closed if
   the file is missing.

Write test data that looks like a secret by building it at runtime (for example
`'ghp' + '_' + 'x'.repeat(36)`), so the source never holds the literal.
