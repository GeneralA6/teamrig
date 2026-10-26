---
name: dev-add-command
description: Add a teamrig CLI command, or a flag to one, with its help text, guide section, docs rows and tests, so the specs holding the docs to the CLI pass.
---

# Add a command

A command is an entry in `COMMANDS` in `src/cli/run.ts`. Three docs are held to the CLI by specs, so a command or
flag missing from any of them fails `npm test`.

1. Write the handler in `src/cli/commands/` (a new file, or its group's file such as `inbox.ts`), with its spec
   beside it, using the fakes in `src/testing/` for time, disks and git.
2. Add its entry to `COMMANDS` in `src/cli/run.ts`: its `flags`, its `switches` (flags that take no value), `rest`
   when it runs a command line given after `--`, its `effect` (`read`, `write` or `internal`: what `/teamrig` may
   run for the user) and a lazy `load`, so a hook that runs on every tool call loads only its own code.
3. Add its lines to `USAGE` in the same file: `teamrig help` prints them, and `teamrig <command> --help` its own.
4. Copy the output of `node src/cli/main.ts help` into the `## Every command` text block of `docs/commands.md`
   (held by `tools/docs/commands-doc.test.ts`).
5. Add a `### teamrig <command>` section to `plugins/teamrig/skills/teamrig-guide/commands.md` naming exactly its
   flags (held by `tools/docs/llm-guide.test.ts`, which also checks that every `teamrig` line in the guide and in
   `llms.txt` is one the CLI reads).
6. Add its row to `docs/features.md` (held by `tools/docs/features-doc.test.ts`).
7. Run `npm run docs:images`: the commands picture is drawn by running the CLI, and `npm run check` fails while it is
   stale.
8. Land it with `dev-ship-change`: the change is under `src/`, so it rebuilds the dist and raises the version.

## Traps

- A new flag on an existing command needs steps 2 to 6 too: the help line, the guide section's flags, the docs.
- The guide is a skill every user's Claude reads; describe what the command does for the user and its refusals, not
  how it is built.
- Changing a command's `effect` (say `read` to `write` once it writes) breaks three specs that list each command's
  effect: `src/cli/effects.test.ts`, `src/cli/slash.test.ts` and `src/slash/plan.test.ts` (what `/teamrig` runs at
  once). Update them in the commit that changes the effect, and run the `src/cli` and `src/slash` specs, not only
  the command's own.

Last verified: 2026-10-26
