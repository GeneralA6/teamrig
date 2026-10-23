# Hooks and permissions

The plugin's `hooks/hooks.json` registers twenty Claude Code hooks and one mod ([the /teamrig command](#the-mod-the-teamrig-command), [the refresh's /clear](#the-mod-the-refreshs-clear), [the reload after an install](#the-mod-the-reload-after-an-install), [the wake on urgent work](#the-mod-the-wake-on-urgent-work)). Each runs
`node <plugin>/dist/cli/main.js hook <name>` with a 15 second timeout (`hook refresh-wake` 30, `hook tab-status` and `hook tool-end` 5). Outside a project tied to a team (no `$TEAMRIG_TEAM` and no `.teamrig.json`)
they all stay silent, and only `hook restore-track` and `hook tool-end` still record the session ([the restore tracker](#every-session-the-restore-tracker)).

| Claude Code event | teamrig hook | What it does |
| --- | --- | --- |
| `SessionStart` (startup, resume, `/clear`, compact) | `hook session-start` | Injects the team rules and who you are, and records the session's Claude Code process (`state/sessions/<id>.json`) |
| `SubagentStart` (each helper) | `hook subagent-start` | Gives the helper the team rules and whose helper it is ([A helper's start](#a-helpers-start)) |
| `SessionStart` (`/clear`), in the background | `hook refresh-wake` | Wakes a session that `/clear` started from its context refresh, so it carries on without a prompt |
| `UserPromptSubmit` (each prompt) | `hook inbox-reminder` | Cancels a waiting automatic restart; shows new inbox lines; binds a tab started by hand by its title; records a Claude Code rename; tells the model when its budget holds it |
| `PreToolUse` on `Bash` and `PowerShell` | `hook push-guard` | Asks before a push to a protected branch; refuses a force-push or delete of one, and a git command run without the repository's hooks ([the commit guard](#before-a-shell-command-the-commit-guard)) |
| `PreToolUse` on `Bash` and `PowerShell` | `hook package-guard` | Refuses a package runner that would fetch and run a package outside the project's lockfile, an install of a version the registry does not vouch for, and an `npx --no <bin>` that hands the bin's flag to npm ([the package guard](#before-a-shell-command-the-package-guard)) |
| `PreToolUse` on `Bash`, `PowerShell`, `Read` and `Grep` | `hook secret-guard` | Refuses a call that would print a secret file, a secret variable, the whole environment or a Kubernetes secret's data into the conversation ([the secret guard](#before-a-shell-command-or-a-read-the-secret-guard)) |
| `PreToolUse` on `Bash` and `PowerShell` | `hook exec-guard` | Refuses a privileged command's review run as another session or the owner, and any `exec` call through a client that is no install of the plugin, or one changed after its build ([the exec guard](#before-a-shell-command-the-exec-guard)) |
| `PreToolUse` on `Bash` and `PowerShell` | `hook readonly-allow` | With `readonlyShell.enabled`, lets a line whose every command provably only reads run without a permission prompt ([the read-only allow](#before-a-shell-command-the-read-only-allow)) |
| `PreToolUse` on `AskUserQuestion` | `hook picker-guard` | With `pickerGuard.enabled`, refuses the question picker to every session and helper, and to the lead outside the owner's daily meeting, with the reason to decide it if it is the session's own, else record it on its task and go on ([the picker guard](#before-a-question-the-picker-guard)) |
| `PermissionRequest` | `hook prompt-refuse` | With `prompts.hookAsks: refuse`, answers each permission prompt Claude Code is about to raise but the question picker's and plan mode's exit, per case: a line that provably only reads runs, a line with a rerun form is refused quoting it, anything else is refused with the reason to record the step for the owner and go on ([asks off](#asks-off-a-refusal-instead-of-a-prompt)) |
| `PreToolUse` on `SendMessage` | `hook cold-send` | Holds once a message that would wake an idle session cold; during the daily meeting, holds every message to the lead but a CRITICAL one |
| `PostToolUse` on `SendMessage` | `hook failed-send` | After a send that was not delivered, hands the model [the inbox line to write instead](#after-a-failed-send-the-inbox-line) |
| `PostToolUse` on reads, edits and shell calls | `hook loop-nudge` | Asks the model once to batch when a turn makes [single-step calls in a row](#after-a-tool-call-the-loop-nudge) |
| `PreToolUse` on `Agent` and `Task` | `hook helper-gate` | Restates rule 8's helper default at each helper launch; asks before or refuses one while its budget holds it or in quiet hours, [as the team set](#the-daily-budget-warnings-and-the-helper-gate) |
| The mod, while a tab is idle | `hook wake-check`, `hook wake-dropped` | Wakes the tab's session when unblocked urgent work is handed to it, [batched, with its cost shown](#the-mod-the-wake-on-urgent-work) |
| `Stop` (end of each turn) | `hook stop` | Sends the session back once to [a skill edit it dropped](#end-of-a-turn-or-a-helper-a-dropped-skill-edit), and after a task is set waiting, once to [its other work](#end-of-a-turn-keep-working-while-a-task-waits); asks for a handover when a context refresh is due, then starts the automatic restart; tells the user of another effort than `launch` asks, or of a model Claude Code switched to; shows the budget lines; names a verifying task whose verify-by day has come; once per `github.everyMinutes` for the whole team, starts `gh sync --auto` hidden in the background; every 10 minutes for the whole team, tells the lead of [a tab that runs without its hooks](#end-of-a-turn-hookless-tabs); with tab status on, sets the tab's ready circle, or the decision circle after a turn that asks the user to decide |
| `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure` and `SessionEnd`, in a team or not | `hook restore-track` | Records each Claude Code session on the machine, where it started and what it was doing, for the restore after a reboot ([the restore tracker](#every-session-the-restore-tracker)) |
| Every event but `Stop` and a tool call's end: session start and end, each prompt, `PreToolUse` on `AskUserQuestion` and `ExitPlanMode`, `PermissionRequest`, `Elicitation` and its result, a helper's start, `StopFailure`, `PreCompact`, `PostCompact` | `hook tab-status` | With `tabStatus.enabled`, puts a colored circle before the tab's title for what the session is doing ([tab status](#every-event-tab-status)) |
| Every tool call's end (`PostToolUse`, `PostToolUseFailure`), in a team or not | `hook tool-end` | Sets the tab's circle as `hook tab-status` does, and at most every 5 minutes records in [the restore tracker](#every-session-the-restore-tracker) that the session's hooks still run |

## Session start

The injected context holds:

1. **The core rules**: numbered rules starting `# Team rules (teamrig core)`, with the team's own values in
   them and the config key behind each value in `[brackets]`. A protected-branch list longer than 120 characters
   prints its first items and "and N more"; the push guard still uses the whole list. `teamrig rules --session <id>`
   prints the same text. The lead alone gets its own lines after them, starting `As the lead, also:`: bring the
   owner only verified results, decisions, investigated questions and incidents; enter each owner order it relays
   as a task in the same turn; plan from `plan` and `check`, never from memory; answer each approval wait on it
   with `approve` after the `approvals` skill's checklist; fix a team rule proven wrong, while a loosening goes to
   the owner; clear each HIRE flag by its action. No other session pays for them.
2. **Who you are**. A known session, found from its last `inbox read` or its tab title rather than
   `$TEAMRIG_SESSION`:

   ```text
   You are the `web` session of team `shop` (name `shop-web`). $TEAMRIG_SESSION is not set here, so pass --session web to every `teamrig` task and inbox command. Message the lead as `shop-lead`.
   `teamrig who` prints the name to message any session by; message only those names.
   ```

   An unknown session:

   ```text
   No session is set ($TEAMRIG_SESSION): ask the user which session you are (`teamrig who` lists them) and pass --session <id> to every `teamrig` task and inbox command. Message the lead as `shop-lead`.
   ```
3. **The tree of teams**, when the team has a parent or children: whom to escalate to, and for a lead with
   sub-teams, how to read and hand them tasks.
4. **Notes**: a config with problems or from a newer teamrig; a recorded rename; a tab bound by its title:
   ``This tab was bound to the `web` session from its Claude Code title; nothing was marked read.``, or, after a
   `/clear` in a tab whose title names no session, by the Claude Code process the session refreshed in (for 24 hours):
   ``This tab was bound to the `web` session: /clear kept the Claude Code process that session refreshed in; nothing was marked read.``
5. **The team's own `rules.md`**, when it exists. Where it, a CLAUDE.md, a rules file, a skill, memory or a hook's
   text conflicts with the core rules, the core rules win, except the local rules the team kept (`teamrig rules
   keep`), which the core rules list under `Kept local rules`. `teamrig rules scan` lists the lines to settle.
6. **After a refresh**: `You were refreshed after T2; read your handover first: <path>`, once, at the first
   fresh start (the automatic restart, a `/clear` or a new start) after the handover was written. A compact or resume keeps the old context, so the
   note waits. It then lists what the old session leaves: its scheduled jobs (`CronCreate`; after a `/clear`
   they are still scheduled and the note says so, after a new process it lists them to make again), a pending
   wake-up to make again (`ScheduleWakeup`), its scratchpad and its plan file. After a `/clear`, `hook refresh-wake` then starts a turn by itself that tells the session to read that
   handover and carry on, so it does not sit idle until someone types.
7. **Live tasks**: at that fresh start after a refresh, and at every start after a compaction (Claude Code's
   `/compact` or its automatic one), the session's active tasks as the register holds them at that start, right
   after the handover pointer. A handover and a compaction summary are older than the start that reads them, so
   where they say otherwise, the register wins:

   ```text
   LIVE TASKS of web, read from the register at this start (8 active; where your handover or a compaction summary says otherwise, the register wins):
     T12 in-progress, p1, due 10-17 | Ship the checkout page
     T14 verifying, p2 | Cache the price list
     T15 waiting, p2 | Move the images (waiting: on T12 · decision lead)
     T18 open, p2, due 10-17 (from T21), after T12 | Add the receipt email
     ...
     +2 more: `teamrig list --session web`
   WAITING ON YOU 1 task(s) of other sessions:
     T21 open, p2, owner api, due 10-17, after T18 | Send the receipt from the api · needs your T18
   ```

   Work in hand comes first (in progress, verifying, waiting), then the tasks not started, each in plan order
   (priority, then effective due date); at most 6 rows, the rest one `+N more` line. A row names the due date (the
   earlier one of a task that needs it, as `due 10-17 (from T21)`), the plan dependencies not finished yet
   (`after`) and, for a waiting task, its wait reasons with the ready ones marked. Then `WAITING ON YOU` lists the
   active tasks of other sessions that need one of the session's unfinished tasks or wait on its decision or
   approval: at most 3 rows, the rest one `+N more` line naming `teamrig start --session <id> --all`; with none,
   no block. A session with no active task gets one line, `... none active; ...`, then that block. A register it
   cannot read gives a line naming `teamrig list --session <id>` instead. A resume and any other start keep or begin their context, so they get no
   block; `teamrig start` lists the tasks there.
8. **A model check**: when the session runs on another model than its `launch` entry in the team config, a line
   such as `MODEL shop-web runs model claude-sonnet-5; the team config asks for model opus at xhigh effort: type
   /model opus`. It is also shown to the user, who alone can change it. It never blocks. Claude Code gives a hook
   the effort only at the end of a turn, so the effort is checked there ([model notices](#end-of-a-turn-model-notices)).
9. **The verify queue**: while the session has `verifying` tasks, a `VERIFY 2, oldest first:` heading and a row
   each, `  T1 (proof: the nightly run)`, the first 5 and a `+N more` line. `teamrig verify` lists them in full.
10. **What teamrig lacks**: shown to the user only, once per Claude Code session, when git is not on the PATH or
   Claude Code or Node.js is too old ([the requirements check](requirements.md#the-requirements-check)).

The session is found from `$TEAMRIG_SESSION`, else from the area this Claude Code session last ran
`teamrig inbox read --session <area>` as, else from the tab's Claude Code title (see [Each prompt](#each-prompt)). A
brand-new tab teamrig did not open, with no title naming a session, has none of these, so it is told to ask.

## A helper's start

Claude Code starts a helper (a subagent) with the CLAUDE.md files but without its session's start context, so
`hook subagent-start` gives it the same core rules and your team's `rules.md`, then one line on whose helper it is:

```text
You are a helper (`general-purpose`) of the `web` session of team `shop` (name `shop-web`). The rules above bind you as they bind it, but your brief is your task: leave `teamrig start`, task statuses, register entries, inbox lines and messages to it unless your brief asks for them, and return what it needs. $TEAMRIG_SESSION is not set here, so pass --session web to any `teamrig` command your brief asks for.
```

The session is found the way its own start finds it (a helper's hooks carry its session's id); when none is known
the line says `of a session of team shop`. A helper never gets a session's identity ("You are the `web` session"),
the lead's lines, live tasks, verify list or refresh notes, and the hook changes no file. A compaction inside a
helper fires `SessionStart` under its session's id: teamrig tells it apart by the `agent_id` Claude Code adds to a
helper's hooks and gives it this same context, binding, renaming and refreshing nothing.

## Each prompt

When your inbox has lines this Claude Code session has not been shown, they are added to your prompt, at most 5
lines and 1,500 characters at a time:

```text
INBOX web, new in /home/you/.teamrig/teams/shop/state/inbox/web.md (each line is shown once; reading marks them read):
- 2026-10-15 08:58 lead: api error codes are in docs/errors.md
+2 more at your next prompt, or all now with: teamrig inbox read --session web
```

Read them there: each line is shown once per Claude Code session (recorded in `state/inbox-shown.jsonl`), and being
shown does not mark it read. `teamrig inbox read --session web` then marks them read without printing them again. A
first line over 1,500 characters is cut, and a note names the command that prints it whole.

A tab started by hand, with no `$TEAMRIG_SESSION` and no `inbox read` yet, binds itself when its Claude Code title
(`claude --name` or `/rename`) is a session's id or current name on this team and on no other team of the tree, in
any case (`Web` binds `web`).
The hook then knows it as `inbox read` would, marks nothing read, and says so once:

```text
teamrig: this tab is now the `web` session of team shop (name `shop-web`), from its Claude Code title; nothing was marked read.
```

A tab it cannot bind gets one line per Claude Code session saying how:

```text
teamrig: this tab is not bound to a session of team shop. To bind it, /rename the tab to its session's id or name, or run `teamrig inbox read --session <id>` (ids: lead, api, web).
```

A title that names no session says so in the same line. A title such as `lead` that names a session on two teams
of the tree binds neither, and the line asks for the session's name instead (`teamrig who` lists them).
`$TEAMRIG_SESSION` and an earlier binding always win over the title.

A tab whose session is known (`$TEAMRIG_SESSION`, `inbox read`, a binding) but that has no title gets the session's
current name as its Claude Code title at its next prompt: the hook answers in JSON, with its lines as
`additionalContext` and the name as `sessionTitle`. Claude Code keeps a title across `/clear`, so the session a
`/clear` starts binds itself by it at its start. A tab with a title keeps it: the title is the user's, and a new one
is a rename (below). A title the hook cannot read is left alone.

The same hook notices when the user renamed this Claude Code session (`/rename` or `--name`) and records the new
name, in lowercase, as the session's team name, as `teamrig rename` would; a title equal to the session's id or
current name in any case only binds the tab and renames nothing. If the `.teamrig.json` pointer is broken it says so in one line.

## Before a shell command: the push guard

Before Claude runs a Bash or PowerShell command, the guard reads it and decides:

- **Runs as usual**: no `git push` in it, a `--dry-run`, or a push that updates no protected branch
  (`main` and `master` by default [pushGuard.protectedBranches]; an empty list guards nothing, mirrors included).
- **Asks the human**: a push that updates a protected branch. The reason:
  "This push updates a protected branch (main, master) while other sessions may be working. Confirm, or push your
  own branch and rebase it onto the current one. To stop asking about normal pushes, set pushGuard.pushToProtected
  in the team's config.json to allow, or to lead to have the lead approve them." Commits over the size rule (400 changed non-test lines or 15
  files without a `Large-commit:` line) are listed with it; with `commits.gate: refuse` they turn the ask into a
  refusal. A `--force-with-lease` push is asked with its own reason, which does not name the switch. Under
  `prompts.hookAsks: refuse` each question here is a refusal instead, without the switch hint (see
  [Asks off](#asks-off-a-refusal-instead-of-a-prompt)).
- **Runs with a note**, when `pushGuard.pushToProtected` is `allow`: a normal push to a protected branch, with
  "teamrig did not ask about this push to a protected branch (main, master): pushGuard.pushToProtected is allow."
  and any large commits listed; Claude Code's own permissions still decide. `--force-with-lease` and doubts still
  ask, refusals stay, and `commits.gate: refuse` still refuses large commits.
- **The lead decides**, when `pushGuard.pushToProtected` is `lead` (T684): a normal push to a protected branch runs
  with a note when the lead pushes ("... through: the lead (lead) pushes unasked") or when the lead approved one of
  the session's waiting tasks with `teamrig approve` ("... through: lead approved T1; set its next status once
  pushed, as the approval covers this push only"). Otherwise it is refused, never asked: "This push to a protected
  branch (main, master) needs the lead's approval, not the human's: lead has approved no waiting task of web's.
  Ask on the register: `teamrig set <task> --status waiting --waits approval:lead --note "<branch, what it lands,
  its tests>"`, take your next task, and push once lead approves it (`teamrig approve`)." A tab not bound to a
  team session, or a register the guard cannot read, is refused the same way with that reason. `--force-with-lease`
  and doubts still ask, and refusals and `commits.gate: refuse` stay.
- **Refuses**: a force-push (`--force`, a `+` refspec), a delete or `--mirror` of a protected branch:
  "Force-pushing, mirroring or deleting a protected branch (main, master) is refused: it can overwrite other
  sessions' commits. Push your own branch, or use --force-with-lease if you truly mean it."
- **Asks, in doubt**: when it cannot read part of the line (an unclosed quote, a branch or alias only known when
  the line runs, a push held in quoted text such as `x='$(git push)'`, which bash runs if `${x@P}` or `$((x))`
  reads it again; a bash variable counts as known when the line set it earlier to text and other known variables,
  as in `B=feat; git push -u origin $B` or `G="git -C /w"; $G push`, and never set it otherwise; `$HOME` and a
  value's leading `~` count as your home folder in the line's own shell, as in `T=~/bin/teamrig; $T list`): "The guard
  cannot tell whether this command pushes to a protected branch (...): <why>. Confirm, or write the push out
  plainly." Some doubts, such as an unclosed quote or `bash -c "$CMD"`, ask only when the line names a push in a
  word of its own (`push`, `--push`, `git-push`), never in a path such as `src/push-guard`.

What to do: push your own branch and merge through a pull request, or write the push out plainly so the guard
can read it. Never route around a refusal; report it to the lead. The guard reads chains, subshells, nested shells,
wrappers and git aliases, but it does not see a push inside a script or program the command runs, `gh pr merge`,
git extensions, or pushes run outside Claude Code. It is a guard against mistakes, not a sandbox: protect the
branch on your git host too.

## Before a shell command: the commit guard

A repository's git hooks are its own checks (lint, tests, a commit-size rule), so a commit or push run without them
ships what they would have stopped. The push guard's hook also reads each line for that and refuses:

- `--no-verify`, or an abbreviation git accepts such as `--no-ver`, on `git commit`, `push`, `merge`, `pull`,
  `rebase`, `am` or `send-email`, and `-n` where it means the same: on `git commit` and `git am`, never on
  `git push -n` (a dry run) or `git merge -n`;
- a husky switch on any of those commands: `HUSKY=0` (or a value only known when the line runs) or a non-empty
  `HUSKY_SKIP_HOOKS`;
- a `core.hooksPath` override for the run: `git -c core.hooksPath=...`, `--config-env`, or a
  `GIT_CONFIG_PARAMETERS` or `GIT_CONFIG_KEY_<n>` naming it; a `-c` whose key is only known when the line runs
  counts too;
- a `git config` that sets or unsets `core.hooksPath`, in either form (`git config core.hooksPath /dev/null`,
  `git config --unset core.hooksPath`, `git config set` and `git config unset`).

A switch counts when it is set for git itself, for an `env` or shell that runs git, or earlier in git's own shell;
an `export HUSKY=0` or `$env:HUSKY = '0'` there counts whatever its value. A setting a child shell keeps to itself
does not count, and neither does a word after `--` or an option's value, as in `git commit -m "--no-verify"`. The
reason: "teamrig commit guard: this runs git without the repository's hooks: git commit (--no-verify). The hooks
are the repository's own checks: let them run and fix what they report; if a hook itself is broken, tell the lead.
[commitGuard.skipHooks]"

`commitGuard.skipHooks` sets what such a line gets: `deny` (the default), `ask` the human, or `allow`; a missing or
broken config keeps `deny`, so a config mistake never turns the guard off. It applies whatever
`pushGuard.protectedBranches` lists, and under `ask` a push the push guard refuses stays refused. Like the push
guard, it reads only the line: a hook skipped inside a script the line runs, or a `core.hooksPath` written into a
config file by hand, is not seen.

## Before a shell command: the package guard

A package runner can fetch a package and run it in one step, outside the project's lockfile, so nobody vetted the
version that runs. Before Claude runs a Bash or PowerShell command, the guard reads it as the push guard does
(chains, subshells, nested shells, `cd` and `Set-Location`) and refuses:

- `npx`, `npm exec`, `pnpx`, `bunx` or `bun x` of a tool that is not in `node_modules/.bin` of the folder it runs
  in or of a folder above it (`--prefix` names another); a version (`npx eslint@9`) or `-p`/`--package` always counts;
- `npm create`, `npm init <initializer>`, `pnpm dlx`, `pnpm create`, `yarn dlx`, `yarn create` and `bun create`,
  which always fetch.

`npx --no -- <bin>` (or `--no-install`), `pnpm exec`, `yarn exec` and a package script run only what is installed, so
they run as usual. The reason: "teamrig package guard: `npx eslint` fetches and runs a package outside the
project's lockfile, unvetted. Vet the exact version first (publish date, advisories), add it as a pinned
devDependency, then run its local bin (npx --no -- <bin>). [packageGuard.adHocRunners]"

The `--` matters: npx takes the word after a bare `--no` as that option's value, so it never marks the bin as the
command, and a flag right after the bin goes to npm. `npx --no tsc --version` prints npm's version; `npx --no -- tsc
--version`, `npx --no-install tsc --version` and `npx --no tsc x.ts --noEmit` run tsc. The guard refuses that form
whatever `packageGuard.adHocRunners` says, as it cannot run what it names: "teamrig package guard: `npx --no tsc
--version` runs npm with --version, not tsc (run `npx --no -- tsc --version`). ..."

An install is vetted too. When `npm install` (`i`, `add`), `pnpm add`, `yarn add`, `bun add` or an update form of
them names a package, it must name an exact version (`lodash@4.17.21`) or a dist-tag (`typescript`, `zod@next`), and
the guard asks the npm registry about the version that resolves to: one published less than `packageGuard.cooldownDays`
days ago (14 by default, 0 to 365) or with a known advisory is refused. What it cannot vet is refused as well: a range
(`chalk@^5`), a git, URL or GitHub source, a package only known when the line runs, `--before`, and an update with no
exact version. `npm ci`, an install with no names, and a local folder or tarball install what the lockfile or the
project holds, so they run as usual. The guard asks the public registry (`registry.npmjs.org`) within 10 s, every
request together, inside the hook's 15 s; a registry it cannot ask in time vouches for nothing, so the install is
refused. The reason: "teamrig package guard: this install is not vetted: typescript@5.9.3: published 2 days ago
(2026-10-18), inside the 14-day cooldown. Install an exact version published at least 14 days ago with no known
advisory (`npm view <name> time` lists when each version was published). [packageGuard.installs]"

`packageGuard.adHocRunners` sets what an ad-hoc line gets, and `packageGuard.installs` what an unvetted install gets:
`deny` (the default), `ask` the human, or `allow`. A team on a private registry sets `installs` to `ask` or `allow`, as
the guard asks only the public one. A missing or broken config keeps `deny`, so a config mistake never turns the
guard off. One refusal in a line refuses the whole line, naming every reason. Like the push guard, it reads only the
line Claude runs, not a script or program that line starts.

The guard does not read installs yet: `npm install <pkg>`, `pnpm add` and `yarn add` run unchecked. The plugin's
[security skill](../security/SKILL.md) has the steps for vetting the version an install resolves and for pinning one
with overrides.

## Asks off: a refusal instead of a prompt

A permission prompt holds the session until a human answers it, for hours when nobody is there. With
`prompts.hookAsks` set to `refuse` in the team config, every question a teamrig hook would raise is a refusal
instead: the push guard's (a push to a protected branch, a `--force-with-lease` push, a line it cannot read), the
commit guard's, the package guard's and the secret guard's under their `ask` choice, and the helper gate's. The hook's own reason
comes first, then:
"Asks are off [prompts.hookAsks], so teamrig refuses this instead of asking; do not retry it or route around it.
Record the step as waiting for the owner (`teamrig set <task> --status waiting --waits approval:owner --note "<the
command>"`) and take your next task."

A refusal stays as it was, with no note. `ask` (the default) keeps the questions; a missing or broken config keeps
`ask` too. The same switch reaches the prompts Claude Code raises on its own (a call its permission rules do not
allow, in a mode that asks, or a check of its own that always asks): `hook prompt-refuse` answers each
`PermissionRequest` for its case (since 0.151.0):

- **A line that provably only reads runs**, by the [read-only allow](#before-a-shell-command-the-read-only-allow)'s
  check and its trusted prefixes, even with `readonlyShell.enabled` off; one that would print a secret does not. This
  allow also answers a prompt a settings `ask` rule raised, which a `PreToolUse` allow never overrides: keep a line
  you want asked about out of the read-only rules, or leave asks on.
- **A Bash line teamrig's rules give a rerun form is refused quoting it**: "... Do not retry this line; rerun it as:
  <form>". After a leading `cd D &&`, git runs as `git -C D ...` and anything else as `env -C D ...` (GNU env, or a
  BSD env with `-C`); a plain `git worktree remove P` runs as `teamrig worktree remove P`. Any doubt gives no form: a
  glob, `~`, a variable or substitution, a subshell, a heredoc, a relative redirection once the folder moves, a
  builtin after the `cd`, a trailing `&`.
- **Anything else is refused** with "Claude Code would ask a person to allow this <tool> call." and then the note
  above.

Each answer is a line in `state/prompt-answers.jsonl` (the time, both sessions, the tool, the answer and the first
200 characters of the command), for the triage that turns a refused line into a fixed guard or a new rerun form. The
question picker and plan mode's exit still open: the [picker guard](#before-a-question-the-picker-guard) and the
person decide those.

## Before a shell command or a read: the secret guard

A secret printed into the session stays in its transcript and in every prompt after it. Before Claude runs a Bash,
PowerShell, Read or Grep call, `hook secret-guard` reads it (a shell line as the push guard does: chains, subshells,
nested shells, `cd`, pipes and substitutions) and refuses a call that would print:

- **a secret file's content**: a printer (`cat`, `head`, `grep`, `sed`, `jq`, `base64`, `Get-Content`,
  `Select-String`...) or `git show`, `diff` or `blame` naming one (the script or pattern a `sed`, `grep`, `awk` or
  `jq` takes first is not a file, so `grep -n .env README.md` passes), a `<` feeding one, inline code that prints one
  (`python -c "print(open('.env').read())"`), the Read tool on one, or a Grep that shows content (`output_mode:
  content`) of one by its path or glob (each glob of the input apart, as ripgrep gets them; a `!glob` skips files,
  so it names none). The defaults: `**/.env`, `**/.env.*`, `~/.npmrc`, `~/.ssh/**`,
  `~/.aws/credentials`, `~/.kube/config`, `~/.docker/config.json`, `~/.git-credentials`, `~/.config/gh/hosts.yml`,
  `**/*.pem` and `**/*.key`; `.env.example`, `.env.sample` and `~/.ssh/*.pub` stay readable. A word with
  wildcards counts when a secret name fits them (`cat .env*`).
- **the whole environment**: `env`, `printenv`, `export -p`, `declare -x`, cmd's `set`, `Get-ChildItem Env:`,
  `[Environment]::GetEnvironmentVariables()`, `/proc/<pid>/environ`, and inline code that prints `process.env` or
  `os.environ`.
- **a secret variable's value**: `echo $GITHUB_TOKEN`, `printenv NPM_TOKEN`, a bare `$env:GH_TOKEN`,
  `[Environment]::GetEnvironmentVariable("X")`, and inline code (`node -e`, `python -c`, `ruby -e`, `perl -e`,
  `php -r`) that prints one. A name is secret when a default pattern matches it (case ignored): `TOKEN`, `SECRET`,
  `PASSW`, `PASS`, `CRED`, `AUTH` (not `AUTHOR`), `PRIVATE`, `KEY`, `DSN`, `WEBHOOK`, `COOKIE`, `PAT`, `SALT`,
  and a store's connection URL or string by its kind (`DB_URL`, `DATABASE_URL`, `PG_URI`, `CACHE_URL`,
  `BROKER_URL`, `CONNECTION_STRING`).
- **a Kubernetes secret's data**: `kubectl get secret` with `-o yaml`, `json`, `jsonpath` or a template,
  `kubectl edit secret`, `kubectl view-secret`, and `kubectl create secret ... -o yaml`.

The line a container or a host runs is read as a line of its own, four levels deep: `kubectl exec ... --`,
`docker exec`, `docker compose exec`, `ssh host '...'`. Output that never reaches the screen passes: a redirect into
a file, a pipe into a program that passes it on unprinted (`wc`, `sha256sum`, `Set-Clipboard`, `ssh-add`,
`docker login --password-stdin`, `gh secret set`...), a quiet search (`grep -q`, `-c`, `-l`), an in-place edit, a
PowerShell assignment or condition, and a substitution whose command prints nothing of it (`curl -H "Authorization:
Bearer $(cat ~/.token)"`). The reason: "teamrig secret guard: this call would print the content of .env into the conversation. Hand a secret to the tool that needs it (stdin, an env file option, a pipe), check it without printing it (grep -q, wc -c, a hash), or ask the owner to look in their own terminal. A false match: add its !glob to secretGuard.paths or its !pattern to secretGuard.envNames. [secretGuard.secretReads]"

`secretGuard.secretReads` sets what such a call gets: `deny` (the default), `ask` the human, or `allow`. A missing
or broken config keeps `deny`. `secretGuard.paths` adds the team's own files: globs where `~/` starts at home, one
with no leading `/` or drive matches at any depth, and the last glob that matches decides, so `!glob` keeps a file
readable. `secretGuard.envNames` adds the team's own name patterns, and `!pattern` keeps a variable printable. The
defaults name a store's URL by its kind, never by its product: a team adds its own stack's names
(`ACME\w*_URL`). The read-only allow never lets a line that prints a secret run without a prompt, whatever
`secretReads` says. The guard reads only the call, so it cannot see:

- a value kept in a variable and printed later (`t=$(cat .env); echo "$t"`), or a path built when the line runs
  (`cat $(ls .env*)`, `Get-Content (Join-Path ~ .npmrc)`);
- a secret file inside a folder a search walks (`grep -r x .`, a Grep over a folder with no glob or only
  `!globs`), or one a Grep glob picks through `{a,b}` alternatives (`*.{ts,pem}`);
- a script or program the line starts (`node print-env.js`), `docker inspect`, or `docker run -e`.

## Before a shell command: the exec guard

A [privileged command](commands.md#privileged-commands) runs only after a reviewer approves it, and the CLI takes
the reviewer from `--session` as given, while one allow rule lets every `teamrig` command run unasked. Before Claude
runs a Bash or PowerShell call, `hook exec-guard` reads it (a shell line as the push guard does) and finds each
`exec` command, run as `teamrig` or as `node <plugin>/dist/cli/main.js`. It refuses:

- **a review as another**: `exec approve`, `refuse` or `escalate` that names no `--session`, names it twice, names
  a session the team does not have, or one that is not the tab's own. `--session` wins over `$TEAMRIG_SESSION` in
  the CLI, so a variable set on the line changes nothing, and a tab bound to no session of the team reviews nothing.
- **a review as the owner** (`register.ownerSource`): the owner reviews in their own terminal, or types
  `/teamrig exec approve R<n> --session owner` in a tab, which [the mod](#the-mod-the-teamrig-command) runs with no
  tool call.
- **a word known only when the line runs**: a variable or a substitution as the command word of a `teamrig` call,
  or anywhere in a review, since the guard cannot tell what it runs, or as whom.
- **a client that is no install of the plugin**: an `exec` command must start `bin/teamrig`, `bin/teamrig.cmd` or
  `dist/cli/main.js` of the hook's own install, or of another version beside it in the plugin cache (a tab keeps on
  PATH the version it started with). The guard places the file as the line's shell would: a path the line writes
  (Git Bash's `/c/x` too, and a relative one from the folder the line has moved to), else the first `teamrig` the
  shell's PATH search finds (Bash: `~/bin` first; cmd: its folder first; PowerShell: `.ps1` and the `PATHEXT`
  names). A bare `teamrig` it finds nowhere is the plugin bin the Bash tool appends to PATH last. The reason names
  the file and the plugin's own client; a `teamrig` found on PATH is to be taken off it.
- **a program known only when it runs**: `$T exec approve ...`, `node "$SCRIPT" exec run ...` or a relative client
  path from a folder only known when the line runs, whenever the words after it are an `exec` command, as no
  file can be checked; write the program out. `$DOCKER exec ctr ls` is not one.
- **a changed client**: any `exec` command while the files (`bin`, `dist`, `hooks`) of the install it starts
  differ from the SHA-256 list its build wrote (`dist/integrity.json`), or that list is missing, since an approved
  command runs inside that client. Each install a line starts is checked once; the reason names up to five changed
  files, and the install when it is not the hook's own; reinstall the plugin.

It always refuses and never asks; no config key turns it off. The guard reads only the call, so it cannot see:

- an older version left intact in the plugin cache: a line may start it, and it runs as that version was built;
- the PATH a tab really has: it searches the hook's own, with `~/bin` before it for Bash, not the other folders Git
  Bash puts first (`/mingw64/bin`, `/usr/bin`, inside the Git install), and takes a bare `teamrig` it finds
  nowhere as the plugin bin;
- code node runs before the client: a preload option (`-r`, `--import`) or `NODE_OPTIONS`;
- a change made to the list too: the list sits beside the code, so the check stops a slip that edits the installed
  files, not a session set on rewriting both.

## Before a shell command: the read-only allow

Claude Code asks before a shell line its settings do not allow, reads included, and a settings rule matches only a
command's start: `Bash(grep:*)` cannot tell `grep x f` from `grep x f > out.txt`. With `readonlyShell.enabled: true`
in the team config, `hook readonly-allow` reads the whole line, as Bash or as PowerShell by the tool that runs it,
and lets it run without a prompt when every command in it, substitutions and loops included, provably only reads:

- **Bash**: `cat`, `head`, `tail`, `grep`, `wc`, `cut`, `tr`, `nl`, `ls`, `echo`, `cd`, `pwd` and `sleep` with any
  arguments; `sed` printing lines (`sed -n 5,20p`), `awk` printing fields (`{print $1}`), `sort` with no output
  file, `test` and `[`; `git` with a reading subcommand (`status`, `log`, `diff`, `show`, `blame`, `grep`,
  `ls-files`, `rev-parse`...) and no `-c`, `--output` or `--ext-diff`; `kubectl get`, `describe`, `logs`, `top` and
  the like, with no `--raw`, `--kubeconfig` or `--server` and no secret named; an unquoted index such as
  `custom-columns=IMG:.spec.containers[0].image` or `{.items[*].name}` reads, since such a glob can only match the
  one file named by its text with the brackets dropped, and kubectl gets one of those two. Pipes, `&&`, `||`, `;`, `for` loops
  and `$(...)` join them. A redirection may only read a file, copy or close a descriptor (`2>&1`) or throw output
  away to `/dev/null`. A line may set its own variables, but no name Claude Code's environment or its newest shell
  snapshot exports (a program reads an exported one: `npm_config_prefix`), none bash or a listed program reads
  (`PATH`, `IFS`, `TMPDIR`, `GIT_*`, `KUBE*`, `LESS*`, `NODE_*`, `PAGER`, `EDITOR`...), and none at all under the
  snapshot's `set -a`; a line that exports (`export`, `declare -x`, `set -a`) is refused. A variable the line sets
  once to plain text, unconditionally and outside any block or pipeline, reads as that text in the commands after
  it, so `pod=x; kubectl logs -n app $pod` is checked as `kubectl logs -n app x`.
- **PowerShell**: reading cmdlets by their full names (`Get-Content`, `Get-ChildItem`, `Select-String`,
  `Select-Object`, `Where-Object`, `ForEach-Object`, `ConvertFrom-Json`, `Format-Table`...), `Set-Location`, `git`
  and `kubectl` as in Bash, script blocks written in the line (each checked like it), the line's own variables (not
  `$PSDefaultParameterValues` or a preference), and string, date and list methods that return a new value. No
  alias (a profile can redefine one), cast, `-as`, call operator, static member but the clock (`[DateTime]::Now`),
  `-OutVariable`, splat, or redirection but to `$null`.
- **Trusted prefixes**: `readonlyShell.allowPrefixes` lists commands the team trusts with any arguments, each by
  its leading words (`npx tsc --noEmit`; at most 16). A prefix vouches for every argument after it, so leave out a
  tool one of whose flags writes: `eslint --fix`, `jest -u` (rewrites snapshots), `jest --outputFile`.

It only ever allows: a line it cannot prove reads prints nothing, and Claude Code's own permission check decides,
as without the hook; so it does outside a team, with a missing or broken config, or on any error. Claude Code ranks
one hook's `deny` over another's `ask` over an `allow`, and its settings' deny and ask rules still apply under an
allow, so the push guard's question and the package and secret guards' refusals always win. It never allows a line
that prints a secret ([the secret guard](#before-a-shell-command-or-a-read-the-secret-guard)), even when
`secretGuard.secretReads` is `allow`. The hook reads the session's team
(`$TEAMRIG_TEAM`, else the project's), never the team of a folder the line moves into. Like the guards, it reads only
the line, so it cannot see:

- git obeying the repository's own config, which can name a program to run (`core.fsmonitor`, `diff.external`): it
  trusts the repository as git does;
- a variable only the shell's profile exports (or `set -a` does), or a profile function or alias that shadows a
  program's name;
- what a trusted prefix's arguments make its tool do.

## Before a question: the picker guard

Claude Code's question picker (`AskUserQuestion`) stops the session until the person answers, and the owner may be
away for hours, so a session that asks the owner one task's decision moves none of its other tasks meanwhile. With
`pickerGuard.enabled: true` in the team config, `hook picker-guard` refuses the picker in every session and helper of
the team, and its reason says what to do instead:

1. decide it when it is the session's own to decide, and note it on its task;
2. else record it on its task: `teamrig set <id> --status waiting --waits decision:owner` with a note and its
   decision card (`--question`, `--options`, `--recommend`, `--default`); the lead brings it to the owner;
3. go straight on with the next task that does not need the answer;
4. only when no task is left, end the turn with the question in plain text and a `Decision needed:` line (the
   decision circle with tab status on).

The lead's own thread keeps the picker only while the owner's daily meeting is open (from `teamrig meeting start` to
its end or lapse): the owner is there then, and the meeting asks through it. Outside it the lead is refused too, and
its card goes on the next meeting's agenda. A helper is refused always, the lead's too, since its picker stops the
session that started it: its reason says to decide it within its brief, else to end its report with the decision,
for that session to record. `ExitPlanMode` stays allowed: plan mode starts only when the person chose it in that tab,
and the tool is its only way out. A tab that is no session of the team (no `$TEAMRIG_SESSION` and no inbox read)
keeps the picker too. With tab status on, a
refused picker leaves the tab's circle as it was, since no question waits. The refusal is the hook's PreToolUse
`deny`, not a permission rule; outside a team, with the guard off or on any error the hook prints nothing, so the
picker opens.

## After a tool call: the loop nudge

Every call re-reads the session's whole context, so six reads in six calls cost about five context re-reads more
than six reads in one message. After each `Read`, `Grep`, `Glob`, `Bash`, `PowerShell`, `Edit`, `Write`,
`MultiEdit` or `NotebookEdit` call, the hook counts the calls in a row since your last prompt that each ran one read,
lookup, edit, test, build, git or teamrig step. A call with several tools, or one tool of another kind (a helper, a
message, a script), ends the run. When the run reaches `loops.chainNudgeAt` (6 by default; 0 turns it off), the
model gets one line after the tool's result:

```text
teamrig: 6 single-step calls in a row this turn (about 65k W of re-reads at this context); put independent reads in one message, and an edit with its re-test.
```

When an edit and then its test ran in separate calls, the line says so. It comes once per run: the next call
counts 7 and stays quiet. Calls inside a helper are not counted; only the main thread's are. `teamrig budget
--loops` counts the same patterns over the day.

## After a failed send: the inbox line

A send to a name no live session answers to (a remembered pipe, an old name, a session that has exited) does not
fail the tool: it returns `success: false`, and the message is lost unless the sender writes it down. After such a
`SendMessage` result, the model gets one line:

```text
teamrig: the message to team-lead was not sent (No agent named 'team-lead' is reachable.); leave it as an inbox line, shown at lead's next prompt: `teamrig inbox add --to lead --text "..."`.
```

For a name that is no team session, the line points to `teamrig who`, which prints the names to message by.
Outside a team with a config it says nothing.

## End of a turn or a helper: a dropped skill edit

Skills are plain files every session edits (a trap it hit, a date it verified), outside any branch or review. When
two edit one skill at once, Claude Code refuses the later edit: the file changed since it was read, or the text the
edit anchors on is gone. The refusal is right; the change is lost only when the agent then ends as if it landed. So
at the end of a turn (`hook stop`) and when a helper is about to hand back (`hook subagent-stop`), teamrig reads the
turn, or the helper's whole run, and when an `Edit`, `MultiEdit` or `Write` of a file under `.claude/skills/<name>/`
was refused and not redone later, it sends the agent back once:

```text
teamrig: a skill edit was refused and never redone, so the file lacks it: web-deploy (/home/you/.claude/skills/web-deploy/SKILL.md: String to replace not found in file.). Another session may have changed the file since you read it: read it again and redo the change on its current text, or say why you dropped it.
```

It asks once per stop (never on a stop it already sent back), and the rest of that turn's end waits for the next
stop. A shell edit (`sed`) is not read. Outside a team it says nothing. `check` flags the line that made such
collisions common: a `Last verified:` line with a note after its date (`VERIFIED-NOTE`), which every run rewrote at
its end; with the date alone, two runs agree, and a lesson goes on its own line.

## End of a turn: keep working while a task waits

A task that waits on a decision, an approval, a peer's task or a time should not idle its session while other work
is there. So `teamrig set` to `waiting` (with `--ask` too) records a one-time ask for the task's owner, and at that
session's next turn end `hook stop` takes it: while the task still waits and the session owns a task it can start,
it sends the session back once:

```text
T1 waits (decision owner), and you own work that does not come after it: T2 "Fix the login" (p1). Work it now in priority order (`teamrig list --session web`); leave a task that is the same change as T1, and say so in one line. If you already work one and wait on a background step, end the turn again.
```

A task it can start is its own task it can go on with, other than the waiting one, most urgent first: open or
in-progress, or waiting or verifying with every wait cleared, and, when never started, past every `after` task. A
task not started that comes after the waiting one, directly or through another unfinished task, stays untouched,
and so do its closed tasks and those still waiting or verifying on a reason not cleared. It asks at one stop only, never on a stop already sent back or while a context
refresh is under way (the ask then waits for a later stop), and never in the budget's quiet hours or while its
budget holds it (the day-start wake brings it back to its work). With nothing it can start, the turn ends as
it would, and a turn that asks the user to decide shows [the decision circle](#every-event-tab-status). A hired
session asked to retire itself is asked that first.

## After a tool call: the lead boundary

The lead decides, briefs and reads results; the owning session, a helper or a temporary session does the work. On
the lead's tab (`roles.lead`), the same hook counts the turn's calls that are work to hand off:

- an edit outside its own files, or a git step that changes a repository (`commit`, `push`, `merge`, `rebase` and
  the like);
- a test run or a build;
- research: a `WebFetch` or `WebSearch`, or a search (a `Grep` or `Glob`, a shell `grep`, `rg` or `find`) of another
  session's place in the team's teamrig folder (`notes/<session>`, `handover/<session>.md`) or of a shared folder
  there, such as all the notes;
- a code search: a `Read` of a source file, a `Grep` or `Glob`, a shell `grep`, `rg` or `find`.

Its own files are the team's teamrig folder, Claude Code's memory folders and session scratchpads, and
`leadBoundary.ownPaths` (`~` is your home, `*` one folder name), so its board, notes, agenda and scratch files never
count, nor does reading results, boards and docs. In the teamrig folder only a search of the config, the rules, the
register's state or a place named for the lead is the lead's own; another search there looks for an answer another
session owns.
At the turn's first edit, its first test or build, its first research and its `leadBoundary.searchNudgeAt`-th code
search (3 by default; 0 never), the lead's model gets one line:

```text
teamrig: the lead edited hook.ts itself. The lead hands such work to the owning session (a register task), a helper or a temporary session, and keeps to deciding and briefing [leadBoundary].
```

The research line names whom to ask: the session whose place the search looked through, else the owners of the
tasks the turn's prompt names (`T123`, read from the register), else the session that owns the question:

```text
teamrig: the lead did research itself (vendor.example). Send the question to symbols as a register task with a deadline and relay its answer [leadBoundary].
```

At the turn's end you see what the lead did itself:

```text
Lead boundary: this turn the lead did 2 edits (CLAUDE.md, hook.ts), 1 test or build, 3 research lookups (vendor.example, a web search, notes) itself; it delegates such work [leadBoundary].
```

It never blocks. `leadBoundary.enabled: false` turns both off. A helper's calls are not counted: handing work to one
is the point.

## End of a turn: context refresh

At the end of every turn, the Stop hook measures your context from the transcript. At or over
`refresh.contextTokens` (120,000 by default), at a task end after every `refresh.everyTasks` finished tasks (3) with the context at
`refresh.everyTasksMinTokens` (80,000) or more, or when the lead asked with `teamrig refresh <id>`, it keeps you going with one instruction: write your handover to
`<home>/teams/<team>/handover/<id>.md` with what the register lacks, not task statuses (the fresh start
[lists them live](#session-start)), then run `teamrig refresh --ready --session <id>`, and start nothing new (mid-task it says
`refresh now rather than at a task end`).
After `--ready`, the next turn's end tells the user `teamrig: shop-web finished T2 and wrote its handover; type
/clear for a fresh start` and sets the tab title to `shop-web: type /clear`: the user clears once done with the
screen, which a `/clear` wipes. With `refresh.autoRestart: true` it says `teamrig starts it fresh once it has been
idle 15 s (type anything to keep this context)` instead, the title reads `shop-web: restarting`, and a hidden
`teamrig restart` then waits until the tab has been idle
`refresh.restartDelaySeconds` (15) with nothing running and its last turn ended, and the plugin's mod runs `/clear` in
this tab. Where no mod claims it within 10 s, the restart ends this Claude Code and starts it again: in the same tab
when `teamrig open` started it, else in a new tab. It never does that while this Claude Code runs a background shell
(a background command or a monitor), which the end would take too: your inbox then says to type `/clear`, which
keeps it. teamrig's own wake for work handed meanwhile waits for it, and wakes the fresh session. A prompt the user sends first cancels it, and you keep this
context until your next task end asks again, or your context grew a fifth of `refresh.contextTokens` more; text typed but not sent holds the mod's `/clear` ([below](#the-mod-the-refreshs-clear)), and is lost only where the restart ends this Claude Code. When the restart cannot start, the message
and the title are the `/clear` ones above. On Windows an ended Claude Code runs no SessionEnd hooks: `refresh.endCommand` names a
program run in their place, given their input. While background work you started (subagents, background
commands, monitors, workflows) has not reported back, all of this waits for a later turn end, so a fresh start
never cuts it off. The hooks read that from the transcript (helpers started within the last 6 hours); the mod below
also asks Claude Code before its `/clear`, and holds while a helper of this session still runs. While the owner's
daily meeting is open (`teamrig meeting start` to `meeting end`, or its lapse 4 hours on), the lead is neither asked
nor told its handover is written, so no restart cuts the meeting off; the end of the turn that ends the meeting asks
at once. Past `refresh.compactCeilingTokens` the refresh goes on even then, so the lead never runs out of room. A `/clear`, a new process or a compaction starts the task count over. Each finished task is judged once, so
it never loops. Steps: [workflows.md](workflows.md#handover-at-high-context). `refresh.enabled: false` turns it
off. A turn that runs past `refresh.contextTokens` is asked within the turn by the plugin's mod
([below](#the-mod-the-refresh-within-a-turn)), since Claude Code would compact it before this hook ever asks.

## The mod: the refresh within a turn

The Stop hook asks only at a turn's end, so a session busy in one long turn would reach Claude Code's own
compaction first. In each interactive tab the mod reads, after each tool result of the main conversation, the
context the last reply read. Once it reached the size the CLI named, it runs `teamrig hook refresh-mid`, which asks
as the Stop hook does, but within the turn: `teamrig: your context is 132k (refresh at 120k), so refresh within this
turn: finish the step you are on and start no other. Write your handover to ... and end your turn: the fresh start
follows it.` The mod adds the ask to the tool result's context, which you read and the user does not see. Only the
size asks within a turn: the lead's request and the task count wait for a turn's end. Background work still running
holds the ask, as at a turn's end, and so does the owner's open daily meeting, for the lead. A turn that ends with no handover marked ready after a mid-turn ask is asked once
more by the Stop hook.

Before Claude Code compacts the main conversation on its own (its automatic compaction, or the summary it computes
ahead), the mod runs `teamrig hook compact-check` with Claude Code's estimate of the context. While your handover
is asked for or written and the estimate is under `refresh.compactCeilingTokens` (185,000 by default: past the
167k where Claude Code compacts a 200k window, 15k under the window; 0 turns it off), the mod skips the compaction,
since the fresh start replaces it. At or past the ceiling, or when the CLI cannot answer, the compaction goes, so a
session never runs out of room. The user's `/compact`, a plugin's and a helper's compaction are left alone.

## The mod: the refresh's /clear

A hook cannot run `/clear`; a plugin mod (`hooks/register.ts`, named under `modules` in `hooks.json`) can, through
Claude Code's own command API. In each interactive tab it asks `teamrig hook clear-dir` once for the ask folder,
then looks each second for an ask for its tab's Claude Code session. It tracks turns, and leaves an ask that comes
while one runs: the restart takes that one back and asks again once the session is quiet. Otherwise it asks Claude Code
for the session's agents (`$.agent.list()`). While one is live (not completed, failed or killed; an idle teammate
counts), or Claude Code will not list them, it runs `teamrig hook clear-claim --hold --why <reason>` and no
`/clear`: the restart ends nothing, waits for quiet and asks again, and gives up an hour after it started, naming
the last hold's reason in its log row and your inbox line (`it stayed busy for 60 minutes (its tab last held the
/clear: 1 agent of this session still live: code-reader idle "Map the market-data pages")`: each live agent's type,
status and task, so one Claude Code still lists after it handed its report back shows which it is). Else it runs
`teamrig hook clear-claim` and, on `taken`, runs `/clear` the way you would. The `/clear` then runs the
`SessionStart` hooks above, so `hook refresh-wake` starts your first turn at your handover. A Claude Code that does
not load mods leaves the ask unclaimed, and the restart ends and restarts the session instead.

Before it claims, the mod holds the `/clear` for the person at the tab, with `--hold` and its reason, so the restart asks again
`refresh.restartDelaySeconds` later. It holds while the prompt box holds a draft, or Claude Code will not read it.
It holds for `refresh.holdAfterActivityMinutes` (5) after the person's last key in the prompt box or prompt, typed or
sent through Remote Control; a background task's prompt does not count. It holds for 10 minutes after they press
Hold. Then a band above the prompt counts `refresh.countdownSeconds` (20) down: `teamrig: this session refreshes in
20 s, a fresh start from its handover`, with `1: Refresh now` and `2: Hold 10 min`, which a bare digit in an empty
prompt box presses. The `/clear` comes with the restart's first ask after the count. Refresh now has the next ask
claimed, unless a draft or a live helper holds it. A turn, a key or Hold hides the band, and a survey Claude Code
shows takes its place; the terminal and the desktop app draw it. With both set to 0, only a draft holds the
`/clear`.

## The mod: the reload after an install

`claude plugin update` installs a new version, but an open tab runs the one it loaded until `/reload-plugins`. In
each interactive tab the mod reads Claude Code's `installed_plugins.json` (in the `plugins` folder that holds the
cache it runs from) when it loads and every 15 s after. Once an install that applies to the tab changed (a user-scope
one, or a project- or local-scope one for the tab's project: added, removed, or another folder, version or commit),
the file has read the same for 10 s, no turn runs (a subagent's included) and nothing in the plugin store changed
for 10 s, it runs `/reload-plugins` the way you would. The store is the plugin list, `known_marketplaces.json`, and
each install's plugin folder and folders: `claude plugin update` copies a version in over about 1.4 s and names it in
the list before the copy ends, and a reload during the copy loads only part of the plugin (T561: a tab ran without
teamrig's hooks for 15 h). A hold for it goes to Claude Code's debug log as `installing`. It runs at most one per 5
minutes and never two for the same installs, and keeps the last one in the session's state (`teamrig.reload`, typed
in `types/index.d.ts`), so the mod the reload loads keeps both. A refused
reload goes to Claude Code's debug log and is tried again 5 minutes later. A plugin loaded from a folder
(`--plugin-dir`) has no `installed_plugins.json` beside its cache and gets no reload; a Claude Code that does not
load mods leaves `/reload-plugins` to you.

## The mod: the wake on urgent work

An idle session sees new work only at its next prompt. In each interactive tab, every 15 s while no turn runs (a
subagent's included), the mod runs [`teamrig hook wake-check`](commands.md#teamrig-hook-wake-check) once the task
log changed, a batch fell due or 10 minutes passed. It wakes the tab's session for a task it owns that another
session handed to it, raised, reopened or freed, whose waited-for time came, or whose approval its giver answered
(its own changes are not news), that it can go on with: open or in-progress, or waiting (a verifying task's proof
waits) with every wait cleared or answered, and, when never started, with every task it comes `--after` finished; at
`wake.priority` or more urgent (p1 by default). The wake names a cleared task as `(p2, waiting: every wait cleared)`,
and an answered one as `(p2, waiting: lead approved it)` or `declined it` (back to work on the answer's note), so the
session sets its next status. Held by its budget (past
its daily budget while the team has no room today), or in the budget's quiet hours unless its lift exempts it, only
p1 wakes it. While the owner's daily meeting is open
the lead is not woken; the work waits for the first check after it.

Tasks handed within `wake.batchSeconds` (120) of the first wake it once, each task wakes it once, and wakes of one
session are `wake.minGapMinutes` (15) apart. Work there when the tab started or before a `/clear` is seen at its
first prompt. The mod sends the prompt through Claude Code's own call for one (`$.prompt.submit`), as the teamrig
plugin, so the session takes a turn of its own: nothing is typed into the terminal, and the prompt box and any draft
in it are left alone. The prompt and a toast name the tasks and the cost: about 27k W while the cache is warm, about
210k W once idle `messages.coldAfterMinutes` (60) or more, with its share of the week. Each wake is a line in
`state/wakes.jsonl`; a wake a prompt hook refused is logged there with its reason
([`hook wake-dropped`](commands.md#teamrig-hook-wake-dropped)). `wake.enabled: false` turns it off. A session open
in two tabs at once is not woken (each tab's first check starts the count over), nor is a Claude Code that does not
load mods.

The day start: work already on an idle session's list wakes nothing, so a session idle since the night stays idle.
With `wake.dayStartUtc` set (`HH:MM` UTC, outside the budget's quiet hours; unset by default), each session with
work it can start, of any priority, and no turn since that time gets one wake that day, and a burst wakes each of
its sessions once when the lead starts it. A session that had a turn since is left alone; quiet hours, a hold by
its budget or nothing it can start delay the wake until they end. The prompt names the moment, the work and the
cost; the wake log marks it with `moments`.

## The mod: the /teamrig command

In every session, a headless `claude -p` included, the mod adds `/teamrig <command> [args]`: it runs
[`teamrig hook slash-command`](commands.md#teamrig-hook-slash-command) with the text you typed, the tab's session
and where the line came from, and shows what the command printed as its output (at most 250 lines, then how many
were left out), with no model turn, so it costs no tokens. A read runs at once. A command that changes the team's
files runs only when you type it at the prompt or through Remote Control, never when another session, a channel
or `claude -p` sends it (REFUSED). Typed without `--session`, it shows the line with the tab's session and asks
first (`Run it` or `Cancel`), since the tab's session can come from an inbox read you meant only as a look. A
command is stopped after 180 s; `claude -p "/teamrig <command>"` ends with the command's exit code. `/teamrig`
alone prints the short help and these rules.

## End of a turn: model notices

The Stop hook also tells the user, in a MODEL line shown once per Claude Code session (a `/clear` starts over):

- when the session runs at another effort than its `launch` entry asks: `MODEL shop-web runs at high effort; the
  team config asks for model opus at xhigh effort: type /effort xhigh`;
- when Claude Code switched the session to another model after its safeguards stopped a reply, a switch it keeps
  for the rest of the session: `MODEL shop-web now runs model claude-opus-4-8, not claude-fable-5-1: Claude Code
  switched after its safeguards stopped a reply (cyber) and keeps it for this session; type /model claude-fable-5-1
  to switch back` (the `/model` names the `launch` model when there is one). This line comes for any session,
  with a `launch` entry or not, and not once the user has switched back.

The lines go to the user only, so they cost the session no context, and they come with `refresh.enabled` on or
off. Which lines a session was shown is kept in `state/model-notices/<id>.json`.

## End of a turn: verify-by notices

The Stop hook also tells the user of each of the session's `verifying` tasks whose verify-by day (its due date, a day
on the team's clock) has come: `VERIFY T1 was to be verified by 10-14 (proof: the nightly run): done with the proof, or back to
in-progress`. It reads the task list only at the session's first stop of each UTC day, so a task is named once a
day until it is `done` or back `in-progress`, and a date moved to today after that stop waits for the next day.
A failed read leaves the line out. Which tasks were named today is kept in `state/verify-notices.jsonl`, which
holds only the current day.

## End of a turn: hookless tabs

A tab that runs without teamrig's hooks, as one that never reloaded after a plugin update, gets no inbox, no
guards and no tab status, and nothing in it says so. Every 10 minutes for the whole team, the Stop hook of any
team session reads the team's [restore files](#every-session-the-restore-tracker) whose hooks last wrote over 30
minutes ago and checks their transcripts: one that changed in the last 30 minutes, and over 30 minutes after that
last write, is a tab working without its hooks. Each such tab gets one inbox line from teamrig to the lead, or to
the coordinator's owner (`roles.coordinatorOwner`) when it is the lead's own tab: `HOOKLESS alpha: its tab (Claude
session 0123abcd) worked 59 min past its last teamrig hook (hook 09:00 IDT, transcript 09:59 IDT), so it gets no
inbox, guards or tab status: type /reload-plugins in that tab`. A tab is named again only after it had its hooks
back. A tab on a teamrig older than `hook tool-end` reads the same way during a turn of over 30 minutes, and the
same reload fixes it. The check cannot see a tab that had no teamrig hook since it started (it has no restore
file), nor any tab while no tab of the team runs its hooks. `state/hookless.json` keeps the last check's time and
the tabs it named; a hook that finds the check running skips it.

## The daily budget: warnings and the helper gate

At each helper launch of a team session, with the budget on or off, the model gets rule 8's helper default. Claude
Code hands it over with the launch's result, so it speaks of the next helper: `teamrig rule 8: work in your own
session: a helper's tokens cost 2.2x yours [budget.subagentWeight], so start one only when it keeps far more than
that out of your context or truly runs in parallel, never for a build or test whose result you need. A broad read
that returns a short answer is the case that pays; weigh the next helper the same way.` With
`budget.subagentWeight` at 1 or less it names no factor.

With `budget.enabled` on and the week's use known (from the [status line](commands.md#teamrig-statusline) or
`budget.weeklyLimitW`), the hooks watch each session's use today against its daily budget. At a turn's end the
Stop hook counts only this tab's new transcript lines and its subagents' (at most `budget.maxBytesPerHook` bytes)
and reads every other session's use as last stored. Each line comes once, so most turns show none:

- as the session passes each of `budget.warnAtPct` (80 and 100 by default) of its daily budget, then every 25
  points more: `Budget: shop-web has used 1.1% of the week today; its daily budget is 1.0%. The team has used 4.2%
  of the week today, at or past its in-day pace of 4.0%, and the team is 10.3 points ahead of its pace line. The
  lead has an inbox line. More: teamrig budget`;
- when the session escalates with no new level: the team's room for the day runs out, or the team moves ahead of
  its pace line, while the session is past its budget;
- when quiet hours (`budget.quietHours`) begin, and when a lift from the lead starts or ends.

A session's daily budget is its part of the team's, and no session waits while the team has room. The team has
room today while everyone's use today (its sessions' and the use outside the team, which shares the weekly limit)
is below its in-day pace: today's use in quiet hours, plus today's allowance times the share of today's active time
gone by (quiet hours count at `budget.quietHours.paceWeight`, and the use in them at the rest of each hour; on the day
the week starts or the pace ends, only the part inside the week counts). The quiet-hour use has already lowered the
allowance, which is recomputed from what is left, so a night a lift worked through does not read as a morning past
the pace.
Past its part while the team has room, a session is not held, and its line says so: `The team has room today: 2.0%
of the week used, below its in-day pace of 4.0%, so nothing more happens.` Past its part once the team has no room,
it is held: only p1 work wakes it, and it is escalated when `budget.escalate` is `session`, or, with
`session-and-fleet` (the default), only while the whole team is also ahead of its pace line. Then
`budget.overAction` applies:

| `overAction` | What happens |
| --- | --- |
| `warn` (default) | the lines only |
| `ask-lead` | the lead also gets one inbox line a day, naming the lift command |
| `ask` | the lead's line, and the person is asked before each new helper launch |
| `block` | the lead's line, and new helper launches are refused |

While escalated, the model is told with the next prompt, once per level: `teamrig budget: you are past today's
budget and the team has no room left today, and it is ahead of its pace line. Finish the step in hand and start
no new work items or helpers.
Never skip a test or check to save budget. The lead can lift it.`

In quiet hours, `budget.quietHours.action` applies to helper launches as well (`ask` or `block`; `warn` only
says the team rests), and the stronger of the two wins. Nothing else is ever held, so a fix in hand always
finishes. The lead's own helpers, and those of a session the lead lifted (`teamrig budget lift`, always with a
stop %), always go ahead. What each session was shown is kept in `state/usage/warn/<id>.json`.

A burst ([teamrig burst start](commands.md#teamrig-burst-start)) comes the same way, once each. A session in it
sees `Budget: the lead started a surplus burst ...` at its next turn end and a line when it ends; its model is
told with the next prompt how to work in it (`teamrig burst: a surplus burst runs until ... Run up to 3 helpers at
once, on independent tasks only; give each edit in a repo its own worktree, and integrate one change at a time.
Helpers run on your model and effort, never a cheaper model or lower effort, and never skip a test or check.`) and,
at its end, to finish the step in hand and start no new helpers. While it runs, the session's daily budget is at
least the burst's, so the warnings and the helper gate above count against that; quiet hours still apply, and a
lift wins over it. With no burst in force, the lead's model is told once a week when the surplus window is open
and enough of the week is projected unused: `teamrig burst: about 10.3% of the week is projected unused at the
pace end ...; preview one: teamrig burst start surplus --reason "<why>"`. The hooks only suggest a burst; a
person starts it.

## Every session: the restore tracker

`hook restore-track` runs at each session start, prompt, turn end, API error (`StopFailure`) and session end,
in a team or not, and keeps one file per Claude Code session on the machine: `<home>/restore/sessions/<session
id>.json`. It holds the folder the session started in (`$CLAUDE_PROJECT_DIR`, which a `cd` or a worktree does
not move), its transcript, its Claude Code's process id, how it was started (`$CLAUDE_CODE_ENTRYPOINT`,
`$CLAUDE_CODE_SESSION_KIND`), its team and session when `teamrig launch` started it, and what it was doing at
its last event: `working` from a prompt to the end of that turn, `ready` after it, `error` after an API error.
A compaction's start changes nothing, since it comes mid-turn. `hook tool-end` writes the file too at a tool call's
end, at most every 5 minutes: a main-thread call marks the session `working`, and a helper's (which can run on past
its turn's end) keeps the state, so the file's `updatedAt` stays within minutes of a long turn's transcript while
the session's hooks run ([the hookless-tab check](#end-of-a-turn-hookless-tabs) reads that). An end the person or
Claude Code chose (`/clear`, a resume, a logout, an exit at the prompt) removes the file; any other end stamps `endedAt`, since
the shutdown may be what closed the terminal, and a Claude Code the shutdown killed leaves its last event
as it was. The restore after a reboot reads these files. The hook prints nothing, and on any error writes
nothing and lets the turn go on.

## Every event: tab status

With `tabStatus.enabled: true` in the team config (`team create` writes it for a new team) and `CLAUDE_CODE_DISABLE_TERMINAL_TITLE=1` in Claude Code's
environment (in `env` of `~/.claude/settings.json`; without it Claude Code writes its own title over the circle),
each tab of the team shows a colored circle before its title for what its session is doing:

| Circle | State | Set by |
| --- | --- | --- |
| green | ready for a prompt | a session's start (not a compaction's), a slash command typed (most end with no turn), a turn's end with no helper running, a `/compact` typed |
| yellow | working | a prompt, a tool call's end, a helper's start, an automatic compaction's end, and a turn's end while a helper or workflow it started still runs |
| orange | waiting on you | a permission prompt, a question (`AskUserQuestion`, not one the picker guard refuses), a plan to approve (`ExitPlanMode`), an MCP server's request (`Elicitation`) |
| blue | waiting on your decision | a turn's end whose last message has a line that starts `Decision needed:` (see below), until your next prompt |
| red | an API error | `StopFailure` |
| purple | compacting | `PreCompact` |

After the circle comes the session's topic, the first of: the session's title (a `/rename` or Claude Code's
own), the first prompt typed (read from a transcript short enough to read whole), the prompt just typed, the
project folder's name, then `Claude Code`; at most 40 characters, longer ones cut with an ellipsis. When the
refresh marks the tab (`refresh.tabTitle`), the circle goes before that mark (`shop-web: type /clear`) instead.
At the session's end the title goes back to the terminal.

The decision circle needs no model guess: `hook stop` reads the turn's last message (Claude Code's
`last_assistant_message`, no transcript read) and shows blue when one of its lines, outside a fenced code block,
starts with `Decision needed:`, bare, in bold (`**Decision needed:**`) or as a heading (`## Decision needed:`);
the marker inside a sentence, quoted (`>`), in a list, indented or in other casing does not count. It wins over
a helper still running, since the question waits on you either way. With tab status on, core rule 9 has owner
questions carry that line, so a session that leaves a decision in its tab, and the lead that relays owner
decisions, ends its turn on blue; an ordinary turn end stays green.

`hook tab-status` sets it at every event but `Stop`, whose `hook stop` sets it with its own output, so each event
has one writer. It works in any tab of the team, a tab that is no session of it too, and prints nothing outside a
team, with either switch off, or on any error. It reads Claude Code's switch before any file, so with it off the
hook costs only a Node start per event; its timeout is 5 seconds. A background command or a monitor still running
leaves the tab green: only a helper keeps it yellow.

## Every turn: the turn log

So that a refresh never takes away what the person was reading, three hooks keep each team session's turns in
`state/turn-log/<session id>/<UTC hour>.jsonl` (`turnLog.enabled`, on by default), which the task pane shows:

- `hook inbox-reminder` (a prompt) writes the prompt sent.
- `hook stop` (a turn's end) writes the reply: the text of every model entry since the turn's prompt, read from the
  last MiB of the transcript, ending with Claude Code's `last_assistant_message` when the transcript does not hold
  it yet. A stop a hook sent back (the handover ask) ends part of a turn: the entry records the last transcript
  entry it took (`upTo`), and the turn's next stop starts after it, so no text is logged twice.
- `hook session-start` writes a `clear` entry after a /clear or a compaction, then removes every session's hour
  files that ended more than `turnLog.keepHours` (24) ago; it only lists folders.

Each line is `{v: 1, at, kind: prompt|reply|clear, text, claude, truncated?, upTo?}`, `claude` the Claude Code
session id. `text` has secret shapes masked (the register's patterns and `register.secretPatterns`) and keeps at
most 64,000 characters, the end of a longer one; `truncated` marks that cut, or a reply whose turn began before
the part of the transcript read. A tab that is no session of the team writes nothing, and any error leaves the
turn as it was.

## Permissions

teamrig never edits Claude Code's permission or auto-mode settings, and it adds no allow rules. Only the opt-in
read-only allow lets a call skip the prompt, and only a shell line it proves only reads.

- **Auto mode**: no settings entry is needed. In a hand test on Claude Code 2.1.300 with no user settings at all,
  the auto-mode classifier allowed every teamrig command it was given (43 calls: creating a team, adding and
  setting tasks, inbox lines, reads and lists, from Bash and from PowerShell, whether the user named the command or
  the session chose it from the team rules): none was denied or asked.
- **Default mode**: Claude Code asks before each `teamrig` command until you allow it. One rule covers them all;
  put it in your user settings (`~/.claude/settings.json`) or the project's `.claude/settings.json`:
  ```json
  { "permissions": { "allow": ["Bash(teamrig:*)"] } }
  ```
  In a hand test on Claude Code 2.1.301 with no user settings, that rule, given in a settings file
  (`claude --settings`) and as `--allowedTools`, let every teamrig command run with no question (`--version`,
  `team create`, and a chain of two, `teamrig who && teamrig list`), while `git --version` was still asked.
  `Bash(teamrig *)` worked the same. The rule is for the Bash tool, where Claude Code puts `teamrig`.
- **The push guard** asks or refuses on its own, whatever the mode: a push to a protected branch always asks the
  human, or is refused under `prompts.hookAsks: refuse`.
- **The commit guard** refuses a git command run without the repository's hooks on its own, whatever the mode,
  unless `commitGuard.skipHooks` is `ask` or `allow`.
- **The package guard** refuses an ad-hoc package run or an unvetted install on its own, whatever the mode, unless
  `packageGuard.adHocRunners` or `packageGuard.installs` is `ask` or `allow`.
- **The secret guard** refuses a call that would print a secret on its own, whatever the mode, unless
  `secretGuard.secretReads` is `ask` or `allow`.
- **The exec guard** refuses a privileged command's review run as another session or the owner, and any
  `exec` call through a client that is no install of the plugin or was changed, on its own, whatever the mode, so `Bash(teamrig:*)` stays safe for
  `exec` too. A team that wants each review asked as well allows the rest by name (`Bash(teamrig exec request:*)`,
  `dry-run`, `status`, `run`) instead of the one rule.
- **The read-only allow** (`readonlyShell.enabled`) lets a shell line that only reads run with no prompt in default
  mode too; it never asks or refuses, so in a mode that already allows the line it changes nothing.
- **The picker guard** (`pickerGuard.enabled`) refuses the question picker to every session and helper, and to the
  lead outside the owner's daily meeting, on its own, whatever the mode.
- **The prompt refusal** (`prompts.hookAsks: refuse`) answers every permission prompt but the picker's and plan
  mode's exit, whatever raised it: a provably read-only line runs, a line with a rerun form is refused quoting it,
  anything else is refused.
