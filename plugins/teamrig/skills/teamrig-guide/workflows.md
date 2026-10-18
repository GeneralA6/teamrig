# teamrig workflows

Each workflow is the exact sequence of commands, in the order to run them. The examples use team `shop`, with
the sessions `lead`, `api` and `web`; replace the ids with yours and pass `--session` unless `$TEAMRIG_SESSION`
is set.

## Start of a work block

At the start of each work block, after a `/clear`, and in any tab teamrig did not open:

```sh
teamrig start --session api
```

It prints the time, your unread inbox lines, your task list, the other sessions' tasks waiting on yours
(`WAITING ON YOU`, when some do), the `check` flags of your tasks and skills, and the week's use.

1. Read each inbox line. A line that asks for work should name a task id; if it does not, add the task yourself
   (`teamrig add --session api --title "..." --description "<what and why>" --priority p<n> --source <asker>`).
2. Take the first task of your list: lists are in plan order (priority, then effective due date, then id; a task
   that a dated task needs takes that earlier due, `due 10-17 (from T9)`).
3. Mark it started: `teamrig set T4 --session api --status in-progress`.
4. Before you start any work that is not on the list, add it: self-made work is a task too. Start it only for a
   goal, a parent task or the week plan, never ahead of your top task that is not waiting; a one-commit fix is
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

Never set another session's task status, and never do, integrate or fix another session's change: hand it to
its owner. A decision that belongs to the human (destructive data operations, product and design, permissions,
budget, resource changes) goes to the lead, never decided by silence.

## Ship a change

From the first edit to a change that runs, in this order (rules 2, 7, 14 and 16):

```sh
git worktree add ../shop-T4 -b t4-parser origin/main
teamrig test --session api -- npm test
```

1. Edit only in your own worktree and branch, made off the current main as above (or with Claude Code's
   EnterWorktree). A `node_modules` linked in from the main checkout (`mklink /J` on Windows) is removed in step 7.
2. Commit one logical change at a time, each with its tests, as soon as they pass. Run tests through
   `teamrig test`: a long run costs a few lines, and the whole output stays in a log. Over 400 changed lines or
   15 files, the commit needs a `Large-commit: <reason>` line.
3. Before you push: `git fetch`, rebase on the current main, and run the tests again.
4. Integrate by your team's own route: a pull request, a release script, or a push to main, which asks the human
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
machine, a number to measure), set it `verifying` with `--proof` naming that proof and `--due` the date to verify
it by:

```sh
teamrig set T4 --session api --status verifying --note "new parser merged" --proof "tonight's import runs clean on the new parser" --due 2026-10-17 --followups none
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
`task:T<id>` (a task to finish first) or `time:<YYYY-MM-DD HH:MM>` (UTC). Then move to your next task. It stays
waiting until every reason has cleared; `check` flags it `READY` once its tasks are done and its time has passed,
and a decision or an approval clears when you set the next status (`set --status in-progress`). A new decision or
approval wait posts the lead one inbox line; a decision for the human goes to the lead with the options, numbers
and your recommendation. A budget hold is a time (`time:<date>`), never an approval.

Work you need from another session is a task, never its approval. Ask for it and wait on it in one step:

```sh
teamrig set T4 --session web --status waiting --ask api --text "Return error codes from the login endpoint" --due 2026-10-16
```

It adds api's task (`ADDED T5 ...`, at T4's priority, its description naming T4), tells api, and sets T4 waiting on
T5.

A task reason is only for a task you already started. One not started that needs another first is not waiting:
it stays `open`, planned after it (`teamrig update T4 --after T5`), and its line shows `after T5`.

## Handover at high context

teamrig refreshes a long-running session at a turn end once its context is large, before Claude Code compacts it,
so it never loses work to a compaction.

1. At the end of every turn, the Stop hook measures your context. When it is at or over
   `refresh.contextTokens` (120,000 by default), at a task end after every third finished task with the context at 80,000 or more
   (`refresh.everyTasks`, `refresh.everyTasksMinTokens`), or the lead asked for a refresh (`teamrig refresh <id>`), it
   keeps you going with this instruction, once the background work you started (subagents, background commands,
   monitors, workflows) has all reported back:

   ```text
   teamrig: your context is 132k (refresh at 120k) and you just finished T2. Write your handover to <home>/teams/shop/handover/web.md: what the register lacks (the next step of each task in progress; what to check later, and when; questions still open with the user; the scratchpad files, plan file and scheduled jobs the next session still needs; where things are), not task statuses, which your fresh start reads live from the register. Then run `teamrig refresh --ready --session web`. Do not start new work.
   ```

   Mid-task it says `teamrig: your context is 132k (refresh at 120k), so refresh now rather than at a task end.`
   If you go on without the fresh start (the user typed), it asks again at your next task end, or once your
   context grew a fifth of `refresh.contextTokens` more.

2. Write the handover at that path, with what the register lacks: the next step of each task in progress, what to
   check later and when, questions still open with the user, the scratchpad files, plan file and scheduled jobs the
   next session still needs, and where things are (branches, worktrees, files, ids). Leave out task statuses, waits
   and due dates: the fresh start reads them live from the register (step 5), and a copy here could only go stale.
   It must be new: the old file left as it was is refused.
3. Run `teamrig refresh --ready --session web`. It prints `Ready. Ask the user to type /clear; your next start
   reads <path>.`. At the end of that turn the tab title becomes `shop-web: type /clear` (the session's name;
   `refresh.tabTitle: false` turns that off; with `tabStatus.enabled`, after the tab's state circle).
4. End your turn and start nothing new. The user types `/clear` once done with your screen, which a `/clear`
   wipes. With `refresh.autoRestart: true` the title reads `shop-web: restarting` instead: once the tab has been
   idle 15 s (`refresh.restartDelaySeconds`), teamrig's
   mod runs `/clear` in this tab, after asking Claude Code that no helper of yours still runs (it waits while one does); where it cannot, teamrig ends this Claude Code and starts it again, in the same
   tab when `teamrig open` started it, else in a new tab. While a background shell runs (a background command or
   a monitor), it ends nothing and your inbox says to type `/clear`, which keeps the shell.
   If the user sends a prompt first, the restart is cancelled and you keep this context. When the restart
   cannot start, the title reads `shop-web: type /clear`: ask the user to type `/clear`.
5. After the fresh start, the session-start context says `You were refreshed after T2; read your handover first:
   <path>`, then the scheduled jobs (still scheduled after a `/clear`, to make again after a new process), the
   wake-up to make again, the old scratchpad and the plan file, then your active tasks as the register holds them
   (`LIVE TASKS of web, ...`, at most 6 rows and `+N more`, then the other sessions' tasks waiting on you,
   `WAITING ON YOU`, at most 3; where the handover says otherwise, the register wins).
   A compaction gets the same task block, since its summary is older than the register too. The
   restart's first prompt, or after a `/clear` a turn teamrig starts by itself, asks you to read the handover and
   carry on with its next steps. Do so, and run the start of a work block, since the fresh start is a new Claude
   Code session.

The hook judges each finished task once and never loops. A team turns this off with `refresh.enabled: false`, and the task
count with `refresh.everyTasks: 0`. A `/clear`, a new process or a compaction starts the count over.

## Use a helper

Work in your own session by default. A helper (a subagent) keeps file dumps and long output out of your context,
but its tokens cost `budget.subagentWeight` times yours (one team measured about 2.2), so start one only when it
keeps far more than that out, or truly runs in parallel; never for a build or test whose result you need. A broad
read that returns a short answer is the case that pays. Pick who does a job, and on which model, by fit for the
task, never by its length. A helper starts with the team rules and knows it is yours: it
leaves task statuses, register entries and messages to you unless its brief asks for them, so say so in the brief
when it should.

1. Run the helper on your own model and effort: a cheaper one misses things the caller then builds on.
2. When others will build on its results, have it write its full findings (raw numbers, file and line, what it
   could not check) to a file, and return the path and a short summary, so nobody runs it again.
3. Let a helper start helpers of its own only when the task splits cleanly: a fan-out multiplies the cost.
4. Read only the lines you need from its file, never the whole of it, and never re-read a file you just wrote.

## Lead checkpoint

At the start of each work block, and whenever the human asks for status:

```sh
teamrig start --session lead
```

With sub-teams, run `teamrig check --tree --session lead` too. Then act on each flag (full table: [tasks.md](tasks.md#check-flags)):

- `PRIORITY-SKIP`: one inbox line to the owner to park the lower task and start the waiting one, or fix the order
  with `teamrig update T<n> --session lead --priority p2`.
- `OFF-GOAL`: if it belongs this week, `teamrig update T<n> --session lead --week <week>`; else ask the owner in
  one inbox line to tag its goal or park it.
- `STOPGAP-DONE`: one inbox line to the owner of each listed file to remove the stopgap (or, for a dropped task, to
  open a new task or keep it by a decision).
- `NOT-PICKED-UP`: the owner is idle and reads no inbox: wake it with `teamrig open <id>`, or tell the human.
- `HIRE RETIRE-DUE`: a hired session has had no open task for `hiring.idleHours`: give it its next task, or retire
  it (`teamrig retire <id> --session lead`, `--to <heir>` for any open task). Hiring, retiring and rehiring: the
  `hire` skill.
- `HIRE REVIEW-DUE`: a hired session's review day passed: decide whether its job goes on; retire it when done.
- `OVERDUE` or `STALE`: ask the owner what blocks it, then re-date it (`--due`) or tell the human.
- `READY`: a waiting task can go on: one inbox line to its owner, if it has not set the next status.
- `PEER-WAIT`: a task waits on a peer's approval or decision: one inbox line to its owner to wait on that work by
  its task (`set --status waiting --ask <session> --text "<the work>"`).
- `VERIFY-OVERDUE`: ask the owner whether the proof came: `done` with it, `in-progress` if it failed, or a new date.
- `VERIFY-BLOCKS`: work waits on a shipped change: one inbox line to its owner to prove it or reopen it.
- `LOOP`: tasks need each other in a circle, so none can finish: one inbox line to the first one's owner to make
  the step its own task (the flag prints the command), or re-plan it yourself (`update --after`).
- `PILE-UP`: a session ships faster than it proves: one inbox line asking it to work its queue (`teamrig verify`)
  before new work.
- `OVER-LIMIT`: the week's sized work passes the weekly limit left at this task: move it and the tasks after it to
  next week (`update --week`), or tell the human what it would cut.
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

Bring the human only what needs them: verified results, decisions taken, investigated questions (options,
numbers and a recommendation) and incidents. Progress and plans stay in the register.

## The owner's daily meeting

Once a day the lead meets the human. The `daily-meeting` skill has the steps; in short:

```sh
teamrig meeting start --session lead
```

It tells every session to hold its messages to the lead (a CRITICAL one still goes) and prints the agenda. Bring
each decision as a card the human can decide from alone, record each answer in the same turn with
`teamrig update <id> --note "owner decided: <decision>" --session lead` (and any new priority or date), then:

```sh
teamrig meeting end --session lead
```

Each session gets one inbox line saying the meeting ended, with the decisions on its tasks.

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
