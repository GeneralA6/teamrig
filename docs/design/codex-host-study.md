# Codex as a second agent host: the study

> **Status: proposed** (written 2026-11-19), the study [#634](https://github.com/teamrig/teamrig/issues/634) asks
> for. This is a design record, not a description of how teamrig works today: nothing here is built yet.

teamrig runs inside Claude Code today. This page is the probe [issue #634](https://github.com/teamrig/teamrig/issues/634)
asks for before any code: every Claude Code touch point teamrig relies on, set against what OpenAI's Codex offers, the
feature each one feeds, and what it would take to carry teamrig on Codex.

Read on 2026-11-19: teamrig at `main`, Codex at its newest release, **0.170.0** (tag
[rust-v0.170.0](https://github.com/openai/codex/tree/rust-v0.170.0/codex-rs), 2026-11-18), and the official Codex
docs, whose `developers.openai.com/codex/*` pages now redirect to `learn.chatgpt.com/docs/*`. Source paths below are
under that tag's `codex-rs/` folder. Codex moves fast and says its session-file format "isn't a stable interface", so
every row resting on that format is checked again against the installed `codex --version` before code is written.

Contents:

- [The verdict](#the-verdict)
- [What a Codex user can do today, by hand](#what-a-codex-user-can-do-today-by-hand)
- [Every feature, by host](#every-feature-by-host)
- [Hook events](#hook-events)
- [The blockers](#the-blockers)
- [What Codex cannot carry](#what-codex-cannot-carry)
- [One team on both hosts](#one-team-on-both-hosts)
- [The port, in slices](#the-port-in-slices)
- [Proofs on a live Codex host](#proofs-on-a-live-codex-host)

## The verdict

Codex 0.170.0 is a close host. Its hook engine follows Claude Code's: 11 of the 15 hook events teamrig uses, the same
deny, `additionalContext` and block shapes, `.claude-plugin/` manifests and `${CLAUDE_PLUGIN_ROOT}` read "for compat",
`SKILL.md` skills, `AGENTS.md` for rules, and `codex queue` to reach an idle session. The register, inbox, rules and
week plan are files and a CLI, so they work on both hosts already.

Three blockers stand before any claim that teamrig runs on Codex (see [The blockers](#the-blockers)): teamrig's hooks
file does not load on Codex at all, a teamrig update turns every guard off until a person trusts the hooks again, and
the team rules arrive as a file pointer instead of text. Each has a known fix.

The in-tab mod (the `/teamrig` command, bands, toasts, in-tab `/clear`, the idle wake by prompt) has no Codex
counterpart, as #634 expected. Most of its jobs have a slower route on Codex; tab titles, status circles and output
redaction do not.

**Recommendation:** the port goes ahead, in the slices below, guards last behind their security review. That call is
the maintainer's (#634, "What the maintainer decides").

## What a Codex user can do today, by hand

One lead session keeps the team's task list; Codex's own subagents return their findings to it. Nothing is guarded or
metered, and no line wakes a session: each session reads its own inbox.

1. Put the `teamrig` command on the path: clone the repository and add `plugins/teamrig/bin` to `PATH` (Node 22 or
   newer). The plugin's commands work as they do under Claude Code.
2. Describe the team in `~/.teamrig/teams/<team>/config.json` and tie the project to it with `.teamrig.json`, as in
   [Set up a team by hand](../setup-by-hand.md).
3. Give each Codex session its name: start it as `TEAMRIG_SESSION=<name> codex` (in PowerShell, set
   `$env:TEAMRIG_SESSION` first). Codex puts its own thread id in every shell it runs, as `CODEX_THREAD_ID`
   (`protocol/src/shell_environment.rs`), but teamrig does not read it yet.
4. Let Codex read the same rules files as Claude Code: in `~/.codex/config.toml` set
   `project_doc_fallback_filenames = ["CLAUDE.md"]`, and trust the project in Codex, which skips `AGENTS.md` and its
   fallbacks in an untrusted one.
5. Make teamrig's skills visible: copy or link the folders under `plugins/teamrig/skills/` into `~/.agents/skills/`.
6. Start each work block with `teamrig start --session <name>`, and read the inbox with `teamrig inbox read --session
   <name>`: no hook shows the lines.

Missing on this route, all named again below: the guards (pushes, packages, secrets, database writes, privileged
commands), the inbox shown at each prompt, wakes, the week meter and pace line, refresh and restore, and tab titles.

A Codex user's Windows smoke test on [#634](https://github.com/teamrig/teamrig/issues/634#issuecomment-7008781989)
ran this route in Codex Desktop, on Codex CLI 0.169.0-alpha.11.1: the `teamrig` CLI listed, added, started and finished
a review task in a project-local register, a Codex subagent did the read-only check, and the lead checked its findings
before recording the task done. The shell had `CODEX_THREAD_ID` set and `TEAMRIG_SESSION` unset, which is why step 3
names the session by hand. `codex resume` in the CLI listed the Desktop chat; while Desktop still held it, the CLI
showed a read-only notice and sent nothing twice. A finished handoff from Desktop to the CLI is still to be shown.

### What a Codex install holds today

teamrig ships no Codex package yet. Codex reads the Claude Code plugin through its `.claude-plugin/` manifests, so a
Codex install has the `teamrig` CLI (once it is on the path) and the plugin's skills, and no working hook: Codex
refuses teamrig's `hooks/hooks.json` whole (blocker 1), and a package built by hand may carry no hooks file at all.
A listing that shows hooks as enabled says Codex's hook feature is on, not that any teamrig hook loaded, so no guard,
inbox line or meter runs, whatever it shows. `teamrig doctor` cannot tell yet either: it looks for the full team setup
and Claude Code's settings and transcripts, and under Codex it stops at "no team here". The port's Codex check
(slice 3) works from the project-local register and gives each hook one of three states: absent, present but not
trusted, or verified active because it fired on a harmless test call.

## Every feature, by host

Works: no change needed. With change: works once the port's named change lands. Cannot: no Codex parallel; on a
Codex host teamrig prints a notice instead, never goes silently off. Nearest: no parallel, the closest Codex feature
named.

### Rules and context

| teamrig feature | Claude Code | Codex 0.170.0 | On Codex |
| --- | --- | --- | --- |
| Team rules, identity and live tasks at start | SessionStart `additionalContext` | SessionStart `additionalContext`, spilled to a file past about 2,500 tokens (`protocol/src/hooks.rs`) | with change: `additionalContextLimit: 0` on the handler |
| Every-turn rules files (`CLAUDE.md`) | read natively, nested ones on file access | `AGENTS.md` root to the working folder, `project_doc_fallback_filenames`, 32 KiB cap, read once per run, skipped in an untrusted project (`core/src/agents_md.rs`) | with change: fallback name `CLAUDE.md`; nested files below the working folder are not read |
| `.claude/rules/*.md` | read natively | none | nearest: fold into `AGENTS.md` |
| Auto memory | a file per fact and an index | model-made memories, not files teamrig can read | nearest: team facts stay in teamrig's notes and skills |
| Inbox lines, digest and budget line at each prompt | UserPromptSubmit `additionalContext` | the same | works |
| Holding auto-compaction while a handover is written | PreCompact `decision: block` | PreCompact `continue: false` with `stopReason` (`hooks/src/events/compact.rs`) | with change |
| Context size and refresh thresholds | Claude transcript usage | rollout `token_count` events, `model_auto_compact_token_limit` | with change: a rollout reader |

### Guards and permissions

| teamrig feature | Claude Code | Codex 0.170.0 | On Codex |
| --- | --- | --- | --- |
| Push, package, database-write and directory-hop guards | PreToolUse on `Bash` and `PowerShell` | PreToolUse with the same deny shape; every shell call is `Bash`, PowerShell too | with change: the shell dialect comes from the host, not the tool name |
| Secret, service-role and pass-record guards on file edits | PreToolUse on `Read`, `Grep`, `Write`, `Edit` | one `apply_patch` tool carrying the patch text; reads go through the shell | with change: a patch parser feeds the existing checks; until it lands, a patch touching a guarded path is refused |
| Privileged commands on review (`teamrig exec`) | exec guard, review typed in the mod | PreToolUse `Bash`; no mod for the review | cannot keep the typed review: `teamrig exec` is refused on Codex until a review path outside the model's reach exists |
| Read-only commands run without a prompt | PreToolUse bare `allow` | a bare `allow` is unsupported and fails open (`hooks/src/events/pre_tool_use.rs`) | nearest: `allow` prefix rules in `~/.codex/rules/` built from the read-only list, and the workspace-write sandbox |
| Refusing a question to the person when asks are off | PreToolUse on `AskUserQuestion` | `request_user_input`, off with `[tools.experimental_request_user_input] enabled = false` | with change, and stronger: the tool is never offered |
| Refusing permission prompts when asks are off | PermissionRequest `behavior` | the same shape; `approval_policy = "never"` | works |
| Redacting a secret in tool output | PostToolUse `updatedToolOutput` | no output rewrite (`updatedMCPToolOutput` "not supported yet") | cannot redact: the result is blocked whole; Codex's session file still keeps the raw output, up to 64 KiB (`rollout/src/policy.rs`) |
| A secret pasted in a prompt | UserPromptSubmit block, `suppressOriginalPrompt` | UserPromptSubmit block, run before the prompt is written (`core/src/hook_runtime.rs`) | with change: drop `suppressOriginalPrompt` |
| `permissions.deny` lines, their doctor checks and trim | `settings.json` | execpolicy `prefix_rule(..., decision = forbidden \| prompt \| allow)`, `codex execpolicy check`; rules see only commands run outside the sandbox | with change: a rules writer and its own doctor |
| Auto mode's granted push and deploy routes | `autoMode.environment` | no classifier | nearest: `allow` rules for the granted routes |

### Sessions

| teamrig feature | Claude Code | Codex 0.170.0 | On Codex |
| --- | --- | --- | --- |
| Open a tab on its model and effort | `claude --model --effort --name` | `codex --model M -c model_reasoning_effort=E`, `--profile` | with change: a launch line per host |
| Resume, restore after a reboot | `claude --resume <id>`, Claude transcripts | `codex resume <id>`, rollouts under `$CODEX_HOME/sessions/` | with change |
| The session's own id in the CLI | `CLAUDE_CODE_SESSION_ID` | `CODEX_THREAD_ID` in every shell, `session_id` in hook input | with change: the thread id mapped to the session's name; `TEAMRIG_SESSION` until then |
| Waking an idle session | the mod submits a prompt | `codex queue --thread <id> --message <text>` to the local app-server (`cli/src/queue_cmd.rs`) | with change, unproven live |
| Turn end | Stop hook | Stop hook, and `notify` | works |
| One-shot runs | interactive only | `codex exec`, `--json` events, `codex exec resume` | works, not used by teamrig yet |
| In-tab `/clear`, `/reload-plugins`, mid-turn refresh, `/teamrig`, bands, toasts | the mod | no mod API | cannot; refresh restarts the session with its first prompt |
| Carried crons, scheduled wakes, plan, scratchpad | carried over a refresh | none of these exist | cannot, and nothing to carry |
| Tab titles and status circles | hook `sessionTitle`, `terminalSequence` | no such output fields | cannot; the title set at open stays |
| Waiting-on-a-decision state, resend after an API error | Elicitation, StopFailure | not Codex events | cannot |
| Finding the session's process | `claude` | `codex` | with change |

### Skills, helpers, plugin

| teamrig feature | Claude Code | Codex 0.170.0 | On Codex |
| --- | --- | --- | --- |
| Plugin skills | `skills/*/SKILL.md` | the same layout and frontmatter | works |
| Team and session skills | `~/.claude/skills` | `~/.agents/skills`, repository `.agents/skills` | with change |
| A session's own skill listing | `--settings` skill overrides | `[[skills.config]] enabled = false`, per session only through a profile | with change, unproven |
| Helpers and the rules at their start | SubagentStart, PreToolUse `Agent` | SubagentStart; `spawn_agent` matches `Agent` | works |
| teamrig's agent types | `.claude/agents/*.md` | TOML files in `~/.codex/agents/` | with change: a converter |
| Install, update, version | `claude plugin install`, `update` | `codex plugin marketplace add`, `codex plugin add`, `codex plugin marketplace upgrade` | with change |
| `teamrig` on the path | the plugin's `bin/` | not added by Codex | with change: setup writes a launcher |

### Budget

| teamrig feature | Claude Code | Codex 0.170.0 | On Codex |
| --- | --- | --- | --- |
| Finding transcripts | `~/.claude/projects/<project>/` | `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl` | with change: a discoverer that maps a rollout to its project by its `cwd` |
| Per-call usage and W | input, cache writes, cache reads, output | `token_count` `info`: `total_token_usage` and `last_token_usage` (input, cached input, output, reasoning; no cache-write split), `model_context_window` | with change: a Codex weight set; W is per host |
| Model and effort share | per line | `model`, `model_reasoning_effort` in the turn context | with change |
| The week reading | the status line's `rate_limits` | `token_count.rate_limits`: a primary and a secondary window, each with `used_percent`, `window_minutes` and `resets_at`; the week is the one with `window_minutes` = 10080 | with change: one reading per account, never added across chats, since every chat repeats the same account-wide snapshot |
| teamrig's status-line text | the status-line command | Codex's footer takes built-in items only | cannot; shown elsewhere |
| Five-hour forecast | the five-hour window | none on Pro | with change: the week alone |
| Helper weight | fitted on Claude Code | not known | with change: fitted again on Codex |

### Windows

| teamrig feature | Claude Code | Codex 0.170.0 | On Codex |
| --- | --- | --- | --- |
| Native Windows sessions, Windows Terminal tabs | yes | native CLI under PowerShell, its own sandbox | works |
| Hooks on Windows | one `node` command | run by `cmd /C`, `commandWindows` per handler (`hooks/src/engine/command_runner.rs`) | with change: quoting for `cmd`, unproven live |

## Hook events

teamrig's hooks file wires 15 Claude Code events. Codex has 11 of them, and teamrig's handler for an event Codex lacks
never runs there.

| Event | Feeds | Codex 0.170.0 |
| --- | --- | --- |
| SessionStart | register start, rules, handover after a refresh | yes |
| UserPromptSubmit | inbox delivery, prompt secrets | yes |
| PreToolUse | the guards, the helper gate | yes |
| PermissionRequest | prompts refused when asks are off | yes |
| PostToolUse | output redaction, metering mid-turn | yes, without output rewrite |
| Stop | turn-end checks, metering | yes |
| PreCompact | holding compaction for a handover | yes, `continue: false` |
| PostCompact | tab status | yes |
| SessionEnd | restore tracking, effort write-back | yes |
| SubagentStart | helper rules | yes |
| SubagentStop | helper checks, helper metering | yes |
| PostToolUseFailure | tool-end status, the missing-command hint | no |
| Elicitation | the tab's waiting-on-a-decision state | no |
| ElicitationResult | the same | no |
| StopFailure | resending after an API error | no |

Codex adds `Interrupt`, `PostModelRequest` and others teamrig does not use yet.

## The blockers

1. **The hooks file does not load.** Codex reads a plugin's `hooks/hooks.json` with unknown fields refused, so
   teamrig's top-level `modules` key rejects the whole file, and its handlers' `args` field does not exist there
   (`config/src/hook_config.rs`, `protocol/src/hooks.rs`). Fix: a Codex hooks file, one `command` string per handler,
   `commandWindows`, a 15-second timeout (Codex's default is 600) and `additionalContextLimit: 0` on the start and
   prompt hooks. The same strictness holds for hook output: `terminalSequence`, `sessionTitle`,
   `suppressOriginalPrompt` and `updatedToolOutput` make a reply invalid, so the runtime emits per host.
2. **Every update turns the guards off.** Codex trusts a plugin's hooks by a SHA-256 over every file in the plugin
   (`hooks/src/engine/plugin_trust.rs`, `plugin_fingerprint.rs`), so any teamrig update leaves every guard skipped
   until a person trusts the hooks again in `/hooks`, with no refusal. Hooks in the user's own `$CODEX_HOME/hooks.json`
   are trusted by their definition alone. Fix: register the hooks there, each pointing at a fixed launcher outside the
   plugin that loads the current teamrig, so one trust holds across updates; and a `teamrig check` line that reads the
   trust state and refuses team work while a guard is untrusted. Never `--dangerously-bypass-hook-trust`: it trusts
   hooks teamrig did not write too.
3. **The rules arrive as a pointer.** SessionStart context past about 2,500 tokens is written to a file and the model
   sees a preview and its path. Fix: `additionalContextLimit: 0` on the handler (in the Codex hooks file of blocker 1).

## What Codex cannot carry

Each is named on a Codex host, never silently off:

- The mod: `/teamrig`, bands, toasts, in-tab `/clear` and `/reload-plugins`, the mid-turn refresh ask.
- Tab titles and status circles from hooks; renaming a session from inside it.
- Redacting a secret in tool output (the result is blocked instead), and a secret already in output stays in Codex's
  session file: rotate it.
- The review of a privileged command typed outside the model's reach, so `teamrig exec` is refused.
- teamrig's text in the status line; the typed `/effort` written back to the session.
- The waiting-on-a-decision tab state and the resend after an API error.
- Auto mode's classifier and its environment list.

## One team on both hosts

A Claude Code session spends the Anthropic plan's week and a Codex session the OpenAI plan's. Their W are not the same
unit, so a team on both hosts has two meters and two pace lines, one budget block per host, and a hold on one host
never stops the other's sessions. A team-wide figure may show each host's share of its own week; no hold is paced on
their sum.

## The port, in slices

Each slice is its own pull request after this page, as #634 asks. Sizes are estimates of changed non-test lines:
S under 200, M 200 to 600, L over 600.

| # | Slice | Holds | Size |
| --- | --- | --- | --- |
| 1 | The host port and its Claude Code adapter | a host in the hook runtime: output fields per host, PreCompact shape, tool names (`apply_patch`, `spawn_agent`) mapped; every hook test passes unchanged through it | M |
| 2 | The Codex hooks file and adapter | the generated Codex hooks file (blockers 1 and 3); a fake Codex host whose session start registers the session and reads its inbox, which fails on today's code | M |
| 3 | Guards on Codex, behind a security review | the user-hooks launcher and the trust check (blocker 2), a Codex check reading the project-local register and each hook's state (absent, untrusted, verified active), the shell dialect from the host, the `apply_patch` parser, `teamrig exec` refused, redaction as a block; a fake Codex host whose guarded call is refused | L |
| 4 | The rollout reader | context size, running work, helper transcripts, restore; refusing an unknown shape loudly, never reading it as 0 | M |
| 5 | Budget per host | first a read-only pass: per-chat `total_token_usage` and `last_token_usage`, and the rate-limit snapshot as its own reading per account, no transcript text read; then discover, weights and the week reading for Codex, two meters, a budget block per host | L |
| 6 | Sessions | launch, resume, process finder, child environment, wake by `codex queue`, refresh by restart | M |
| 7 | Install and setup | install and update per host, the path launcher, team skills in `~/.agents/skills`, agent types to TOML, the `/hooks` step in the guides | M |
| 8 | Docs | a host column in [Features](../features.md), the Codex setup guide | S |

Slices 1 and 2 meet #634's first acceptance checks; 3 meets its guard check. The rest can follow in any order, each
gated on its proofs below.

## Proofs on a live Codex host

Before a feature is claimed for Codex, a live run on Codex 0.170.0 or newer shows it, on Windows and on Linux:

1. Hooks run on native Windows.
2. A hook in the user's `hooks.json` keeps its one trust across a teamrig update.
3. A guard refuses a harmless fixture command, and a deny wins over another hook's allow on the same call.
4. `codex queue` to an idle open session starts its turn at once.
5. A blocked prompt is absent from the session's rollout file.
6. `request_user_input` is reachable by a PreToolUse matcher, and `enabled = false` removes it.
7. `token_count.rate_limits` shows the weekly window on each plan teamrig supports, under the field names the parser
   reads.
8. Each subagent writes its own rollout, and its use counts against the parent's week.
9. The installed plugin follows `codex plugin marketplace upgrade`, and a profile carries a session's own skill
   listing.

### A live check on Windows and PowerShell

A Codex user on Windows can run these checks once slices 2 and 3 are on a branch, beside the fake-host tests, and
post what each one shows on #634. Each runs in a throwaway project whose git remote is a local bare folder, so
nothing a guard misses can reach a real repository or package.

- **Guards**
  - The Codex hooks file loads under `cmd /C` with `commandWindows` and a short timeout, and Codex takes every output
    field teamrig sends without calling the reply invalid.
  - Record the shell and `apply_patch` inputs Codex really sends to PreToolUse, PowerShell commands included, and
    keep them as the fixtures for the fake-host tests.
  - A guard refuses a harmless fixture: a `git push` to the bare remote's `main`, and an `apply_patch` touching a file
    a guard covers.
  - An untrusted or skipped guard shows to the user and in `teamrig check`, and so does one after a plugin update has
    changed the hooks' trust.
- **Session lifecycle**
  - The session's identity holds on start and on `codex resume`: `CODEX_THREAD_ID` in the shell equals `session_id` in
    the hook input, and both stay the same across the resume.
  - SessionStart brings the team rules and, after a refresh, the handover, as text rather than a file pointer.
  - UserPromptSubmit shows the new inbox lines at the next prompt.
  - `codex queue` to an idle open session starts its turn.
  - A finished handoff: close the chat in Codex Desktop, `codex resume` it in the CLI, and one board command (say
    `teamrig list`) runs there as the same session.
- **Checks**
  - The Codex check reads the project-local register and names each hook absent, untrusted or verified active, and a
    hook listed as enabled that never fires shows as not active.
- **Budget**
  - A real Codex session log carries `total_token_usage`, `last_token_usage` and the primary and secondary
    `rate_limits` windows (`used_percent`, `window_minutes`, `resets_at`) under the names the reader parses.
  - Two chats on one account give one rate-limit reading, not two added together.
  - Codex and Claude Code use are counted against their own weeks, never summed.
