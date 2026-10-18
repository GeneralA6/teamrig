# Hooks and permissions

The plugin's `hooks/hooks.json` registers thirteen Claude Code hooks and one mod ([the /teamrig command](#the-mod-the-teamrig-command), [the refresh's /clear](#the-mod-the-refreshs-clear), [the reload after an install](#the-mod-the-reload-after-an-install), [the wake on urgent work](#the-mod-the-wake-on-urgent-work)). Each runs
`node <plugin>/dist/cli/main.js hook <name>` with a 15 second timeout. Outside a project tied to a team (no `$TEAMRIG_TEAM` and no `.teamrig.json`)
they all stay silent, and only `hook restore-track` still records the session ([the restore tracker](#every-session-the-restore-tracker)).

| Claude Code event | teamrig hook | What it does |
| --- | --- | --- |
| `SessionStart` (startup, resume, `/clear`, compact) | `hook session-start` | Injects the team rules and who you are |
| `SubagentStart` (each helper) | `hook subagent-start` | Gives the helper the team rules and whose helper it is ([A helper's start](#a-helpers-start)) |
| `SessionStart` (`/clear`), in the background | `hook refresh-wake` | Wakes a session that `/clear` started from its context refresh, so it carries on without a prompt |
| `UserPromptSubmit` (each prompt) | `hook inbox-reminder` | Cancels a waiting automatic restart; shows new inbox lines; binds a tab started by hand by its title; records a Claude Code rename; tells the model when it is past its daily budget |
| `PreToolUse` on `Bash` and `PowerShell` | `hook push-guard` | Asks before a push to a protected branch; refuses a force-push or delete of one |
| `PreToolUse` on `Bash` and `PowerShell` | `hook package-guard` | Refuses a package runner that would fetch and run a package outside the project's lockfile ([the package guard](#before-a-shell-command-the-package-guard)) |
| `PreToolUse` on `SendMessage` | `hook cold-send` | Holds once a message that would wake an idle session cold; during the daily meeting, holds every message to the lead but a CRITICAL one |
| `PostToolUse` on `SendMessage` | `hook failed-send` | After a send that was not delivered, hands the model [the inbox line to write instead](#after-a-failed-send-the-inbox-line) |
| `PostToolUse` on reads, edits and shell calls | `hook loop-nudge` | Asks the model once to batch when a turn makes [single-step calls in a row](#after-a-tool-call-the-loop-nudge) |
| `PreToolUse` on `Agent` and `Task` | `hook helper-gate` | Restates rule 8's helper default at each helper launch; asks before or refuses one past the daily budget or in quiet hours, [as the team set](#the-daily-budget-warnings-and-the-helper-gate) |
| The mod, while a tab is idle | `hook wake-check`, `hook wake-dropped` | Wakes the tab's session when unblocked urgent work is handed to it, [batched, with its cost shown](#the-mod-the-wake-on-urgent-work) |
| `Stop` (end of each turn) | `hook stop` | Sends the session back once to [a skill edit it dropped](#end-of-a-turn-or-a-helper-a-dropped-skill-edit); asks for a handover when a context refresh is due, then starts the automatic restart; tells the user of another effort than `launch` asks, or of a model Claude Code switched to; shows the budget lines; names a verifying task whose verify-by day has come; once per `github.everyMinutes` for the whole team, starts `gh sync --auto` hidden in the background |
| `SessionStart`, `UserPromptSubmit`, `Stop`, `StopFailure` and `SessionEnd`, in a team or not | `hook restore-track` | Records each Claude Code session on the machine, where it started and what it was doing, for the restore after a reboot ([the restore tracker](#every-session-the-restore-tracker)) |

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
9. **The verify queue**: while the session has `verifying` tasks, one line naming them, oldest first:
   `VERIFY 2: T1 (proof: the nightly run), T4 (proof: ...)`. `teamrig verify` lists them in full.
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

## Before a shell command: the package guard

A package runner can fetch a package and run it in one step, outside the project's lockfile, so nobody vetted the
version that runs. Before Claude runs a Bash or PowerShell command, the guard reads it as the push guard does
(chains, subshells, nested shells, `cd` and `Set-Location`) and refuses:

- `npx`, `npm exec`, `pnpx`, `bunx` or `bun x` of a tool that is not in `node_modules/.bin` of the folder it runs
  in or of a folder above it (`--prefix` names another); a version (`npx eslint@9`) or `-p`/`--package` always counts;
- `npm create`, `npm init <initializer>`, `pnpm dlx`, `pnpm create`, `yarn dlx`, `yarn create` and `bun create`,
  which always fetch.

`npx --no <bin>` (or `--no-install`), `pnpm exec`, `yarn exec` and a package script run only what is installed, so
they run as usual. The reason: "teamrig package guard: `npx eslint` fetches and runs a package outside the
project's lockfile, unvetted. Vet the exact version first (publish date, advisories), add it as a pinned
devDependency, then run its local bin (npx --no <bin>). [packageGuard.adHocRunners]"

`packageGuard.adHocRunners` sets what such a line gets: `deny` (the default), `ask` the human, or `allow`. A missing
or broken config keeps `deny`, so a config mistake never turns the guard off. Like the push guard, it reads only the
line Claude runs, not a script or program that line starts.

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
keeps it. A prompt the user sends first cancels it, and you keep this
context until your next task end asks again, or your context grew a fifth of `refresh.contextTokens` more; text typed but not sent is lost. When the restart cannot start, the message
and the title are the `/clear` ones above. On Windows an ended Claude Code runs no SessionEnd hooks: `refresh.endCommand` names a
program run in their place, given their input. While background work you started (subagents, background
commands, monitors, workflows) has not reported back, all of this waits for a later turn end, so a fresh start
never cuts it off. The hooks read that from the transcript (helpers started within the last 6 hours); the mod below
also asks Claude Code before its `/clear`, and holds while a helper of this session still runs. A `/clear`, a new process or a compaction starts the task count over. Each finished task is judged once, so
it never loops. Steps: [workflows.md](workflows.md#handover-at-high-context). `refresh.enabled: false` turns it
off.

## The mod: the refresh's /clear

A hook cannot run `/clear`; a plugin mod (`hooks/register.ts`, named under `modules` in `hooks.json`) can, through
Claude Code's own command API. In each interactive tab it asks `teamrig hook clear-dir` once for the ask folder,
then looks each second for an ask for its tab's Claude Code session. It tracks turns, and leaves an ask that comes
while one runs: the restart takes that one back and asks again once the session is quiet. Otherwise it asks Claude Code
for the session's agents (`$.agent.list()`). While one is live (not completed, failed or killed; an idle teammate
counts), or Claude Code will not list them, it runs `teamrig hook clear-claim --hold` and no `/clear`: the restart
ends nothing, waits for quiet and asks again, and gives up an hour after it started. Else it runs
`teamrig hook clear-claim` and, on `taken`, runs `/clear` the way you would. The `/clear` then runs the
`SessionStart` hooks above, so `hook refresh-wake` starts your first turn at your handover. A Claude Code that does
not load mods leaves the ask unclaimed, and the restart ends and restarts the session instead.

## The mod: the reload after an install

`claude plugin update` installs a new version, but an open tab runs the one it loaded until `/reload-plugins`. In
each interactive tab the mod reads Claude Code's `installed_plugins.json` (in the `plugins` folder that holds the
cache it runs from) when it loads and every 15 s after. Once an install that applies to the tab changed (a user-scope
one, or a project- or local-scope one for the tab's project: added, removed, or another folder, version or commit),
the file has read the same for 10 s and no turn runs (a subagent's included), it runs `/reload-plugins` the way you
would. It runs at most one per 5 minutes and never two for the same installs, and keeps the last one in the
session's state (`teamrig.reload`, typed in `types/index.d.ts`), so the mod the reload loads keeps both. A refused
reload goes to Claude Code's debug log and is tried again 5 minutes later. A plugin loaded from a folder
(`--plugin-dir`) has no `installed_plugins.json` beside its cache and gets no reload; a Claude Code that does not
load mods leaves `/reload-plugins` to you.

## The mod: the wake on urgent work

An idle session sees new work only at its next prompt. In each interactive tab, every 15 s while no turn runs (a
subagent's included), the mod runs [`teamrig hook wake-check`](commands.md#teamrig-hook-wake-check) once the task
log changed, a batch fell due or 10 minutes passed. It wakes the tab's session for a task it owns that another
session handed to it, raised, reopened or freed (its own changes are not news), open or started, not waiting, with
every task it comes `--after` finished, at `wake.priority` or more urgent (p1 by default). Past its daily budget,
or in the budget's quiet hours unless its lift exempts it, only p1 wakes it. While the owner's daily meeting is open
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

The Stop hook also tells the user of each of the session's `verifying` tasks whose verify-by day (its due date,
UTC) has come: `VERIFY T1 was to be verified by 10-14 (proof: the nightly run): done with the proof, or back to
in-progress`. It reads the task list only at the session's first stop of each UTC day, so a task is named once a
day until it is `done` or back `in-progress`, and a date moved to today after that stop waits for the next day.
A failed read leaves the line out. Which tasks were named today is kept in `state/verify-notices.jsonl`, which
holds only the current day.

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
A compaction's start changes nothing, since it comes mid-turn. An end the person or Claude Code chose
(`/clear`, a resume, a logout, an exit at the prompt) removes the file; any other end stamps `endedAt`, since
the shutdown may be what closed the terminal, and a Claude Code the shutdown killed leaves its last event
as it was. The restore after a reboot reads these files. The hook prints nothing, and on any error writes
nothing and lets the turn go on.

## Permissions

teamrig never edits Claude Code's permission or auto-mode settings, and it adds no allow rules.

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
  human.
- **The package guard** refuses an ad-hoc package run on its own, whatever the mode, unless
  `packageGuard.adHocRunners` is `ask` or `allow`.
