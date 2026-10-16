# Hooks and permissions

The plugin's `hooks/hooks.json` registers seven Claude Code hooks. Each runs
`node <plugin>/dist/cli/main.js hook <name>` with a 15 second timeout. Outside a project tied to a team (no `$TEAMRIG_TEAM` and no `.teamrig.json`)
they all stay silent.

| Claude Code event | teamrig hook | What it does |
| --- | --- | --- |
| `SessionStart` (startup, resume, `/clear`, compact) | `hook session-start` | Injects the team rules and who you are |
| `SessionStart` (`/clear`), in the background | `hook refresh-wake` | Wakes a session that `/clear` started from its context refresh, so it carries on without a prompt |
| `UserPromptSubmit` (each prompt) | `hook inbox-reminder` | Cancels a waiting automatic restart; shows new inbox lines; binds a tab started by hand by its title; records a Claude Code rename; tells the model when it is past its daily budget |
| `PreToolUse` on `Bash` and `PowerShell` | `hook push-guard` | Asks before a push to a protected branch; refuses a force-push or delete of one |
| `PreToolUse` on `SendMessage` | `hook cold-send` | Holds once a message that would wake an idle session cold |
| `PostToolUse` on `SendMessage` | `hook failed-send` | After a send that was not delivered, hands the model [the inbox line to write instead](#after-a-failed-send-the-inbox-line) |
| `PostToolUse` on reads, edits and shell calls | `hook loop-nudge` | Asks the model once to batch when a turn makes [single-step calls in a row](#after-a-tool-call-the-loop-nudge) |
| `PreToolUse` on `Agent` and `Task` | `hook helper-gate` | Asks before or refuses a helper launch past the daily budget or in quiet hours, [as the team set](#the-daily-budget-warnings-and-the-helper-gate) |
| `Stop` (end of each turn) | `hook stop` | Asks for a handover when a context refresh is due, then starts the automatic restart; tells the user of another effort than `launch` asks, or of a model Claude Code switched to; shows the budget lines; names a verifying task whose verify-by day has come; once per `github.everyMinutes` for the whole team, starts `gh sync --auto` hidden in the background |

## Session start

The injected context holds:

1. **The core rules**: numbered rules starting `# Team rules (teamrig core)`, with the team's own values in
   them and the config key behind each value in `[brackets]`. A protected-branch or forbidden-frontmatter list
   longer than 120 characters prints its first items and "and N more"; the push guard and `check` still use the
   whole list. `teamrig rules --session <id>` prints the same text. The lead alone gets three more lines after
   them, starting `As the lead, also:`: bring the owner only verified results, decisions, investigated questions
   and incidents; enter each owner order it relays as a task in the same turn; plan from `plan` and `check`, never
   from memory. No other session pays for them.
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
5. **The team's own `rules.md`**, when it exists. Where it or the project's CLAUDE.md conflicts with the core
   rules, they win.
6. **After a refresh**: `You were refreshed after T2; read your handover first: <path>`, once, at the first
   fresh start (the automatic restart, a `/clear` or a new start) after the handover was written. A compact or resume keeps the old context, so the
   note waits. It then lists what the old session leaves: its scheduled jobs and a pending wake-up to make again
   (`CronCreate`, `ScheduleWakeup`), its scratchpad and its plan file. After a `/clear`, `hook refresh-wake` then starts a turn by itself that tells the session to read that
   handover and carry on, so it does not sit idle until someone types.
7. **A model check**: when the session runs on another model than its `launch` entry in the team config, a line
   such as `MODEL shop-web runs model claude-sonnet-5; the team config asks for model opus at xhigh effort: type
   /model opus`. It is also shown to the user, who alone can change it. It never blocks. Claude Code gives a hook
   the effort only at the end of a turn, so the effort is checked there ([model notices](#end-of-a-turn-model-notices)).
8. **The verify queue**: while the session has `verifying` tasks, one line naming them, oldest first:
   `VERIFY 2: T1 (proof: the nightly run), T4 (proof: ...)`. `teamrig verify` lists them in full.
9. **What teamrig lacks**: shown to the user only, once per Claude Code session, when git is not on the PATH or
   Claude Code or Node.js is too old ([the requirements check](requirements.md#the-requirements-check)).

The session is found from `$TEAMRIG_SESSION`, else from the area this Claude Code session last ran
`teamrig inbox read --session <area>` as, else from the tab's Claude Code title (see [Each prompt](#each-prompt)). A
brand-new tab teamrig did not open, with no title naming a session, has none of these, so it is told to ask.

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
  to allow in the team's config.json." Commits over the size rule (400 changed non-test lines or 15
  files without a `Large-commit:` line) are listed with it; with `commits.gate: refuse` they turn the ask into a
  refusal. A `--force-with-lease` push is asked with its own reason, which does not name the switch.
- **Runs with a note**, when `pushGuard.pushToProtected` is `allow`: a normal push to a protected branch, with
  "teamrig did not ask about this push to a protected branch (main, master): pushGuard.pushToProtected is allow."
  and any large commits listed; Claude Code's own permissions still decide. `--force-with-lease` and doubts still
  ask, refusals stay, and `commits.gate: refuse` still refuses large commits.
- **Refuses**: a force-push (`--force`, a `+` refspec), a delete or `--mirror` of a protected branch:
  "Force-pushing, mirroring or deleting a protected branch (main, master) is refused: it can overwrite other
  sessions' commits. Push your own branch, or use --force-with-lease if you truly mean it."
- **Asks, in doubt**: when it cannot read part of the line (an unclosed quote, a branch or alias only known when
  the line runs; a bash variable counts as known when the line set it earlier to text and other known variables,
  as in `B=feat; git push -u origin $B` or `G="git -C /w"; $G push`, and never set it otherwise): "The guard
  cannot tell whether this command pushes to a protected branch (...): <why>. Confirm, or write the push out
  plainly." Some doubts, such as an unclosed quote or `bash -c "$CMD"`, ask only when the line names a push in a
  word of its own (`push`, `--push`, `git-push`), never in a path such as `src/push-guard`.

What to do: push your own branch and merge through a pull request, or write the push out plainly so the guard
can read it. Never route around a refusal; report it to the lead. The guard reads chains, subshells, nested shells,
wrappers and git aliases, but it does not see a push inside a script or program the command runs, `gh pr merge`,
git extensions, or pushes run outside Claude Code. It is a guard against mistakes, not a sandbox: protect the
branch on your git host too.

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

## After a tool call: the lead boundary

The lead decides, briefs and reads results; the owning session, a helper or a temporary session does the work. On
the lead's tab (`roles.lead`), the same hook counts the turn's calls that are work to hand off:

- an edit outside its own files, or a git step that changes a repository (`commit`, `push`, `merge`, `rebase` and
  the like);
- a test run or a build;
- a code search: a `Read` of a source file, a `Grep` or `Glob`, a shell `grep`, `rg` or `find`.

Its own files are the team's teamrig folder, Claude Code's memory folders and `leadBoundary.ownPaths` (`~` is your
home, `*` one folder name), so its board, notes and agenda never count, nor does reading results, boards and docs.
At the turn's first edit, its first test or build and its `leadBoundary.searchNudgeAt`-th code search (3 by default;
0 never), the lead's model gets one line:

```text
teamrig: the lead edited hook.ts itself. The lead hands such work to the owning session (a register task), a helper or a temporary session, and keeps to deciding and briefing [leadBoundary].
```

At the turn's end you see what the lead did itself:

```text
Lead boundary: this turn the lead did 2 edits (CLAUDE.md, hook.ts), 1 test or build itself; it delegates such work [leadBoundary].
```

It never blocks. `leadBoundary.enabled: false` turns both off. A helper's calls are not counted: handing work to one
is the point.

## End of a turn: context refresh

After a turn in which you set a task done, the Stop hook measures your context from the transcript. At or over
`refresh.contextTokens` (120,000 by default), at every `refresh.everyTasks` finished tasks (3) with the context at
`refresh.everyTasksMinTokens` (80,000) or more, or when the lead asked with `teamrig refresh <id>`, it keeps you going with one instruction: write your handover to
`<home>/teams/<team>/handover/<id>.md`, then run `teamrig refresh --ready --session <id>`, and start nothing new.
After `--ready`, the next turn's end tells the user `teamrig: shop-web finished T2 and wrote its handover; teamrig
starts it fresh once it has been idle 15 s (type anything to keep this context)` and sets the tab title to
`shop-web: restarting`. A hidden `teamrig restart` then waits until the tab has been idle
`refresh.restartDelaySeconds` (15) with nothing running and its last turn ended, ends this Claude Code and starts it again: in the same tab
when `teamrig open` started it, else in a new tab. A prompt the user sends first cancels it, and you keep this
context until a later task end asks again; text typed but not sent is lost. When the restart cannot start, or
with `refresh.autoRestart: false`, the message says `type /clear for a fresh start` and the title
`shop-web: type /clear`. On Windows an ended Claude Code runs no SessionEnd hooks: `refresh.endCommand` names a
program run in their place, given their input. While background work you started (subagents, background
commands, monitors, workflows) has not reported back, all of this waits for a later turn end, so a fresh start
never cuts it off. A `/clear`, a new process or a compaction starts the task count over. Each finished task is judged once, so
it never loops. Steps: [workflows.md](workflows.md#handover-at-high-context). `refresh.enabled: false` turns it
off.

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

The Stop hook also tells the user of each of the session's `verifying` tasks whose verify-by day (its due date,
UTC) has come: `VERIFY T1 was to be verified by 10-14 (proof: the nightly run): done with the proof, or back to
in-progress`. It reads the task list only at the session's first stop of each UTC day, so a task is named once a
day until it is `done` or back `in-progress`, and a date moved to today after that stop waits for the next day.
A failed read leaves the line out. Which tasks were named today is kept in `state/verify-notices.jsonl`, which
holds only the current day.

## The daily budget: warnings and the helper gate

With `budget.enabled` on and the week's use known (from the [status line](commands.md#teamrig-statusline) or
`budget.weeklyLimitW`), the hooks watch each session's use today against its daily budget. At a turn's end the
Stop hook counts only this tab's new transcript lines and its subagents' (at most `budget.maxBytesPerHook` bytes)
and reads every other session's use as last stored. Each line comes once, so most turns show none:

- as the session passes each of `budget.warnAtPct` (80 and 100 by default) of its daily budget, then every 25
  points more: `Budget: shop-web has used 1.1% of the week today; its daily budget is 1.0%. The team is 10.3
  points ahead of its pace line. The lead has an inbox line. More: teamrig budget`;
- when the team moves ahead of its pace line while the session is past its budget;
- when quiet hours (`budget.quietHours`) begin, and when a lift from the lead starts or ends.

Past its budget, a session is escalated when `budget.escalate` is `session`, or, with `session-and-fleet` (the
default), only while the whole team is also ahead of its pace line. Then `budget.overAction` applies:

| `overAction` | What happens |
| --- | --- |
| `warn` (default) | the lines only |
| `ask-lead` | the lead also gets one inbox line a day, naming the lift command |
| `ask` | the lead's line, and the person is asked before each new helper launch |
| `block` | the lead's line, and new helper launches are refused |

While escalated, the model is told with the next prompt, once per level: `teamrig budget: you are past today's
budget and the team is ahead of its pace line. Finish the step in hand and start no new work items or helpers.
Never skip a test or check to save budget. The lead can lift it.`

In quiet hours, `budget.quietHours.action` applies to helper launches as well (`ask` or `block`; `warn` only
says the team rests), and the stronger of the two wins. Nothing else is ever held, so a fix in hand always
finishes. The lead's own helpers, and those of a session the lead lifted (`teamrig budget lift`, always with a
stop %), always go ahead. What each session was shown is kept in `state/usage/warn/<id>.json`.

## Permissions

teamrig never edits Claude Code's permission or auto-mode settings, and it adds no allow rules.

- **Auto mode**: no settings entry is needed. In a hand test on Claude Code 2.1.300 with no user settings at all,
  the auto-mode classifier allowed every teamrig command it was given (43 calls: creating a team, adding and
  setting tasks, inbox lines, reads and lists, from Bash and from PowerShell, whether the user named the command or
  the session chose it from the team rules): none was denied or asked.
- **Default mode**: not tested. Claude Code asks before a shell command it has no allow rule for; any allow rule
  is yours to add.
- **The push guard** asks or refuses on its own, whatever the mode: a push to a protected branch always asks the
  human.
