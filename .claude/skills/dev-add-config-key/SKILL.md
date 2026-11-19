---
name: dev-add-config-key
description: Add a key to the teamrig team config, from its type and default to its schema description and the generated configuration page, with the specs that hold them equal.
---

# Add a config key

A config key is how a need that differs per team stays generic (CONTRIBUTING.md, Where a change lives): give it a
default that suits a team that never set it, so every user gets the feature without one team's values. A key in
place of a constant is the cheap early step
[What a change is held to](../../../CONTRIBUTING.md#what-a-change-is-held-to) asks for; a key no one needs to set is
not one. Name its risks in the pull request: a default that changes how a team that never set it behaves is a break
for that team.

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
8. Decide who may change it with `teamrig config set`. A key is the owner's unless listed in `LEAD_KEYS`
   (`src/config/lead-keys.ts`); list it only when changing it grants or takes away nothing a session may do, runs
   no program, moves no folder, and leaves the budget, the host's shared resources and every guard as they are.
   A key that is an owner gate also goes in `GATED_KEYS` (`src/config/settings.ts`) with its gate's name. The
   shipped-schema specs in `src/config/settings.test.ts` fail on a listed key that is not editable.
9. Land it with `dev-ship-change` as a `feat` commit: the release pull request raises the version.

## Traps

- `npm run docs:config` refuses a key with no `type`, or with a JSON Schema keyword it does not draw. Teach
  `tools/docs/configuration.ts` the keyword, with a test in `tools/docs/configuration.test.ts`, rather than drop it.
- An object inside a list or a map takes its parent's description; give its own keys theirs.
- Never edit `docs/configuration.md` by hand: the next redraw drops the edit, and the check fails before that.

Last verified: 2026-11-15
