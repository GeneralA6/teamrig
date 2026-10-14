# teamrig

Coordinate a team of parallel Claude Code sessions: a task register, inboxes, a deploy coordinator and an always-loaded rule pack, shipped as a Claude Code plugin.

**Status: pre-release.** Nothing here is stable yet; there is no release to install.

## Requirements
- Claude Code with plugin support.
- Node.js 22.18 or newer on `PATH` (the plugin's commands and hooks run on Node).

## Development
```sh
npm ci
npm run setup   # points git at .githooks (scrub + DCO sign-off checks)
npm run check   # typecheck, tests, scrub of the whole tree
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the sign-off rule.

## Licence
[Apache License 2.0](LICENSE).
