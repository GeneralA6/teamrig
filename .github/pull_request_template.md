<!-- Read docs/issues-and-pull-requests.md and CONTRIBUTING.md first. -->

## What
<!-- The behaviour this changes, in one or two plain lines. -->

## Why
<!-- The reason: the bug it fixes or what it makes possible. -->

## Reach
<!-- All users (the plugin: a command, a config key, a hook, a plugin skill), teamrig development (dev skills, tools/, CI) or one team, and why: see CONTRIBUTING.md, Where a change lives. -->

## Changes
<!-- The parts it touches, one line each. -->

## Risks
<!-- What could go wrong (a break for a caller, a security or data risk, a cost, a migration) and how each is softened; or "none foreseen" and why. See CONTRIBUTING.md, What a change is held to. -->

## Old-code proof
<!-- A bug fix: the regression test that fails on the old code, and how you ran it there. Otherwise "none, not a fix". -->

## Tests
<!-- Which tests prove it. -->

## Issue
<!-- Fixes #<n> when it finishes the issue, Refs #<n> when it is a step toward it. -->

## Checklist
- [ ] Every behaviour change has a test; a bug fix has a regression test that fails before the fix.
- [ ] The pre-push hook passed on the pushed head (the local gate, every CI check; never `--no-verify`).
- [ ] `npm run check` passes locally (typecheck, build, tests with the coverage gate, dist smoke, fresh install, pictures, config reference, parity page, layer boundaries, doc links, scrub).
- [ ] Docs updated in the same PR: `docs/commands.md` and the guide for a command, the schema `description` for a config key (then `npm run docs:config`), `docs/features.md` for a feature.
- [ ] No skipped or todo tests, and no floor lowered in `tools/ci/coverage.json`.
- [ ] Every commit is signed off (`git commit -s`).
- [ ] No plugin dist and no version raise committed: the release workflow builds and publishes both.
