# Antigravity CLI as an agent host: the study

> **Status: proposed** (written 2026-11-20). This is a design record, not a description of how teamrig works today:
> nothing here is built yet, and **no fact below was read on a live install**.

teamrig runs inside Claude Code today, and [the Codex study](codex-host-study.md) set a second host against it. A
user asked for teamrig on Google's Antigravity CLI (`agy`), so this page does the same for it before any code: every
Claude Code touch point teamrig relies on, set against what `agy` offers, the feature each one feeds, what each host
port must hold for it, and what it would take to carry teamrig there.

Read on 2026-11-20: teamrig at `main`, and Antigravity CLI at **1.5.12** (2026-11-19), the newest release its
changelog names, from its official docs and from four third-party pages that report live runs on versions 1.0.16 to
1.2.14 ([Sources](#sources)). Its installer already served a build 1.5.13 that day, with no changelog entry yet, and
its changelog entries before 1.5.9 were not read. `agy` is closed source, so unlike the Codex
study no row here rests on code: each says what the docs say, a fact resting on a third party alone is marked
*(third party)*, and all of it stays unverified until [a live proof](#proofs-on-a-live-antigravity-host). That live
read is the port's first slice.

`agy` took over from Gemini CLI for personal Google accounts on 2026-06-18. It keeps its files under `~/.gemini`,
shares part of them with the Antigravity desktop app and IDE, and installs natively on Windows, macOS and Linux.

Contents:

- [The verdict](#the-verdict)
- [What an Antigravity user can do today, by hand](#what-an-antigravity-user-can-do-today-by-hand)
- [Every feature, by host](#every-feature-by-host)
- [Hook events](#hook-events)
- [What each host port must hold](#what-each-host-port-must-hold)
- [Budget, context and the other values a host supplies](#budget-context-and-the-other-values-a-host-supplies)
- [The blockers](#the-blockers)
- [What Antigravity cannot carry](#what-antigravity-cannot-carry)
- [One team on several hosts](#one-team-on-several-hosts)
- [The port, in slices](#the-port-in-slices)
- [Proofs on a live Antigravity host](#proofs-on-a-live-antigravity-host)
- [Sources](#sources)

## The verdict

Antigravity CLI 1.5.12 is a farther host than Codex. It has a hook engine of its own design: six events, of which
four are among the 15 teamrig wires, with its own payload and reply shapes. Of teamrig's 49 host features, 4 work as
documented, 34 need a named change, 4 have only a nearest route and 7 cannot be carried.

What fits well: a PreToolUse hook that refuses a call with a reason; separate read, search, write and edit tools that
each carry a plain path, so the file guards need no patch parser; a status-line command whose input carries the
week's quota and the context in use; a title command that runs at every change of the session's state; a Stop hook
that can keep a turn going; `SKILL.md` skills and Markdown agent files; plugins that bundle hooks; and no trust step
that an update could undo.

Four blockers stand before any claim that teamrig runs on Antigravity (see [The blockers](#the-blockers)): a guard
that fails is silent, a resumed conversation gets no session start, teamrig's hooks file cannot load as shipped, and
nothing says a guard runs inside a helper. Each has a fix or a refusal until its proof.

Three losses have no fix today: nothing wakes an open idle session, a secret typed in a prompt cannot be stopped,
and a secret in tool output can be neither seen nor redacted by a hook.

**Recommendation:** the port goes ahead on the host ports, starting with a live read that confirms or corrects this
page, guards last behind their security review. Until a wake route is proven, a team keeps the sessions that must
answer a wake (its lead, its reviewers) on a host that has one.

## What an Antigravity user can do today, by hand

One lead session keeps the team's task list. Nothing is guarded or metered, and no line wakes a session: each session
reads its own inbox.

1. Put the `teamrig` command on the path: clone the repository and add `plugins/teamrig/bin` to `PATH` (Node 22 or
   newer). The plugin's commands work as they do under Claude Code.
2. Describe the team in `~/.teamrig/teams/<team>/config.json` and tie the project to it with `.teamrig.json`, as in
   [Set up a team by hand](../setup-by-hand.md).
3. Give each session its name: start it as `TEAMRIG_SESSION=<name> agy` (in PowerShell, set `$env:TEAMRIG_SESSION`
   first). No session variable of `agy`'s own is documented in the shells it runs.
4. Let `agy` read the project's rules: it reads `AGENTS.md` and `GEMINI.md`, not `CLAUDE.md`. An `AGENTS.md` can
   inline another file with an `@[label](path)` line; each file is capped at 24 KB and all of them at 20,000 tokens.
5. Make teamrig's skills visible: copy or link the folders under `plugins/teamrig/skills/` into
   `~/.gemini/config/skills/`, or into the project's `.agents/skills/`.
6. Start each work block with `teamrig start --session <name>`, and read the inbox with `teamrig inbox read --session
   <name>`: no hook shows the lines.

Four cautions:

- **Sign-in.** `agy` has no login or status command. Its first interactive launch opens the browser for the Google
  sign-in and asks for a colour scheme, a rendering mode and trust in the folder. The token stays in the OS keyring
  until `/logout`, and a one-shot `-p` run uses it. So a person opens `agy` once before any session runs unattended.
- **Updates.** `agy` updates itself unless `AGY_CLI_DISABLE_AUTO_UPDATE` is set, and its installer serves only the
  newest build: a team can neither pin an older build nor go back to one.
- **The sandbox.** With the terminal sandbox on (`--sandbox`, and `auto` mode needs it), a command the model runs may
  not reach the team's folder outside the project, so `teamrig` may fail to write there until it is granted.
- **A converted plugin.** `agy plugin import claude` converts an installed Claude Code plugin, but what it makes of
  teamrig's hooks is unknown: `agy` accepts an event name it does not know and never fires it, so a converted hooks
  file can list hooks that never run.

Missing on this route, all named again below: the guards, the inbox shown at each prompt, wakes, the week meter and
pace line, refresh and restore, and tab titles.

## Every feature, by host

Each row is one row of the host feature registry (`HOST_FEATURES` in `src/features/`), named by its id. Works: no
change needed. With change: works once the port's named change lands. Nearest: no parallel, the closest route
named. Cannot: no parallel; on an Antigravity host teamrig prints a notice instead, never goes silently off. In an
adapter's manifest a row is `supported` only with its live proof, `partial` until then and for a nearest route, and
`unsupported` for a cannot.

### Rules and context

| teamrig feature | Claude Code | Antigravity CLI 1.5.12 | On Antigravity |
| --- | --- | --- | --- |
| Team rules, identity and live tasks at start (`rules.session-start`) | SessionStart `additionalContext` | SessionStart reply `injectSteps`, once per new conversation; a resume (`-c`, `--conversation`, the picker) never fires it *(third party)*; no size limit stated | with change: the start text as an injected step; a resumed conversation takes it at its first model call (blocker 2) |
| Every-turn rules files (`rules.instruction-files`) | `CLAUDE.md`, read natively | `AGENTS.md` and `GEMINI.md` from the working folder up to the repository root, `~/.gemini/GEMINI.md`; 24 KB a file, 20,000 tokens in all; `CLAUDE.md` is not read | with change: an `AGENTS.md` that inlines `CLAUDE.md`, within the caps |
| The project's rules folder (`rules.rules-folder`) | `.claude/rules/*.md` | `.agents/rules/*.md` and `~/.gemini/config/rules/*.md`, each with a `trigger` (`always_on`, `model_decision`, `glob`, `manual`) | with change: the folder per host; a path-scoped rule becomes `trigger: glob` |
| Auto memory (`rules.memory`) | a file per fact and an index | none documented for the CLI | nearest: team facts stay in teamrig's notes and skills |
| Inbox lines, digest and budget line at each prompt (`inbox.prompt-line`) | UserPromptSubmit `additionalContext` | no prompt event; PreInvocation runs before every model call, with `invocationNum` and `lastUserInput`, and replies `injectSteps` | with change: new lines injected at PreInvocation, each shown once; a hook process then starts before every model call |
| Holding a compaction while a handover is written (`context.compact-hold`) | PreCompact `decision: block` | no compaction event; older turns are compacted on their own, threshold and off switch not stated | cannot; the refresh threshold is set below the host's own compaction once that is measured |
| Context size and refresh thresholds (`context.size`) | Claude transcript usage | `context_window` in the status-line and title input: `used_percentage`, `context_window_size` | with change: read from the status-line input |

### Guards and permissions

| teamrig feature | Claude Code | Antigravity CLI 1.5.12 | On Antigravity |
| --- | --- | --- | --- |
| Push, package, database-write and directory-hop guards (`hooks.pretool-guard`) | PreToolUse on `Bash` and `PowerShell` | PreToolUse on `run_command` (`CommandLine`, `Cwd`), reply `decision: deny` with a `reason`; no shell dialect field; a failed hook is ignored | with change: the deny shape, the dialect from the host, input sent to a running task (`manage_task`) through the same checks, and blocker 1 |
| Secret, service-role and pass-record guards on reads and edits (`hooks.file-guard`) | PreToolUse on `Read`, `Grep`, `Write`, `Edit` | `view_file`, `list_dir`, `find_by_name`, `grep_search`, `write_to_file`, `replace_file_content`, `multi_replace_file_content`, each with a plain path; some builds name them `read_file`, `write_file`, `edit_file` *(third party)* | with change: both name sets and their argument names mapped; no patch parser |
| Privileged commands on review (`hooks.exec-review`) | exec guard, review typed in the mod | PreToolUse on `run_command`; no mod; `decision: force_ask` puts the host's own prompt before the person | cannot keep the typed review: `teamrig exec` is refused until `force_ask` is proven to hold under every permission mode |
| Read-only commands run without a prompt (`hooks.readonly-allow`) | PreToolUse bare `allow` | reply `allow` or `auto_approve`; `command(prefix)` allow rules in the settings | with change: `auto_approve` for the read-only list, unproven |
| Refusing a question to the person when asks are off (`hooks.ask-refuse`) | PreToolUse on `AskUserQuestion` | the `ask_question` and `ask_permission` tools | with change: a deny on both |
| Refusing permission prompts when asks are off (`hooks.permission-refuse`) | PermissionRequest `behavior` | no permission event; PreToolUse may answer `deny_unless_prior_grant` before any prompt | nearest: that answer on every call while asks are off, so no prompt shows |
| Redacting a secret in tool output (`hooks.output-redact`) | PostToolUse `updatedToolOutput` | PostToolUse carries the call and an `error`, no output, and its reply is empty | cannot: a hook neither sees nor rewrites the output; the read guards stand before the call, and a turn-end scan of the transcript names a secret to rotate |
| A secret pasted in a prompt (`hooks.prompt-secret`) | UserPromptSubmit block | no prompt event; PreInvocation sees `lastUserInput` and can end the turn, but the prompt stays in the conversation | cannot stop or hide it; the turn is ended and the person told to rotate the secret and start a new conversation |
| Tool-end status and the missing-command hint (`hooks.tool-failure`) | PostToolUseFailure | PostToolUse `error`, empty on success; one live log shows its `toolCall` empty *(third party)* | with change: a failure read from `error` |
| Permission deny lines, their doctor checks and trim (`permissions.deny-lines`) | `settings.json` | `permissions` allow, ask and deny lists in `~/.gemini/antigravity-cli/settings.json`, rules as `action(target)` such as `command(git push)`, deny over ask over allow | with change: a rules writer and its own doctor |
| Auto mode's granted push and deploy routes (`permissions.auto-mode-routes`) | `autoMode.environment` | an `auto` mode with no environment list | nearest: allow rules for the granted routes |

### Sessions

| teamrig feature | Claude Code | Antigravity CLI 1.5.12 | On Antigravity |
| --- | --- | --- | --- |
| Open a tab on its model, effort and name (`sessions.open`) | `claude --model --effort --name` | `agy --model <slug> --effort <level>`, `-i` for a first prompt; no name flag; a first launch asks for a colour scheme, a rendering mode and trust in the folder | with change: a launch line per host; the name shows through the title command; whether those questions hold a tab opened unattended is a live proof |
| Resume, restore after a reboot (`sessions.resume`) | `claude --resume <id>`, Claude transcripts | `agy --conversation <id>`, `-c`; conversations belong to their working folder | with change |
| The session's own id in the CLI (`sessions.identity`) | `CLAUDE_CODE_SESSION_ID` | `conversationId` in every hook's input; no variable documented in the shell | with change: the name from `TEAMRIG_SESSION` set at launch, tied to the conversation id at the first hook |
| Waking an idle session (`sessions.wake`) | the mod submits a prompt | no documented local route: `agy acp` serves the program that launched it, remote control goes through Google's cloud, `schedule` is the agent's own timer | cannot; nearest: the Stop hook continues a turn when a line waits, and a one-shot `agy -p --conversation <id>` serves a session whose tab is closed |
| Turn end (`sessions.turn-end`) | Stop hook | Stop with `terminationReason` and `fullyIdle`; `decision: continue`; the transcript is written only after it *(third party)* | with change: the checks run at Stop, the turn's use is metered at the next event |
| Finding the session's process (`sessions.process`) | `claude` | `agy` | with change |
| In-tab `/clear`, `/reload-plugins`, mid-turn refresh, `/teamrig`, bands, toasts (`sessions.in-tab`) | the mod | no mod API | cannot; refresh restarts the session with its first prompt |
| Carried crons, scheduled wakes, plan, scratchpad (`sessions.carry`) | carried over a refresh | a `schedule` belongs to its conversation, with no listing from outside | cannot; the handover names what the new conversation sets again |
| A typed effort level written back (`sessions.effort-writeback`) | SessionEnd | no session-end event; the model slug, which carries the effort, is in the status-line input | with change: read from the status-line input |
| Tab titles and status circles (`tabs.title-status`) | hook `sessionTitle`, `terminalSequence` | a `title` command that runs at every state change and prints the title | with change: teamrig as the title command; the status shows as a mark in the title, a coloured circle unproven |
| Waiting-on-a-decision state (`tabs.waiting-state`) | Elicitation | `agent_state` (`reviewing` among its values) and `pending_input_count` in the title input | with change, unproven |
| Resend after an API error (`wake.api-retry`) | StopFailure | Stop with `terminationReason: error` and the `error` text | with change: such a Stop is continued, a bounded number of times |

### Skills, helpers, plugin

| teamrig feature | Claude Code | Antigravity CLI 1.5.12 | On Antigravity |
| --- | --- | --- | --- |
| Plugin skills (`skills.plugin`) | `skills/*/SKILL.md` | the same layout, `description` required, called as `/<plugin>:<skill>` | works |
| Team and session skills (`skills.team`) | `~/.claude/skills` | `~/.gemini/config/skills/`, the project's `.agents/skills/`; which wins on a shared name is disputed between sources | with change |
| A session's own skill listing (`skills.session-listing`) | `--settings` skill overrides | no per-session switch; an agent file lists its `skills`, and `agy --agent <name>` opens a session as that agent | nearest: an agent file per session, unproven |
| Helpers and the rules at their start (`helpers.start-rules`) | SubagentStart, PreToolUse `Agent` | no helper events; `invoke_subagent` passes PreToolUse, whose `overwrite` reply changes its arguments; whether hooks fire inside a helper is not stated | with change: the gate and the rules on `invoke_subagent`; helpers are refused until blocker 4 is cleared |
| teamrig's agent types (`helpers.agent-types`) | `.claude/agents/*.md` | `.agents/agents/<name>.md`, Markdown with its own front matter (`model` as `inherit`, `flash_lite`, `flash` or `pro`) | with change: a converter |
| teamrig's hooks file loads as shipped (`plugin.hooks-file`) | `hooks/hooks.json` | its own shape: named groups, six events, one `command` per handler | with change: a generated Antigravity hooks file (blocker 3) |
| Guards stay on across a teamrig update (`plugin.hook-trust`) | yes | no trust step documented; a plugin's files are replaced on update; `/hooks`, a group's `enabled` key and the `pluginsDisabled` setting switch hooks off | works; the check still proves each guard fires (blocker 1) |
| Install, update, version (`plugin.install-update`) | `claude plugin install`, `update` | `agy plugin install <url or path>`, `list --json`, `validate`; a manifest with unknown fields refused | with change: an Antigravity manifest |
| `teamrig` on the path (`plugin.cli-on-path`) | the plugin's `bin/` | not added | with change: setup writes a launcher |

### Budget

| teamrig feature | Claude Code | Antigravity CLI 1.5.12 | On Antigravity |
| --- | --- | --- | --- |
| Finding transcripts (`budget.transcripts`) | `~/.claude/projects/<project>/` | `~/.gemini/antigravity-cli/brain/<conversationId>/`, the path given to every hook as `transcriptPath` | with change: a discoverer fed by the hooks' own path |
| Per-call usage and W (`budget.usage`) | input, cache writes, cache reads, output | token counts on the transcript's model-reply steps (input and cache reads; no cache-write split) *(third party)*; a one-shot run prints input, output, thinking and cache-read tokens | with change: an Antigravity weight set; W is per host |
| Model and effort share (`budget.model-share`) | per line | `modelName` in every hook's input; the slug carries the effort | with change |
| The week reading (`budget.week-reading`) | the status line's `rate_limits` | `quota` in the status-line input: per bucket (such as `gemini-weekly`) a remaining share or amount and a reset time; limits are per model group, their numbers unpublished | with change: one reading per bucket, used as one minus remaining |
| Five-hour forecast (`budget.five-hour`) | the five-hour window | a five-hour limit per model group; its bucket name unread | with change, unproven |
| teamrig's status-line text (`budget.status-line`) | the status-line command | a `statusLine` command, shown beside the host's own line with `stack_with_default` | with change: teamrig as that command |
| Helper weight (`budget.helper-weight`) | fitted on Claude Code | not known | with change: fitted again on Antigravity |

### Windows, macOS and Linux

| teamrig feature | Claude Code | Antigravity CLI 1.5.12 | On Antigravity |
| --- | --- | --- | --- |
| Native Windows sessions, Windows Terminal tabs (`os.windows-sessions`) | yes | a native CLI with a PowerShell installer; its sandbox needs Windows 11 | works |
| Hooks on Windows (`os.windows-hooks`) | one `node` command | run by `cmd /c` *(third party)* from the folder that holds the hooks file | with change: quoting for `cmd`, unproven live |
| Sessions and hooks on Linux and macOS (`os.linux`) | yes | hooks run by `sh -c`; a namespace sandbox on Linux, Seatbelt on macOS | works |

## Hook events

teamrig's hooks file wires 15 Claude Code events. Antigravity has six events: four of the 15, and two of its own
that run before and after every model call. The event's name is not in a hook's input *(third party)*, so each
handler's command line carries it.

| Event | Feeds | Antigravity CLI 1.5.12 |
| --- | --- | --- |
| SessionStart | register start, rules, handover after a refresh | yes, for a new conversation only |
| UserPromptSubmit | inbox delivery, prompt secrets | no; PreInvocation delivers, and cannot stop a prompt |
| PreToolUse | the guards, the helper gate | yes |
| PermissionRequest | prompts refused when asks are off | no; PreToolUse answers before the prompt |
| PostToolUse | output redaction, metering mid-turn | yes, without the output or a rewrite |
| Stop | turn-end checks, metering | yes, and it can continue the turn |
| PreCompact | holding compaction for a handover | no |
| PostCompact | tab status | no |
| SessionEnd | restore tracking, effort write-back | no |
| SubagentStart | helper rules | no; PreToolUse on `invoke_subagent` |
| SubagentStop | helper checks, helper metering | no; PostToolUse on `invoke_subagent` |
| PostToolUseFailure | tool-end status, the missing-command hint | no; PostToolUse's `error` |
| Elicitation | the tab's waiting-on-a-decision state | no; the title input's `agent_state` |
| ElicitationResult | the same | no |
| StopFailure | resending after an API error | no; Stop with `terminationReason: error` |

Antigravity adds PreInvocation and PostInvocation. Both may inject steps into the conversation (a system message, a
user message, a message for one call only, or an error shown to the person and kept from the model) and may end the
turn; PostInvocation may also force it on.

## What each host port must hold

The host ports are the small interfaces teamrig's layer-2 design puts between its core and an AI CLI; Claude Code is
their first adapter. This is what Antigravity asks of each, and where it asks more than Claude Code and Codex do.

| Port | On Antigravity | What it asks of the port |
| --- | --- | --- |
| `HookBridge` | parses camelCase input with no event name, takes the project from `workspacePaths` (the hook's own folder is the hooks file's); replies with one of six `decision` values, `injectSteps` or `terminationBehavior`; writes the generated hooks file | an event that Claude Code lacks (before and after a model call); "add context", "refuse", "keep the turn going" and "end the turn" as host-neutral decisions; a failure rule that says "every failure passes" (blocker 1) and a "no opinion" reply that writes nothing, since an empty object refuses *(third party)* |
| `ToolCallShape` | `run_command` is the shell, with the dialect from the host's OS; six file tools carry a plain path; `search_web` and `read_url_content` are web, `invoke_subagent` the helper, `ask_question` the ask, `schedule` the schedule; MCP tools match `mcp_.*` | arguments in PascalCase and two name sets per tool; a path that may arrive encoded twice *(third party)*; one new shape: input sent to a running task (`manage_task` `send_input`), read as a shell call |
| `Paths` | home `~/.gemini`, which no variable moves; the CLI's settings in `~/.gemini/antigravity-cli/`; hooks, plugins, skills and rules in `~/.gemini/config/`; the project's `.agents/`; credentials in the OS keyring | a settings scope shared with other programs: a hook written to `~/.gemini/config/` may also fire in the desktop app and IDE, so the adapter picks the plugin or project scope until that is read live; per-file and total size caps as data |
| `TranscriptReader` | the path from each hook; JSON lines of typed steps, in a file whose name differs between sources | the file is written only after Stop, so nothing live is read from it; an unknown step shape is refused loudly |
| `UsageMeter` | per-call tokens from the transcript; the week from `quota`; the context from `context_window` | a week reading per quota bucket, not one per account; a token-kind split with no cache writes; readings that arrive pushed (the status-line input), kept by the adapter for the next ask |
| `StatusLine` | `statusLine` and `title` keys in the CLI's settings; both commands get the same JSON | two commands to install, and the main live feed of the adapter: quota, context, state, model, pending input; the host runs the command at most every 300 ms, ends it after 5 s and switches it off after 30 failures in a row, so the adapter flags a reading that went stale |
| `SessionLauncher` | `agy`, `--model`, `--effort`, `--conversation`, `-i`; one-shot runs with `-p --output-format json`, whose `status` is one of `SUCCESS`, `ERROR`, `CANCELED`, `INTERRUPTED`, `INVALID`, `WAITING` and `RUNNING`, with an `error` text | `identity(env)` answers from `TEAMRIG_SESSION` alone, and `wake()` is none; a one-shot run has no time limit unless `--print-timeout` sets one, and exits 0 after an action it was not granted, so the launcher sets the limit and reads `status`, never the exit code alone |
| `HostPermissions` | allow, ask and deny lists of `action(target)` rules; trusted workspaces; ceilings an administrator may set | a rule grammar of its own for the writer and the doctor; trusted routes as allow rules |
| `HostPlugin` | `agy plugin list --json`, install from a path or URL, the installed copy under `~/.gemini/config/plugins/` | a manifest of its own beside Claude Code's, since unknown fields are refused |
| `HostTexts` | `agy --conversation <id>` to resume, `/exit` (or Ctrl+D on an empty prompt) to leave, `/skills reload`, `agy update`; `agy models` lists the slugs; no login command | models whose slug carries the effort, beside an effort flag; agent files that name models by class; a sign-in text that names a first launch, not a command |

No port changes shape for Antigravity. It adds three things the ports must allow: events of the host's own, a
shared settings scope, and a week reading per quota bucket.

## Budget, context and the other values a host supplies

The layer-2 design keeps each rule in core and takes its numbers from the host's adapter. Antigravity's are:

- **Budget pool.** One pool per CLI and account is not enough here: Antigravity meters a week and a five-hour window
  per model group, and its groups include other vendors' models. Its pools are one per account and quota bucket, and
  a session draws from the bucket of the model it runs on. A Claude model run through `agy` spends Google's quota,
  never the Anthropic plan's week. The status-line input names the account (`email`, `plan_tier`): the adapter tells
  accounts apart by a hash of it and stores no address.
- **Week reading.** From `quota`, as a share remaining and a reset time. The limits themselves are not published and
  the `/usage` panel cannot be read from a script, so a pool with no reading yet shows W with no pace line.
- **Weights and helper weight.** Unknown, and fitted on Antigravity from its own transcripts. The `cost` in the
  status-line input is a list-price estimate and is not used as a reading.
- **Models, effort and defaults.** Slugs from `agy models`, effort from `low` to `max`. The adapter pins no model at
  first: each session runs on `agy`'s own default until teamrig's stats can pick a good-value default per role, and
  no role defaults to the dearest slug.
- **Starting fresh.** The window size and the share in use come from `context_window`. A fresh start is a new
  process with a first prompt, and the handover reaches it through SessionStart, which a new conversation fires.
  The host's own compaction cannot be held, so the refresh threshold sits below it.
- **What a wake costs.** How long `agy` keeps its prompt cache is not documented. With no wake, the cost applies to
  a continued turn and to a one-shot run, and is learned from the host's own turns.
- **Memory per tab.** Unknown: measured on the user's host. Whether `agy` ends child processes for memory is not
  documented.
- **Size of the start text.** The instruction files have caps (24 KB a file, 20,000 tokens in all); no limit is
  stated for an injected step or a skill listing. Until one is measured, the start text goes as an injected step and
  falls back to an instruction file only where a proof shows it cut.
- **Errors.** Stop gives `terminationReason` (`model_stop`, `max_steps_exceeded`, `error`; one live log also shows
  `NO_TOOL_CALL` *(third party)*) and an `error` text; a one-shot run's JSON gives a `status` and an `error` text;
  `quota` gives the reset to wait for; the status-line input names `error` and `authenticating` states. The error
  texts themselves are unread, and `max_steps_exceeded` is a kind Claude Code does not have.
- **Host version.** `agy` updates itself unless `AGY_CLI_DISABLE_AUTO_UPDATE` is set, and only its newest build is
  served, so a build that changes a hook's shape cannot be rolled back. The status-line input names the running
  `version`: the adapter records the version its proofs ran on, and the fired-guard check (blocker 1) runs again
  when it changes.

## The blockers

Each is as documented, and is confirmed or cleared by its live proof before code rests on it.

1. **A guard that fails is silent.** Only a hook's printed reply decides: a non-zero exit is logged and the call goes
   on, and what a timeout does is not stated. An empty object refuses the call and no output allows it
   *(third party)*. Fix: on a guard event the handler always exits 0 with an exact reply, and answers `deny` when it
   fails inside; each handler sets its own short timeout; and a `teamrig check` line proves each guard fired on a
   harmless call, refusing team work while one did not.
2. **A resumed conversation gets no session start.** SessionStart fires once per new conversation, so a session
   restored after a reboot, or resumed by hand, starts with no rules, no identity and no handover. Fix: the first
   PreInvocation of a process injects the start text when the session has none for this process, with the
   instruction files as the fallback within their caps. How a handler tells a process's first call is a live proof.
3. **The hooks file cannot load as shipped.** Antigravity's file has named groups, its own six event names and one
   command string per handler; an event name it does not know is accepted and never fires. The input carries no event
   name, and a hook runs from the folder of its hooks file. Fix: a generated Antigravity hooks file whose commands
   carry the event, with the project taken from `workspacePaths`.
4. **Nothing says a guard runs inside a helper.** The docs do not state whether hooks fire for the tool calls a
   subagent makes. If they do not, a helper is a way around every guard. Fix: `invoke_subagent` is refused on
   Antigravity until a live proof shows a guard refusing a helper's call.

## What Antigravity cannot carry

Each is named on an Antigravity host, never silently off:

- The mod: `/teamrig`, bands, toasts, in-tab `/clear` and `/reload-plugins`, the mid-turn refresh ask.
- Waking an open idle session. A session hears its inbox at its next model call or turn end.
- Stopping or hiding a secret typed in a prompt, and redacting a secret in tool output: rotate it.
- Holding a compaction until the handover is written.
- The review of a privileged command typed outside the model's reach, so `teamrig exec` is refused.
- Schedules and the plan carried over a refresh.
- What Claude Code does at a session's end: the close is found by the process, not by an event.
- Auto mode's environment list.

## One team on several hosts

The register, inbox, rules and week plan are files and a CLI, so one team may hold Claude Code, Codex and Antigravity
sessions. Each session spends its own host's budget pool, and pools are never added: a hold on one never stops
another's sessions. Moving a session to another host starts a new conversation, since transcripts do not move
between CLIs.

A wake is the one uneven part. A line sent to an Antigravity session waits until that session next calls its model,
so the sender's "wake now" is not kept there, and teamrig says so when the line is sent. Sessions that answer wakes
belong on a host that can be woken.

## The port, in slices

Each slice is its own pull request, after the host-port slice it stands on. Sizes are estimates of changed non-test
lines: S under 200, M 200 to 600, L over 600.

| # | Slice | Holds | Stands on | Size |
| --- | --- | --- | --- | --- |
| 1 | The live read | an install on Windows and on Linux; a hooks file that records every event's input; the recorded payloads, status-line input and transcript kept as fixtures; this page corrected | nothing | S |
| 2 | The manifest, the hooks file and the bridge | every registry row answered, `partial` at most; the generated hooks file (blocker 3); session start and inbox delivery, on a new and a resumed conversation (blocker 2); a fake Antigravity host whose session start registers the session, which fails on today's code | hook parse and reply | M |
| 3 | Guards, behind a security review | the tool-call mapping, the exact deny reply and the fired-guard check (blocker 1), the helper gate (blocker 4), `teamrig exec` refused, the permission rules writer; a fake host whose guarded call is refused | tool-call shape, permissions | L |
| 4 | Status line and title | the week reading per bucket, the context reading, the tab title and its state, the effort read back; a pool per bucket | transcripts, usage and status line | M |
| 5 | The transcript reader | per-call usage, W, the helper share, restore; an unknown shape refused loudly, never read as 0 | transcripts, usage and status line | M |
| 6 | Sessions | launch, resume, the process finder, one-shot runs, refresh by restart, a continued turn at Stop | identity, launch and processes | M |
| 7 | Install and setup | the Antigravity plugin manifest, the path launcher, team skills, agent types converted, the instruction-file fallback | plugin, paths and context files | M |
| 8 | Docs | the Antigravity column of the parity page, its setup guide | the parity page | S |

Slice 1 comes first whatever the order of the rest: it turns "as documented" into fixtures the other slices test
against.

## Proofs on a live Antigravity host

Before a feature is claimed for Antigravity, a live run on Antigravity CLI 1.5.12 or newer shows it, on Windows and
on Linux. Each runs in a throwaway project whose git remote is a local bare folder, so nothing a guard misses can
reach a real repository or package.

1. Hooks run on native Windows under `cmd /c`; each of the six events' real input is recorded, with the folder it ran
   in and whether any field names the event.
2. A guard refuses a harmless fixture (a `git push` to the bare remote's `main`, a write to a guarded file), and a
   deny wins over another hook's allow on the same call.
3. What each failure does on a guard event: a non-zero exit, a timeout, an empty object, no output.
4. A guard refuses a call made inside a helper, and in a one-shot `-p` run.
5. Which programs fire a hook from each scope (the CLI, the desktop app, the IDE), and how a handler tells them
   apart.
6. SessionStart on a new conversation, after `/clear`, and on each kind of resume; what `invocationNum` is at the
   first model call of a resumed process; an injected step reaches the model whole at the size of teamrig's start
   text.
7. Any route that starts a turn in an open idle session; a one-shot `-p --conversation <id>` beside an open tab on
   the same conversation; what a tab shows and accepts while a Stop hook runs.
8. `TEAMRIG_SESSION` set at launch reaches every hook and every shell the model runs; the conversation id stays the
   same across a resume; which shell `run_command` uses on Windows.
9. With the sandbox on, on each OS: `teamrig` run by the model writes the team's folder, or the grant that lets it.
10. The status-line and title input: the bucket names of the week and the five-hour window on each plan teamrig
    supports, `context_window`, the values of `agent_state`, how often each command runs in an idle tab.
11. The transcript: its file name, its step kinds and token fields under the names the reader parses, and when it is
    written; whether a helper writes its own and its use counts against the parent's quota.
12. The tool names and argument shapes of the installed build, and that `ask_question`, `invoke_subagent` and
    `manage_task` reach a PreToolUse matcher.
13. `auto_approve` against `allow`, and `deny_unless_prior_grant` and `force_ask` under each permission mode.
14. A plugin installed from a local path keeps its hooks on across an update; what `agy plugin import claude` makes
    of teamrig's plugin; which skill wins on a shared name; an agent file's `skills` as a session's listing.
15. What `agy` does with an instruction file past 24 KB, and past 20,000 tokens in all.
16. A first launch on a new account and in a new folder: each question it asks, whether a folder already listed in
    `trustedWorkspaces` is opened unasked, and what a one-shot `-p` run does with no cached sign-in.
17. A one-shot run's `status` for each ending (done, refused action, error, `--print-timeout` reached), with its exit
    code.

## Sources

Official, under `https://antigravity.google/docs/`: `hooks/`, `permissions/`, `settings/`, `rules/`, `skills/`,
`subagents/`, `plugins/`, `build-plugins/`, `sandbox/`, `changelog/`, `plans/`, `install/`, `getting-started/`,
`customization-discovery/`, and under `cli/`: `reference`, `headless/`, `conversations/`, `statusline/`, `title/`,
`modes/`, `acp/`, `troubleshooting/`, `gcli-migration/`, `commands/usage/`, `commands/context/`,
`commands/permissions/`. The installer `https://antigravity.google/cli/install.ps1` and the update manifest it reads
gave the build served on 2026-11-20.

Third party, each reporting a live run:

- `https://symposium.dev/design/agent-details/antigravity-cli.html`, on 1.2.7 and 1.2.14: the resume without a
  session start, the empty-object refusal, the hook's folder, `cmd /c`.
- `https://atamel.dev/posts/2026/07-16_where_agy_hooks/`, an event logger: no event name in the input.
- `https://pkg.go.dev/github.com/entireio/cli/cmd/entire/cli/agent/antigravity`, on 1.0.16 and 1.2.7 on Windows 11:
  the transcript written after Stop, its token fields, the path encoded twice.
- `https://pushary.com/docs/agents/guides/antigravity-cli`: the second set of tool names.
