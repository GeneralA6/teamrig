## What and why
<!-- One or two lines: the behaviour this changes and the reason. -->

## Tests
<!-- Which tests prove it. For a bug fix: the regression test, and that it fails on the old code. -->

## Checklist
- [ ] Every behaviour change has a test; a bug fix has a regression test that fails before the fix.
- [ ] `npm run check` passes locally (typecheck, tests with the coverage gate, build, fresh dist, dist smoke, pictures, doc links, scrub).
- [ ] No skipped or todo tests, and no floor lowered in `tools/ci/coverage.json`.
- [ ] Every commit is signed off (`git commit -s`).
- [ ] The plugin dist is rebuilt and committed (`npm run build`) if the source under `src/` changed.
