---
name: dev-update-docs
description: Find which teamrig docs a change must update in the same pull request, redraw the generated pages and pictures, and run the checks that hold the docs to the code.
---

# Update the docs

Docs land in the same pull request as the change they describe. What each kind of change touches:

| Change | Update | Held by |
| --- | --- | --- |
| A command or a flag | `USAGE` in `src/cli/run.ts`, `docs/commands.md`, its guide section, `docs/features.md` (`dev-add-command`) | `tools/docs/commands-doc.test.ts`, `tools/docs/llm-guide.test.ts`, `tools/docs/features-doc.test.ts` |
| A config key | its `description` in `plugins/teamrig/config.schema.json`, then `npm run docs:config` (`dev-add-config-key`) | `npm run check` |
| A feature people see | `README.md`, `docs/features.md`, its user guide in `docs/guides/`, the guide in `plugins/teamrig/skills/teamrig-guide/` and `llms.txt` | `tools/docs/readme.test.ts`, `tools/docs/features-doc.test.ts`, `tools/docs/llm-guide.test.ts` |
| A new user guide | a page in `docs/guides/` with a contents list, linked from the README's Learn more table, `docs/how-it-works.md` and `llms.txt`; a section it takes leaves `how-it-works.md` | `tools/docs/guides.test.ts` |
| A check flag | the guide's flag tables | `tools/docs/check-flags-doc.test.ts` |
| A picture | its drawing in `tools/docs/`, then `npm run docs:images` | `npm run check` |
| A field in a stored file | its format number (CONTRIBUTING, Stored files) | the store's `fieldPaths` spec |
| How we build or ship | `CONTRIBUTING.md`, `CLAUDE.md` and these skills | `tools/docs/contributor-kit.test.ts` |

Then `npm run docs:check` (relative links, anchors and Mermaid diagram types) and `npm run check`.

## Traps

- Docs say what is true now. A feature that does not work yet is labelled `Coming` in the README; the change that
  makes it work drops the label.
- Three things are drawn, never edited by hand: `docs/configuration.md`, the pictures in `docs/images/` and the
  `## Every command` block of `docs/commands.md` (copied from `teamrig help`).
- Write docs for the user: what it does for them and how to fix each refusal, not how it is built.
- A line never starts with a bracketed name and a colon (`[register.goals]: ..`): Markdown reads it as a link
  definition, hides it from the page, and the link checks fail on its target. The guide is a plugin skill, so run
  `tools/docs/plugin-skills.test.ts` with the other docs specs.

Last verified: 2026-10-21
