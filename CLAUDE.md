# Working on teamrig

The rules below apply on every turn. [CONTRIBUTING.md](CONTRIBUTING.md) is the methodology they come from, and the
project skills in `.claude/skills/` hold the steps of each repeated job.

- **A branch per change**, cut from the newest `origin/main`; it lands through a pull request, never a push to `main`.
- **Tests with the change**: a new behaviour gets a test that fails without it, a bug fix a regression test that fails
  on the old code. `node:test` files sit beside the code as `<name>.test.ts`, using the fakes in `src/testing/`. No
  skipped or todo tests, and never lower a floor in `tools/ci/coverage.json`.
- **Typed code, no casts**: no `any`, no `as unknown as`, no `as Foo`; narrow `unknown` with a type guard
  (`as const` is fine).
- **Small commits**: one logical change per commit (a fix with its tests, a refactor apart from what it enables, a
  mechanical change alone), committed as each step passes. A commit past 400 changed non-test lines or 15 non-test
  files carries a `Large-commit: <reason>` line.
- **Signed off**: every commit is `git commit -s` (DCO).
- **Dist and version**: after a `src/` change, `npm run build` and commit `plugins/teamrig/dist` on its own. A change
  under `plugins/teamrig/` (every `src/` change, through the dist) raises the version in
  `plugins/teamrig/.claude-plugin/plugin.json` and `src/core/version.ts`, in its own commit.
- **Docs in the same pull request**: `dev-update-docs` says which page each kind of change touches.
- **No private data**: no home paths, e-mail addresses, host names or secrets in code, tests, docs or commit
  messages; the scrub refuses them.
- **Gates**: `npm run check` before you push; the pre-push hook runs the local gate. Never `--no-verify`.

## Project skills

| Skill | Use it for |
| --- | --- |
| `dev-add-command` | a new CLI command, or a flag on one |
| `dev-add-config-key` | a new key in the team config |
| `dev-update-docs` | the docs a change must update, and the checks that hold them to the code |
| `dev-ship-change` | from the last commit to the merge: dist, version raise, checks, push, pull request |
