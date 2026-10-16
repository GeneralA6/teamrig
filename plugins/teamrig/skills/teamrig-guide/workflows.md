# teamrig workflows

Each workflow is the exact sequence of commands, in the order to run them. The examples use team `shop`, with
the sessions `lead`, `api` and `web`; replace the ids with yours and pass `--session` unless `$TEAMRIG_SESSION`
is set.

## Start of a work block

At the start of each work block, after a `/clear`, and in any tab teamrig did not open:

```sh
teamrig start --session api
```

It prints the time, your unread inbox lines, your task list, the `check` flags of your tasks and skills, and the
week's use.

1. Read each inbox line. A line that asks for work should name a task id; if it does not, add the task yourself
   (`teamrig add --session api --title "..." --priority p<n> --source <asker>`).
2. Take the first task of your list: lists are in plan order (priority, then due date, then id).
3. Mark it started: `teamrig set T4 --session api --status in-progress`.
4. Before you start any work that is not on the list, add it: self-made work is a task too. Start it only for a
   goal, a parent task or the week plan, never ahead of your top task that is not waiting; a one-commit fix is
   exempt. A loop, cron or scheduled wake-up needs the lead's OK and a written stop (a time or a usage %).

If the session-start context said no session is set, ask the user which session you are (`teamrig who` lists
them) before running anything.

## Hand work to another session

When another session must do something, in one turn:

```sh
teamrig add --session api --owner web --priority p2 --title "Show the signup errors from the api" --due 2026-10-17 --ref "docs/errors.md"
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
   EnterWorktree). On Windows, a `node_modules` linked in from the main checkout (`mklink /J`) needs care in step 7.
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
7. Remove the worktree and its merged branch. On Windows, remove the `node_modules` link first (`cmd /c rmdir
   <worktree>\node_modules`; from Git Bash, `cmd //c`) and check it is gone, or `git worktree remove` empties the
   main checkout's. Never delete the worktree folder recursively.

Your team's own commands for steps 4 and 5 (a deploy script, a lock on shared machines) belong in a team skill such
as `team-ship-change`; this list is the order they fit in.

## Close a task with proof

1. Finish and verify: tests pass, the change is merged or deployed as the task needs, and you checked that it
   runs. If the change altered what code reads, writes or depends on, search for comments that still describe
   the old behaviour, in other files too, and fix them in the same commit.
2. If you had to work out a procedure you will run again, write or fix its skill now (see
   [tasks.md](tasks.md#skills)).
3. Set it done with the proof:

```sh
teamrig set T4 --session api --status done --note "signup endpoint merged and live" --evidence "commit 3f9c2ab, 41 tests pass, POST /signup 201" --skill api-release
```

```text
SET T4 done, p2, owner api, due 10-17, from lead, goals G1 | Build the signup endpoint
```

4. Tell whoever asked, if they wait on it: one inbox line, or a message if it unblocks them now.

The register refuses `done` without `--note`, without `--evidence` (unless the task already has some) or without
`--skill <name>|none`; a named skill must exist. When a task will not be done, set it `dropped` with a note saying
why and who decided.

## Shipped, verifying

When the change is merged or deployed but what proves it does not exist yet (a night's flow, a run on another
machine, a number to measure), set it `verifying` with `--proof` naming that proof and `--due` the date to verify
it by:

```sh
teamrig set T4 --session api --status verifying --note "new parser merged" --proof "tonight's import runs clean on the new parser" --due 2026-10-17
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

Name every reason, comma-separated: `decision:<who>` or `approval:<who>` (a session, or `owner` for the human),
`task:T<id>` (a task to finish first) or `time:<YYYY-MM-DD HH:MM>` (UTC). Then move to your next task. It stays
waiting until every reason has cleared; `check` flags it `READY` once its tasks are done and its time has passed,
and a decision or an approval clears when you set the next status (`set --status in-progress`). A decision for
the human goes to the lead with the options, numbers and your recommendation.

A task reason is only for a task you already started. One not started that needs another first is not waiting:
it stays `open`, planned after it (`teamrig update T4 --after T5`), and its line shows `after T5`.

## Handover at high context

teamrig refreshes a long-running session at a task boundary, so it never loses work to a mid-task compaction.

1. After a turn in which you set a task done, the Stop hook measures your context. When it is at or over
   `refresh.contextTokens` (120,000 by default), at every third finished task with the context at 80,000 or more
   (`refresh.everyTasks`, `refresh.everyTasksMinTokens`), or the lead asked for a refresh (`teamrig refresh <id>`), it
   keeps you going with this instruction, once the background work you started (subagents, background commands,
   monitors, workflows) has all reported back:

   ```text
   teamrig: your context is 132k (refresh at 120k) and you just finished T2. Write your handover to <home>/teams/shop/handover/web.md (what is in progress and the next step of each; what to check later, and when; questions still open with the user; the scratchpad files, plan file and scheduled jobs the next session still needs; where things are), then run `teamrig refresh --ready --session web`. Do not start new work.
   ```

2. Write the handover at that path: what is in progress and the next step of each, what to check later and when,
   questions still open with the user, the scratchpad files, plan file and scheduled jobs the next session still
   needs, and where things are (branches, worktrees, files, ids). It must be new: the old file left as it was is refused.
3. Run `teamrig refresh --ready --session web`. It prints `Ready. End your turn now: teamrig starts you fresh
   once you are idle, or asks the user to type /clear; your next start reads <path>.`. At the end of that turn
   the tab title becomes `shop-web: restarting` (the session's name; `refresh.tabTitle: false` turns that off).
4. End your turn and start nothing new. Once the tab has been idle 15 s (`refresh.restartDelaySeconds`), teamrig's
   mod runs `/clear` in this tab; where it cannot, teamrig ends this Claude Code and starts it again, in the same
   tab when `teamrig open` started it, else in a new tab. While a background shell runs (a background command or
   a monitor), it ends nothing and your inbox says to type `/clear`, which keeps the shell.
   If the user sends a prompt first, the restart is cancelled and you keep this context. When the restart is off
   (`refresh.autoRestart: false`) or cannot start, the title reads `shop-web: type /clear`: ask the user to type
   `/clear`.
5. After the fresh start, the session-start context says `You were refreshed after T2; read your handover first:
   <path>`, then the scheduled jobs (still scheduled after a `/clear`, to make again after a new process), the
   wake-up to make again, the old scratchpad and the plan file. The
   restart's first prompt, or after a `/clear` a turn teamrig starts by itself, asks you to read the handover and
   carry on with its next steps. Do so, and run the start of a work block, since the fresh start is a new Claude
   Code session.

The hook judges each finished task once and never loops. A team turns this off with `refresh.enabled: false`, and the task
count with `refresh.everyTasks: 0`. A `/clear`, a new process or a compaction starts the count over.

## Use a helper

A helper (a subagent) keeps file dumps and long output out of your context. Pick who does a job, and on which
model, by fit for the task, never by its length.

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
- `OVERDUE` or `STALE`: ask the owner what blocks it, then re-date it (`--due`) or tell the human.
- `READY`: a waiting task can go on: one inbox line to its owner, if it has not set the next status.
- `VERIFY-OVERDUE`: ask the owner whether the proof came: `done` with it, `in-progress` if it failed, or a new date.
- `VERIFY-BLOCKS`: work waits on a shipped change: one inbox line to its owner to prove it or reopen it.
- `PILE-UP`: a session ships faster than it proves: one inbox line asking it to work its queue (`teamrig verify`)
  before new work.
- `OWNER-UNPLANNED` or `DUE-UNPLANNED`: plan it in with `--week`, or tell the human what it would push out.
- A `SKILL` flag: tell the skill's owner in one inbox line.

The lead may change a task's owner, priority, due date and week; its status and goals are its owner's. To plan a
week, tag its tasks with `--week <first day>` and print it with `teamrig plan --session lead`; plan from that
output, never from memory.

Every order of the human's that creates work becomes a task in the same turn, added by the lead when it relays
the order, with the owner's source [register.ownerSource]:

```sh
teamrig add --session lead --owner api --source owner --priority p2 --title "Rate-limit the signup endpoint"
```

Bring the human only what needs them: verified results, decisions taken, investigated questions (options,
numbers and a recommendation) and incidents. Progress and plans stay in the register.

## Create a team and start its sessions

The lead's tab, with the user's request in hand:

```sh
teamrig team create shop --sessions api,web --dry-run
teamrig team create shop --sessions api,web
teamrig rules --session lead
teamrig add --session lead --owner api --priority p2 --title "Build the signup endpoint"
teamrig add --session lead --owner web --priority p2 --title "Build the signup form"
teamrig open api
teamrig open web
```

1. Show the user the dry run and get a yes before creating.
2. `rules` prints the team rules this tab did not get at its start.
3. Add one first task per session before opening it, so its first `list` has work.
4. `open` starts each session in a new terminal tab, already bound, with a first prompt that reads its inbox and
   list. If it prints `MANUAL`, show the user the printed command to run in a new terminal.

The bundled `team-setup` skill walks the lead through this, including splitting the work into sessions.
