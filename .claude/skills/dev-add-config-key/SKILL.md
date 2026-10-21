---
name: dev-add-config-key
description: Add a key to the teamrig team config, from its type and default to its schema description and the generated configuration page, with the specs that hold them equal.
---

# Add a config key

1. `src/config/types.ts`: the field on its block's interface, `readonly`.
2. `src/config/defaults.ts`: its default, on the block's `DEFAULT_*` constant.
3. `src/config/limits.ts`: its bounds in `CONFIG_LIMITS`, for a number or a list with a size cap.
4. `src/config/parse.ts`: read and check it. In `src/config/parse.test.ts`: the default when it is absent, a good
   value, and each bad value refused with its message.
5. `plugins/teamrig/config.schema.json`: the key with its `type`, its `default` and a `description`, the sentence a
   user reads for it on the configuration page. A bound from step 3 also goes in `LIMIT_PATHS` in
   `src/config/schema.test.ts`, which holds the schema's bounds to `CONFIG_LIMITS`.
6. `npm run docs:config` redraws `docs/configuration.md` from the schema; `npm run check` fails until it is redrawn.
7. Name the key in brackets (`[block.key]`) where the guide (`plugins/teamrig/skills/teamrig-guide/`) describes the
   behaviour it sets.
8. Land it with `dev-ship-change`: the schema is under `plugins/teamrig/`, so the change raises the version.

## Traps

- `npm run docs:config` refuses a key with no `type`, or with a JSON Schema keyword it does not draw. Teach
  `tools/docs/configuration.ts` the keyword, with a test in `tools/docs/configuration.test.ts`, rather than drop it.
- An object inside a list or a map takes its parent's description; give its own keys theirs.
- Never edit `docs/configuration.md` by hand: the next redraw drops the edit, and the check fails before that.

Last verified: 2026-10-21
