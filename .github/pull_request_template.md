## What and why
<!-- One or two lines: the behaviour this changes and the reason. -->

## Alternatives
<!-- Only for a change that settles a design question: the options weighed and why this one won. Delete otherwise. -->

## Tests
<!-- Which tests prove it. For a bug fix: the regression test, and that it fails on the old code. -->

## Checklist
- [ ] Every behaviour change has a test; a bug fix has a regression test that fails before the fix.
- [ ] The pre-push hook passed on the pushed head (the local gate, every CI check; never `--no-verify`).
- [ ] `npm run check` passes locally (typecheck, tests with the coverage gate, build, fresh dist, dist smoke, pictures, config reference, doc links, scrub).
- [ ] Docs updated in the same PR: `docs/commands.md` and the guide for a command, the schema `description` for a config key (then `npm run docs:config`), `docs/features.md` for a feature.
- [ ] No skipped or todo tests, and no floor lowered in `tools/ci/coverage.json`.
- [ ] Every commit is signed off (`git commit -s`).
- [ ] The plugin dist is rebuilt and committed (`npm run build`) if the source under `src/` changed.
