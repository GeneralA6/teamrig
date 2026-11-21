# Skills that fit every host and tool (design)

> **Status: draft for review.** A design record, not how teamrig works today. Part of the harness work that makes
> every AI CLI and every outside tool a plug-in of teamrig ([#1884](https://github.com/teamrig/teamrig/issues/1884),
> [#1885](https://github.com/teamrig/teamrig/issues/1885)).

**Contents**

- [The rule](#the-rule)
- [Two kinds of skill](#two-kinds-of-skill)
- [Where a provider step goes](#where-a-provider-step-goes)
- [Step texts](#step-texts)
- [Holding it: the provider-word check](#holding-it-the-provider-word-check)
- [This repo's own skills](#this-repos-own-skills)
- [Rejected](#rejected)
- [Risks](#risks)
- [Order of work](#order-of-work)

## The rule

A skill teamrig ships fits any host (the AI CLI a session runs in) and any connector (the tracker or code host a
team works with). It names roles, never a product:

| Role | Says | Not |
| --- | --- | --- |
| tracker | an issue, its labels, its assignee | a GitHub issue, a Jira ticket |
| code host | a change request, its checks, its review | a pull request, a merge request, `gh pr` |
| reviewer | the reviewer, the security reviewer | a GitHub review |
| host | a session, a context refresh, the host's instruction files, its rules folder | a Claude Code session, `/clear`, `CLAUDE.md`, `.claude/rules` |

A step that only one product has (a button on GitHub, a slash command of one CLI) is that product's text, kept in its
adapter's folder and shown only to teams that use it.

## Two kinds of skill

- **Generic, in the plugin** (`plugins/teamrig/skills/`): what any team using teamrig needs. teamrig's own team uses
  them too, so a how-to its sessions keep writing for themselves is a plugin skill unless it hinges on one team.
- **Developing teamrig, in this repo** (`.claude/skills/dev-*`): only for work on teamrig's own code and release.
  A proof of teamrig's guard or hook is here: no user proves teamrig's code.
- What hinges on one team stays in that team's skills or rules, as today.

A check of whether the host changed upstream (which status-line fields a release sends, whether a hook's allow still
loses to a deny) is a third case: it belongs to the host's adapter, as one of its conformance checks
([public-interface.md, The conformance kit](public-interface.md#the-conformance-kit)), so every adapter author has it.

## Where a provider step goes

In this order; the first that fits wins.

1. **A teamrig command, served by a port.** A step that does something (search issues, show one, open one, list
   security alerts, fetch an outside change for review) becomes a neutral command whose connector does the work:
   `teamrig issue search`, `issue show`, `issue open`. Code, so the contract tests hold every connector to it; the
   skill says the command and nothing about the product. Many exist already (`issue reply`, `close`, `label`,
   `similar`, `assign`, `links`, `edit`).
2. **A host word.** A word the host names differently (its refresh, its instruction files, its rules folder, its
   name for a session) comes from the host adapter's `HostTexts`, which already carries the reload, exit and resume
   lines. The skill writes the neutral word; the guide and the start text print the host's word beside it when a
   reader needs the literal.
3. **A step text.** Knowledge with no command behind it: how GitHub links a sub-issue, where a forge takes a private
   vulnerability report, how a host parks a skill. The adapter or connector ships it as a step text
   ([below](#step-texts)); the skill says "run `teamrig skills step <id>` and follow it".

A measurement a skill runs as a script (helper cost per run, spend by model, a tab held by a hook's ask) is a
command too, reading transcripts through the host's `TranscriptReader` and `UsageMeter` ports, so it works for every
host whose adapter serves them.

## Step texts

- **The registry.** A closed list of step ids beside the feature registry (`src/features/steps.ts`), each with its
  side (host or connector), one line of what it covers and a neutral fallback: `tracker.link-child`,
  `codehost.private-report`, `codehost.fetch-outside-change`, `host.rename`, `host.slim-setup`,
  `host.denial-sources`. A new id is one line, like a feature row.
- **The text.** Each adapter folder holds `steps.md`, one `## <step id>` section per step it serves, in the same
  plain style as a skill. Its declaration lists those ids (`steps: [...]`). The loader checks them as it checks the
  manifest: an id not in the registry, or a listed id with no section, refuses the adapter; a spec holds every built-in
  adapter to it.
- **The command.** `teamrig skills step <id> [--for <ref>]` prints the text of each configured adapter that serves the
  step, headed by its name; `--for gh:owner/name#12` picks the connector by the ref's prefix. With none configured it
  prints the registry's fallback and says which adapter would serve it. It runs at the moment of use, so it serves any
  host that can run a shell line, and only the text needed enters the context, which matters most on a host that
  clips its start text or its skill listing.
- **Only teamrig's own adapters ship step texts.** A step text enters a model's context as an instruction. An outside
  adapter speaking the protocol (public-interface.md, rule 2) is outside data, so its text is never printed as a step;
  its steps fall back to the registry's line.

## Holding it: the provider-word check

- Each declaration names its product's words: `terms: ['GitHub', 'gh', 'pull request']`,
  `['Claude Code', 'CLAUDE.md', '.claude/', '/clear']`, `['Jira', 'JQL']`. Optional, so the plugin API version
  takes a minor step. A term matches as a whole word at its word-character edges, so `gh` never hits `high`. Until
  step 3 moves them into the declarations, the terms live in the check's own `tools/ci/provider-words.ts`.
- `tools/ci/provider-words-cli.ts` counts each term in `plugins/teamrig/skills/**` and `.claude/skills/**`, with a
  baseline file per skill like `tools/ci/boundaries-cli.ts`: warn mode first, a count may fall but never rise, and it
  fails once a skill reaches zero. Step texts (`steps.md`) and docs about one product are outside its reach.
- A new adapter brings its own words, so the check needs no edit for a third host or connector.

## This repo's own skills

This repository lives on one forge and builds one host's plugin, so its `dev-*` skills meet product words where
they describe this repo's own tooling (`tools/ship/ship.ts`, its release workflow, `.github/pull_request_template.md`).
Proposed: those may stay when they name this repo's files; a raw provider command (`gh issue list`) still goes
through a teamrig command or `ship.ts`, and the check counts `dev-*` too, with a baseline. **Open for the lead:**
keep this, or hold `dev-*` to zero as well.

## Rejected

- **A copy of each skill per connector at build time.** The plugin is one static set; a team's connectors are its
  config, so the build cannot know which copy a team needs, and every listed copy costs each session's start text.
- **Provider skills shipped beside the neutral ones** (a `github-intake` skill). The same listing cost, and a team on
  Jira still reads a GitHub skill's name in its list.
- **Provider steps in the team's rules.** They would not reach other users, and generic steps belong in the plugin.

## Risks

- A step text goes stale against its adapter's code: the spec holds ids and sections; a text's commands are checked
  by the same commands-doc spec that holds the guide.
- A skill eval or scorecard sees only the skill, not the step text it prints: the scorecard counts the `skills step`
  call as part of the skill's run.
- More round trips: one shell call per step text. Kept small by preferring commands (1) and host words (2); step
  texts are for the few steps no command can carry.

## Order of work

Each its own pull request, with a test that fails without it.

1. This design.
2. The provider-word check in warn mode, with today's baseline.
3. The step registry, `steps` and `terms` in the declaration, the loader's check, `teamrig skills step`, and the
   GitHub and Claude Code texts for the first steps.
4. `teamrig issue search`, `issue show` and `issue open` on the tracker port, where missing.
5. First moves: `dev-github-intake` becomes the plugin's `intake` skill, neutral (`dev-design-issue` folds into it;
   teamrig's own beliefs stay in CONTRIBUTING.md); `write-issue` and `approvals` neutral.
6. The generic session skills a team wrote for itself move into the plugin, neutral: shared how-tos first (handing out work, a renamed session, a step
   killed for memory, a test gate's idle stop, a guard's denial), then the forge reads (security alerts, a repo's
   private-data scan, a contributor's record), then the measurements as commands.
7. The check fails on any provider word in a plugin skill.
