# teamrig workflows

Each workflow is the exact sequence of commands, in the order to run them. The examples use team `shop`, with
the sessions `lead`, `api` and `web`; replace the ids with yours and pass `--session` unless `$TEAMRIG_SESSION`
is set.

## Start of a work block

At the start of each work block, after a `/clear`, and in any tab teamrig did not open:

```sh
teamrig start --session api
```

It prints the time, how far your checkout is behind main (`BEHIND`, when it is: rebase before you edit), your
unread inbox lines, your task list, the other sessions' tasks waiting on yours
(`WAITING ON YOU`, when some do), the `check` flags of your tasks and skills, and the week's use. After a context
refresh or a compaction, the start note opens with `START <id>, <time>: this note is your work block's start` and
holds what `start` prints first: run `start` at your next work block instead.

1. Read each inbox line. A line that asks for work should name a task id; if it does not, add the task yourself
   (`teamrig add --session api --title "..." --description "<what and why>" --priority p<n> --source <asker>`).
2. Take the first task of your list: lists are in plan order (a pinned task, band, a task that can move, score, then a started task, effective due date,
   what it unblocks, the week plan, size, then id; a task that a dated task needs takes that earlier due,
   `due 10-17 (from T9)`), and each row's `· ahead:` names the key that put it ahead of the next.
3. Mark it started: `teamrig set T4 --session api --status in-progress`.
4. Before you start any work that is not on the list, add it: self-made work is a task too, unless it is a step
   of a task you hold ([tasks.md](tasks.md#a-task-or-a-step)). Start it only for a goal, a parent task (one
   planned after it) or the week plan, never ahead of your top task that is not waiting; a one-commit fix is
   exempt. A loop, cron or scheduled wake-up needs the lead's OK and a written stop (a time or a usage %).

If the session-start context said no session is set, ask the user which session you are (`teamrig who` lists
them) before running anything.

## Hand work to another session

When another session must do something, in one turn:

```sh
teamrig add --session api --owner web --priority p2 --title "Show the signup errors from the api" --description "The form shows a blank error; the api now names each field that failed, so show it under that field." --due 2026-10-17 --ref "docs/errors.md"
```

1. Add the task with `--owner <their id>`. The register refuses a duplicate of an active task: then point at
   the existing id instead.
2. `add` tells them: it posts them an inbox line naming the task, shown at their next prompt, so work that is not
   urgent needs nothing more. Context the title and `--ref` cannot carry goes in one more inbox line. Urgent, or
   your work is stuck on it now: a message to the name `teamrig who` prints, at most 10 lines, ending with "No reply
   needed" or "Reply needed: <one question>".
3. If you started your task and cannot go on until they finish, set it waiting on theirs:
   `teamrig set T4 --session api --status waiting --waits task:T5 --note "the error codes on the form first"`.
   Not started yet? Leave it open and plan it after theirs: `teamrig update T4 --session api --after T5`.

Never set another session's task status, and never do, merge or fix another session's change: hand it to
its owner. A decision that belongs to the human (destructive data operations, product and design, permissions,
budget, resource changes) goes to the lead, never decided by silence.

## Change a contract another session reads

Before you change an API, a table or a file another session reads, tell that session (rule 12). When your notice
names a caller the change would break, the break waits for that caller's answer or its leader's: no answer is no
consent, so it does not ship on silence. Its proof loads that caller, the page or job that reads the contract: a
removed route answering 404 proves the removal, not that its callers still work.

## Ship a change

From the first edit to a change that runs, in this order (rules 2, 7, 14 and 16):

```sh
teamrig worktree add t4-parser
teamrig test --session api -- npm test
```

1. Edit only in your own worktree and branch, made off the current main as above (or with Claude Code's
   EnterWorktree): `teamrig worktree add` fetches main first and runs the repository's `worktreeSetup` in the new
   worktree. A `node_modules` linked in from the main checkout (`mklink /J` on Windows) is removed in step 7. If you link one into a worktree Claude Code removes by itself
   (a helper started with `isolation: worktree`), unlink it before the helper ends: that removal follows the link and
   empties the main checkout's.
2. Commit one logical change at a time, each with its tests, as soon as they pass. Run tests through
   `teamrig test`: a long run costs a few lines, and the whole output stays in a log. Over 400 changed lines or
   15 files, the commit needs a `Large-commit: <reason>` line.
3. Before you push: `git fetch`, rebase on the current main, and run the tests again. On a conflict, resolve the
   files, `git add` them and `git rebase --continue`, then also run the specs of every file main changed too (the
   files of `git diff --name-only <old base> origin/main` that you changed) before you merge.
4. Merge by your team's own route: a pull request, a release script, or a push to main, which asks the human
   first. A route that is refused goes to the lead; never route around it or hand it to another session.
5. If the change must run, deploy it now, then check that the new code runs: the build has your commit, and the
   process restarted on it.
6. Set the task `verifying` with its proof and date (see "Shipped, verifying"), and `done` once the proof exists.
   If it breaks, fix it or revert it yourself: it is your change.
7. Remove the worktree and its merged branch with `teamrig worktree remove <worktree> --delete-branch`, run from
   outside it after a `git fetch`. It unlinks the `node_modules` link first, so `git worktree remove` cannot follow
   it and empty the main checkout's, and keeps a branch with a commit main lacks. Never delete the worktree folder
   recursively.

Your team's own commands for steps 4 and 5 (a deploy script, a lock on shared machines) belong in a team skill such
as `team-ship-change`; this list is the order they fit in.

A change that removes or loosens a safety step (a guard, a gate, a check, a retry) first writes down the cases it
covers, its run history (how often it fired, and on what), what is still unknown, and a first step that can be
undone, such as a warn-only mode or a flag.

## Close a task with proof

1. Finish and verify: tests pass, the change is merged or deployed as the task needs, and you checked that it
   runs. If the change altered what code reads, writes or depends on, search for comments that still describe
   the old behaviour, in other files too, and fix them in the same commit.
2. If you had to work out a procedure you will run again, write or fix its skill now (see
   [tasks.md](tasks.md#skills)).
3. Add each finding or next step the work leaves as a task (`teamrig add`), so none lives only in a notes file.
4. Set it done with the proof and those tasks (`--followups none` when it leaves none):

```sh
teamrig set T4 --session api --status done --note "signup endpoint merged and live" --evidence "commit 3f9c2ab, 41 tests pass, POST /signup 201" --skill api-release --followups T9
```

```text
SET T4 done, p2, owner api, due 10-17, from lead, goals G1 | Build the signup endpoint
```

5. Tell whoever asked, if they wait on it: one inbox line, or a message if it unblocks them now.

The register refuses `done` without `--note`, without `--evidence` (unless the task already has some), without
`--skill <name>|none` or without `--followups T<id>,...|none`; a named skill must exist, and a named follow-up must
be on the task list. When a task will not be done, set it `dropped` with a note saying why and who decided.

## Shipped, verifying

When the change is merged or deployed but what proves it does not exist yet (a night's flow, a run on another
machine, a number to measure), set it `verifying` with `--proof` naming that proof, `--waits` when it runs (a time,
or a task in progress or verifying whose end runs it) and `--due` the date to verify it by:

```sh
teamrig set T4 --session api --status verifying --note "new parser merged" --proof "tonight's import runs clean on the new parser" --waits "time:2026-10-17 06:00" --due 2026-10-17 --followups none
```

When tests or a dry run already proved the change and only a live sighting is left (a night's run, a page a user
opens), close it `done` and watch for the sighting instead; it stays under `WATCH` in `teamrig verify` until you
set it `done` again without `--watch`, or reopen it if the sighting shows a fault:

```sh
teamrig set T5 --session api --status done --note "parser fix merged" --evidence "the parser specs and a dry run on last night's file pass" --watch "tonight's import log shows no parse error" --skill none --followups none
```

It stays in `list` and `check` until you set it `done` with the proof as evidence, or `in-progress` again when
the proof fails. Past that date, `check` flags it `VERIFY-OVERDUE`. The verify loop keeps it in view
([rules](tasks.md#verify-loop)):

1. Your start context and `teamrig inbox read` end with a `VERIFY <n>: ...` line while you have verifying tasks;
   `teamrig verify` lists them, oldest first.
2. Prove the oldest first: `done` with the proof as evidence once it exists; when it fails, `in-progress`, fix,
   ship and set it `verifying` again.
3. From its verify-by day, the Stop hook shows the user a `VERIFY T4 was to be verified by ...` line once a day.
4. A start that needs your verifying task is refused, and you get one inbox line: prove that task next.

## Waiting

```sh
teamrig set T4 --session api --status waiting --waits decision:owner --note "which database to use"
```

Name every reason, comma-separated: `decision:<who>` or `approval:<who>` (the lead, or `owner` for the human),
`task:T<id>` (a task to finish first) or `time:<YYYY-MM-DD HH:MM>` (on the team's clock unless marked UTC). Then move to your next task. This is how a
session asks the owner: with `pickerGuard.enabled`, the question picker, which would stop it until the answer, is
refused to every session and helper, and to the lead, in the owner's daily meeting too (it asks the cards in plain
text). It stays
waiting until every reason has cleared; `check` flags it `READY` once its tasks are done and its time has passed,
and a decision or an approval clears when you set the next status (`set --status in-progress`); once the lead
records the owner's answer (`update --decided`), the wait on the owner is gone and `check` flags the task `READY`
until you act on it. A new decision or
approval wait posts the lead one inbox line (a child team's lead's own, the lead of the team above it); a decision for the human goes to the lead with the options, numbers
and your recommendation. The lead asks the human in batches; when the line says `AT ONCE` (due before the next
batch), the lead who asks the human (in a tree of teams, the root team's) is woken too; message it only when the
`set` says to. A budget hold is a time (`time:<date>`), never an approval.

Work you need from another session is a task, never its approval. Ask for it and wait on it in one step:

```sh
teamrig set T4 --session web --status waiting --ask api --text "Return error codes from the login endpoint" --due 2026-10-16
```

It adds api's task (`ADDED T5 ...`, at T4's priority, its description naming T4), tells api, and sets T4 waiting on
T5.

A task reason is only for a task you already started. One not started that needs another first is not waiting:
it stays `open`, planned after it (`teamrig update T4 --after T5`), and its line shows `after T5`.

## Write a decision card

A wait on the owner carries a card (`--question`, `--options`, `--recommend`, `--default`, `--gate`, and `--affects`
for a test, measure or proof), which the
lead reads out at the daily meeting and the pane shows. The owner reads it cold, between other cards, so they can
decide from it alone in about a minute:

```sh
teamrig set T4 --session api --status waiting --waits decision:owner --gate "product and design decisions" \
  --question "Should new users sign up with an e-mail link instead of a password?" \
  --options "1. E-mail link: no password to forget or leak; about 0.3% of a week | 2. Keep passwords: nothing to build, reset mails stay the top support ask" \
  --recommend "1: it removes the reset mails, half of last week's support asks" \
  --default "Passwords stay; asked again at the next meeting"
```

- One decision per card. A question with two answers in it (whether, then how) is two cards: the second only once
  the first is yes.
- The question is one sentence of about 25 words or fewer, about what the owner gets or risks, in their words: what
  they see, pay or allow. No task ids, session names, file paths, script names, setting keys or tool jargon. Say
  what a thing does instead of its name.
- Two to four options, each about 30 words or fewer: what happens, then its cost (share of the week, time, risk)
  and what it gives up. Number them. Leave out what you already ruled out, or name it in one line in the
  recommendation.
- Give only the numbers that change the choice, each with what it means ("903 tasks unchanged", not "903/1033").
- The recommendation is the pick and the one reason the owner cares about most. The default says what happens with
  no answer, and by when.
- Before you set it, read it as someone who missed the last week would: if a word needs the task list, the code or
  last week's talk to make sense, rewrite it.

Real cards, as the owner got them (names made generic). Good:

- *"Should the task pane's Changes view expand a file to show its colored edits, or is Claude Code's own /diff view
  enough?"* Options: *"Build it: a press on a file row expands its diff inline, capped at 40 lines with a pointer to
  /diff; about half a day of pane work"* and *"Skip it: Changes keeps the +N -N per file and /diff shows the
  edits"*. The question names what the owner sees; each option is a result and its cost. The owner decided it at the
  first meeting (build it, against the recommendation, which is what a clear card makes easy).
- *"Rebuild the task snapshot from its full archive? Dry run: 1 repair (a card regains its lost text), 903 tasks
  unchanged, 129 old done tasks retired as usual (still readable), nothing deleted."* Options: *"Run it now"* and
  *"Hold to the next meeting"*; recommendation: *"Run it now: only the lost field comes back"*. A destructive-data
  gate with its counts in the question, so the options can be three words each. Decided at the meeting that read
  it.

Bad:

- *"May the rules session merge its tested branches through the ship.ts merge route, which the auto-mode classifier
  now denies as Merge Without Review?"* Options: *"Paste an autoMode environment line granting it"* and *"Keep the
  denial and merge them yourself"*; default: *"The tested branches stay unmerged past the Wed 01:00 T683
  deadline"*. A session name, a script, a classifier label and a bare task id, and no word on what the owner allows
  or risks. Better: *"Let teamrig merge its own tested changes without you? 1. Paste one audited settings line:
  each merge still needs green tests and is logged. 2. You merge each one by hand in GitHub."*
- A notifications card that put six options in one list: four tools to build or adopt (one already rejected), each
  with its service count, runtime and upstream activity, then two places for the code to live. Two decisions in one
  list, a rejected option kept, and detail the owner cannot weigh. The owner answered *"not now"*: none of the six.
  Better: first *"Build phone notifications now, for about 3% of a week?"*, and the tool and its place as a second
  card only after a yes.

## Handover at high context

teamrig refreshes a long-running session at a turn end once its context is large, before Claude Code compacts it,
so it never loses work to a compaction.

1. At the end of every turn, the Stop hook measures your context. When it is at or over
   `refresh.contextTokens` (120,000 by default), at a task end after every third finished task with the context at 80,000 or more
   (`refresh.everyTasks`, `refresh.everyTasksMinTokens`), or the lead asked for a refresh (`teamrig refresh <id>`), it
   keeps you going with this instruction. While background work you started (subagents, background commands,
   monitors, workflows) still runs, it adds before `Then end your turn` how many still run, asks the handover to say what
   their results still need, and the fresh start waits until they all reported back:

   ```text
   teamrig: your context is 132k (refresh at 120k) and you just finished T2. Write your handover to <home>/teams/shop/handover/web.md, replacing the whole file (your fresh start reads all of it), with what the register lacks, not task statuses, which your fresh start reads live from the register: a `## State` section (where things are; the scratchpad files, plan file and scheduled jobs the next session still needs; questions still open with the user) and a `## Next steps` section (the next step of each task in progress; what to check later, and when). Then end your turn: the turn end takes the handover as ready. Do not start new work.
   ```

   Mid-task it says `teamrig: your context is 132k (refresh at 120k), so refresh now rather than at a task end.`
   If you go on without the fresh start (the user typed), it asks again at your next task end, or once your
   context grew a fifth of `refresh.contextTokens` more. A fresh start (a `/clear`, a new process) only measures its
   context at its first turn end, or at the first tool result the mod reports, and asks nothing; a size or task-count
   refresh then needs the context to have grown that fifth past the measure, so a session that starts over the
   threshold is never asked again before it did any work. Within a long turn teamrig's mod asks as soon as a tool
   result shows the context past the threshold (`so refresh within this turn: finish the step you are on and start
   no other`, ending `and end your turn: the fresh start follows it`), and until the fresh start Claude Code's own
   compaction waits, up to `refresh.compactCeilingTokens` (185,000).

2. Write the handover at that path, with what the register lacks, in two sections: `## State` (where things are:
   branches, worktrees, files, ids; the scratchpad files, plan file and scheduled jobs the next session still needs;
   questions still open with the user) and `## Next steps` (the next step of each task in progress; what to check
   later and when). Leave out task statuses, waits and due dates: the fresh start reads them live from the register
   (step 5), and a copy here could only go stale. It must be new: the old file left as it was is not taken.
3. End your turn. Its end takes the handover as ready, with no call: one written since the ask, with both sections,
   at most `refresh.handoverMaxBytes` (20,000 bytes). One that falls short keeps you going once per version with
   `teamrig: your handover is not ready yet: <gap>`; fix it and end your turn again. Where only a section is
   missing and the handover is complete as it is, `teamrig refresh --ready --session web` answers instead, printing
   `Ready. Ask the user to type /clear; your next start reads <path>.`. At the end of that turn the tab title becomes `[shop] web: type /clear` (the session's team and name;
   `refresh.tabTitle: false` turns that off; with `tabStatus.enabled`, after the tab's state circle).
4. End your turn and start nothing new. The user types `/clear` once done with your screen, which a `/clear`
   wipes. With `refresh.autoRestart: true` (the default is `"lead"`: the lead only) the title reads `[shop] web: restarting` instead: once the tab has been
   idle 15 s (`refresh.restartDelaySeconds`), teamrig's
   mod runs `/clear` in this tab, after asking Claude Code that no helper of yours still runs (it waits while one does),
   and once the user is away: it waits while the prompt box holds a draft and for 30 minutes after their last key or
   prompt, which a band above the prompt shows with the time left, then counts 20 s down there with
   `1: Refresh now` and `2: Hold 10 min`
   (`refresh.holdAfterActivityMinutes`, `refresh.countdownSeconds`); where it cannot, teamrig ends this Claude Code and starts it again, in the same
   tab when `teamrig open` started it, else in a new tab. While a background shell runs (a background command or
   a monitor), it ends nothing and your inbox says to type `/clear`, which keeps the shell. With no work you can
   start, the title reads `[shop] web: waits for work`: the restart waits for a wake that brings you some, and that
   work wakes the fresh session.
   If the user sends a prompt first, the restart is cancelled and you keep this context. When the restart
   cannot start, the title reads `[shop] web: type /clear`: ask the user to type `/clear`.
5. After the fresh start, the session-start context says `You were refreshed after T2; read your handover first:
   <path>`, and that a file needs a Read-tool read before an Edit or Write (Claude Code keeps no read from before
   the refresh, and a read by `cat` does not count), then the scheduled jobs (still scheduled after a `/clear`, to make again after a new process), the
   wake-up to make again, the old scratchpad and the plan file, then your active tasks as the register holds them
   (`LIVE TASKS of web, ...`, at most 6 rows and `+N more`, then the other sessions' tasks waiting on you,
   `WAITING ON YOU`, at most 3; where the handover says otherwise, the register wins).
   A compaction gets the same task block, since its summary is older than the register too. The
   restart's first prompt, or after a `/clear` a turn teamrig starts by itself, asks you to read the handover and
   carry on with its next steps. Do so; the note's `START` line makes it the work block's start, so run
   `teamrig start` at your next work block, not now (a note with no room for the task block names it to run first).

The hook judges each finished task once and never loops. A team turns this off with `refresh.enabled: false`, and the task
count with `refresh.everyTasks: 0`. A `/clear`, a new process or a compaction starts the count over.

## Use a helper

Work in your own session by default. A helper (a subagent) keeps file dumps and long output out of your context,
but its tokens cost `budget.subagentWeight` times yours (one team measured about 2.2). At that weight a helper does
not save tokens: in one team's week no helper kept more than 1.65 times its own tokens out of its caller's context.
So start one only for parallel work or an independent review; never to save tokens, nor for a build or test you
wait on. Pick who does a job, and on which model, by fit for the task, never by its length. A helper starts with
the team rules and knows it is yours: it leaves task statuses, register entries and messages to you unless its brief
asks for them, so say so in the brief when it should.

1. Run the helper on your own model and effort: a cheaper one misses things the caller then builds on.
2. Its start line tells it to save its full findings (raw numbers, file and line, what it could not check) in the
   task's folder (`teamrig files T<id>`, or your notes folder with `teamrig files --notes`) and return the path and a
   short summary, so nobody runs it again; name the task in the brief.
3. Let a helper start helpers of its own only when the task splits cleanly: a fan-out multiplies the cost.
4. Read only the lines you need from its file, never the whole of it, and never re-read a file you just wrote.

## Use a secret by reference

A secret a session reads, prints or types stays in its transcript and in every prompt after it, so the secret guard
refuses such a call ([the secret guard](hooks.md#before-a-shell-command-or-a-read-the-secret-guard)). Hand the
session the secret's name or its file, never its value:

1. In a command, name the variable that holds it: `curl -H "Authorization: Bearer $API_TOKEN" ...`. The shell puts
   the value in, and the line the transcript keeps holds only the name.
2. Give a tool the file or stdin: `--password-file`, `--env-file`, `docker login --password-stdin < token.txt`.
3. Check a secret without printing it: `test -n "$API_TOKEN" && echo set`, `wc -c < .env`, `grep -c '^DB_URL=' .env`,
   or compare a hash.
4. A script that needs the value resolves it itself and prints only counts, a status or `HTTP <code>`.
5. A test that needs a secret-shaped value builds it at run time from parts, so no file holds the whole shape.
6. A privileged command whose secret the session must not hold goes through
   [`teamrig exec request`](commands.md#teamrig-exec-request): the executor holds the value and redacts its output.
7. A secret only a human has: they type it in their own terminal, into a file or a variable, and give the session its
   name or path.

### Your own shell's history

PowerShell's PSReadLine saves each line typed in its console to `ConsoleHost_history.txt` (on Windows in
`%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine`), a credential in a URL or a token too, where any program you
run can read it. This handler keeps a line holding credentials in a URL (a password before the host's `@`) or a JWT
out of that file and out of the Up-arrow list:

```powershell
try {
    Set-PSReadLineOption -AddToHistoryHandler {
        param([string]$line)
        return -not ($line -match '://[^\s/:@]*:[^\s/@]+@' -or $line -match 'eyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{16,}')
    }
} catch {
    Write-Warning "history handler not set: $($_.Exception.Message)"
}
```

Add it to your profile yourself, since Claude Code refuses an agent's write there: run
`if (-not (Test-Path $PROFILE)) { New-Item -ItemType File -Path $PROFILE -Force }`, then `notepad $PROFILE`, paste
it, save, and open a new console. Lines saved before stay in the file: open it with
`notepad (Get-PSReadLineOption).HistorySavePath`, delete each one holding a credential, and rotate that credential.
`teamrig doctor` flags `shell-history` while the history file exists and no profile sets `-AddToHistoryHandler` or
`-HistorySaveStyle SaveNothing`.

In bash, `HISTCONTROL=ignorespace` in `~/.bashrc` (in zsh, `setopt HIST_IGNORE_SPACE` in `~/.zshrc`) keeps a line
that starts with a space out of the history: start a line holding a secret with a space.

## Lead checkpoint

At the start of each work block, and whenever the human asks for status:

```sh
teamrig start --session lead
```

With sub-teams, run `teamrig check --tree --session lead` too. Then check the ship plan (the `team-setup` skill
has the steps): each open shippable slice, a goal's fewest tasks that ship something working, has an owner, a ship
date and a live proof; one past its date or waiting on you comes first; each session keeps at most
`focus.slicesPerSession` open, one more only while one waits on another session or the owner; none needing a new
owner decision opens while `focus.maxOwnerDecisions` wait in the tree; and other work waits, incidents and
`focus.maintenanceClass` work aside. Until the register holds slices, they live in `ship-plan.md` in the lead's
notes folder (`teamrig files --notes --session lead`). While the budget is enabled, the week is split by those
plans: each lead sizes its slices in % of the week before the reset; after it, the main lead (the lead of the team
`budget.accountLead` names, else of the root team) splits the week among the account's root teams, and each lead
its part among its own team and the teams under it, by what each plan ships and how its last plan held, each team
with planned work at least `budget.shareFloorPct`% of a split. A team past its share opens nothing new. A higher
leader's call wins; an appeal, never blocking, is an `Appeal: ...` task owned by a leader above the one disagreed
with, and the main lead carries the owner's in its week report at the first meeting after the reset. Then act on
each flag (full table: [tasks.md](tasks.md#check-flags)):

- `PRIORITY-SKIP`: one inbox line to the owner to park the lower task and start the waiting one, or fix the order
  with `teamrig update T<n> --session lead --class <name>`; a change of goals is the owner's.
- `SELF-MADE`: a session adds its own work faster than anything asked for it: read those tasks
  (`teamrig list --session <id> --source <id> --status all`), then one inbox line to drop or park each that serves
  no goal, parent task or week plan.
- `OFF-GOAL`: if it belongs this week, `teamrig update T<n> --session lead --week <week>`; else ask the owner in
  one inbox line to tag its goal or park it.
- `UNTRIAGED`: class each in your daily batch: `teamrig list --untriaged`, then `teamrig update T<n> --class <name>`.
- `NO-PROGRESS`: one inbox line to the owner of the named task to move it; when something holds the plan, fix the
  order or the plan, or tell the human.
- `STOPGAP-DONE`: one inbox line to the owner of each listed file to remove the stopgap (or, for a dropped task, to
  open a new task or keep it by a decision).
- `NOT-PICKED-UP`: the owner is idle and reads no inbox: wake it with `teamrig open <id>`, or tell the human.
- `HIRE SCALE-OUT`: an area cannot finish its dated work in time, and the week's spare pays for help: move its slice
  to the idle hire it names, else hire for the slice and move it (`hire --yes` refuses while the host has no room).
- `HIRE RETIRE-DUE`: the burst a hired session was hired for is over: give it its next task, or retire
  it (`teamrig retire <id> --session lead`, `--to <heir>` for any open task). Hiring, retiring and rehiring: the
  `hire` skill.
- `HIRE REVIEW-DUE`: a hired session's review day passed: while the team still needs it, keep it to a new review day
  (`teamrig hire <id> --review <YYYY-MM-DD> --reason "<why>" --session lead --yes`), else retire it.
- `OVERDUE` or `STALE`: ask the owner what blocks it, then re-date it (`--due`) or tell the human.
- `READY`: a waiting task can go on: one inbox line to its owner, if it has not set the next status.
- `ROADMAP-WAITS-ON-LEAD`: Roadmap work has waited on a leader past `focus.leaderWaitMinutes`: answer it before
  anything else (`teamrig approve <id>`, or the decision it asks for); it leads that leader's `WAITING ON YOU`. One
  held on a sub-lead is that sub-lead's to answer: one inbox line to it.
- `NO-CARD`: a task waits on the owner with no card: one inbox line to its owner to set it waiting again with the
  card, before the meeting reads it.
- `OWNER-ORDERED`: a task the owner ordered asks the owner with no why: never read it to the owner; one inbox line
  to its owner to drop the wait, or to set it again with `--why-ask`.
- `UNGATED`: a task asks the owner to decide what no owner gate or business decision makes the owner's: never read
  it to the owner; decide it yourself if it is yours to decide, else one inbox line to its owner to decide it, or
  to set it again with `--gate`.
- `OWNER-PROOF`: a task asks the owner about a test, measure or proof of approved work that changes no approved
  number, spends no money and writes no data: never read it to the owner; one inbox line to its owner to go ahead
  and drop the wait, or to set it again with `--affects`.
- `RUN-CHANGED`: a card hands the owner a hand step file that changed or went since its audit: never ask the owner
  to run it; one inbox line to its owner to have it audited again, or to set the card again without `--run`.
- `DECISIONS batch due`: ask the human the batch `teamrig decisions --session lead` prints, together, each card as it
  stands; record each answer (`update <id> --decided --note "owner decided: ..."`), then `teamrig decisions asked
  --session lead`.
- `PEER-WAIT`: a task waits on a peer's approval or decision: one inbox line to its owner to wait on that work by
  its task (`set --status waiting --ask <session> --text "<the work>"`).
- `VERIFY-OVERDUE`: ask the owner whether the proof came: `done` with it, `in-progress` if it failed, or a new date.
- `VERIFY-BLOCKS`: work waits on a shipped change: one inbox line to its owner to prove it or reopen it.
- `LOOP`: tasks need each other in a circle, so none can finish: one inbox line to the first one's owner to make
  the step its own task (the flag prints the command), or re-plan it yourself (`update --after`).
- `PILE-UP`: a session ships faster than it proves: one inbox line asking it to work its queue (`teamrig verify`)
  before new work.
- `REPARKED`: a proof keeps moving to other waits and never runs: one inbox line to its owner to run it now
  (`done`), close it `done` with `--watch` if tests or a dry run proved it, or reopen the task (`in-progress`).
- `OVER-PACE`: a session holds more p1 work than it finished in the last 7 days, past the first p1, which is in hand, so p1 no longer says what comes
  first: lower the p1s past the flagged one that its pace will not reach (`update --priority`), hand some to another
  session, or tell the human what is held.
- `OVER-LIMIT`: the week's sized work passes the weekly limit left at this task: move it and the tasks after it to
  next week (`update --week`), or tell the human what it would cut.
- `OVER-SIZE`: a task cost more than twice its size: one inbox line to its owner to re-size what is left
  (`update --size`), split the rest off or drop it (`teamrig budget --task <id>` shows where the W went).
- `PREP-LAPSED`: re-mark the task for the slice it now prepares (`update --prepares <goal>:<slice>`), or clear
  the marker (`--prepares none`).
- `OWNER-UNPLANNED` or `DUE-UNPLANNED`: plan it in with `--week`, or tell the human what it would push out.
- A `SKILL` flag: tell the skill's owner in one inbox line.

The lead may change a task's owner, priority, due date and week; its status and goals are its owner's. To plan a
week, tag its tasks with `--week <first day>` and print it with `teamrig plan --session lead`; plan from that
output, never from memory.

Every order of the human's that creates work becomes a task in the same turn, added by the lead when it relays
the order, with the owner's source [register.ownerSource]:

```sh
teamrig add --session lead --owner api --source owner --priority p2 --title "Rate-limit the signup endpoint" --description "Bots create fake accounts; allow 5 signups a minute from one address."
```

Bring the human only what needs them: verified results, decisions taken, questions on an owner gate or a business
call (options, numbers and a recommendation) and incidents. Progress and plans stay in the register.

## Turn a lesson into a fix

A lesson is a miss that will happen again: a rule broken, tokens spent on the same pattern, an incident. Fix it
once, where it stops coming back:

1. Measure it: how often and what it costs, from a source you can run again (`teamrig budget --burn --all` for
   where the tokens went, `--loops` for chains of single-step calls, the register, the incident's own numbers).
   No number, no change.
2. Sort it: would a team building any other product hit it? If not (your domain, data or stack), it is your
   team's. If so, it is teamrig's: report it with its evidence as an
   [issue on teamrig](https://github.com/GeneralA6/teamrig/issues) (a team that builds teamrig adds a task for
   the session that does), and make no local fix.
3. Pick its form, the first that fits: a mechanism that catches it by itself (a check flag, a hook, a warning);
   else a skill, for a procedure (rule 13); else a rule line in the team's `rules.md`. A number in it is a
   config value with a default, never one project's constant.
4. Bridge only a real cost: while the fix is on its way, a local stopgap is for a budget, safety or incident cost
   alone, tagged `stopgap T<id>` with the task that replaces it (rule 10); `teamrig check` flags it
   `STOPGAP-DONE` once that task is done.
5. Confirm: once the fix is installed
   ([updating the plugin](https://github.com/GeneralA6/teamrig/blob/main/docs/how-it-works.md#updating-the-plugin)),
   measure the same number the same way. If it did not fall, the lesson goes back to step 2 with the new numbers.

The lead routes each lesson a session reports: it sorts it, sees that its task exists, and reads the confirming
number at a later checkpoint.

## The owner's daily meeting

Once a day the lead meets the human. The `daily-meeting` skill has the steps; in short:

```sh
teamrig meeting start --session lead
```

It holds every message to the lead (a CRITICAL one still goes) and prints the agenda; no session is told. Until
the meeting ends, the lead's own context refresh waits (no handover ask, no restart) unless its context reaches
`refresh.compactCeilingTokens`; the turn that ends the meeting asks at once. Lead with the ship board: each open
shippable slice and those planned 1 to 2 weeks ahead, one line each, shipped (its live proof seen), on date or
slipping with why and its new date, from `ship-plan.md` in the lead's notes folder. Bring
each decision as a card the human can decide from alone, asked in plain text (the picker guard refuses the question
picker), record each answer in the same turn with
`teamrig update <id> --decided --note "owner decided: <decision>" --session lead`, which takes the card off the agenda
at once and marks the task decided for its session (any new priority or date in a second `update`), then:

```sh
teamrig meeting end --session lead
```

Each session gets one inbox line saying the meeting ended, with the decisions on its tasks. The start counts as
asking the human the decisions it lists: `teamrig decisions` then holds only the waits set since and the asked ones
past due.

## Create a team and start its sessions

The lead's tab, with the user's request in hand:

```sh
teamrig team create shop --sessions api,web --dry-run
teamrig team create shop --sessions api,web
teamrig rules --session lead
teamrig add --session lead --owner api --priority p2 --title "Build the signup endpoint" --description "New users cannot sign up yet; take an email and a password and send the welcome mail."
teamrig add --session lead --owner web --priority p2 --title "Build the signup form" --description "The page for the new signup endpoint, with its errors shown under each field."
teamrig open api
teamrig open web
```

1. Show the user the dry run and get a yes before creating.
2. `rules` prints the team rules this tab did not get at its start.
3. Add one first task per session before opening it, so its first `list` has work.
4. `open` starts each session in a new terminal tab, already bound, with a first prompt that reads its inbox and
   list. If it prints `MANUAL`, show the user the printed command to run in a new terminal.

The bundled `team-setup` skill walks the lead through this, including splitting the work into sessions.

## Move part of a team into a child team

The lead's tab, once a few sessions work one area that needs a lead of its own:

```sh
teamrig team split front --lead web --sessions ui --dry-run
teamrig team split front --lead web --sessions ui
teamrig team tree
teamrig open front/web
teamrig open front/ui
```

1. Show the user the dry run's counts (tasks by status, links across the new border, inbox lines and files) and get
   a yes: the split moves stored data, and nothing undoes it.
2. Clear what `BLOCKED` names first: ask a staying session for the decision or approval a staying task waits on,
   and close each moved session's tab.
3. The split ends with `VERIFIED` once both task lists read the same; a `PROBLEM` line exits 1 and names the task.
4. Reopen each moved session from its new team, as the `NEXT` line says. Its start names the child team, its lead's
   approvals now come to you, and work you ask of it goes as `teamrig add --team front`.
