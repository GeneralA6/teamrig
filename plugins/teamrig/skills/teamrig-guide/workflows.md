# teamrig workflows

Each workflow is the exact sequence of commands, in the order to run them. The examples use team `shop`, with
the sessions `lead`, `api` and `web`; replace the ids with yours and pass `--session` unless `$TEAMRIG_SESSION`
is set.

## Start of a work block

At the start of each work block, after a `/clear`, and in any tab teamrig did not open:

```sh
teamrig inbox read --session api && teamrig list --session api
```

1. Read each inbox line. A line that asks for work should name a task id; if it does not, add the task yourself
   (`teamrig add --session api --title "..." --priority p<n> --source <asker>`).
2. Take the first task of your list: lists are in plan order (priority, then due date, then id).
3. Mark it started: `teamrig set T4 --session api --status in-progress`.
4. Before you start any work that is not on the list, add it: self-made work is a task too.

If the session-start context said no session is set, ask the user which session you are (`teamrig who` lists
them) before running anything.

## Hand work to another session

When another session must do something, in one turn:

```sh
teamrig add --session api --owner web --priority p2 --title "Show the signup errors from the api" --due 2026-10-17 --ref "docs/errors.md"
teamrig inbox add --session api --to web --text "T5: signup error codes are ready in docs/errors.md; please show them on the form"
```

1. Add the task with `--owner <their id>`. The register refuses a duplicate of an active task: then point at
   the existing id instead.
2. Tell them. Not urgent: one inbox line naming the task id (shown at their next prompt). Urgent, or they are
   blocked on it now: a message to the name `teamrig who` prints, at most 10 lines, ending with "No reply needed"
   or "Reply needed: <one question>".
3. If you are blocked until they finish, set your own task blocked with what you wait for:
   `teamrig set T4 --session api --status blocked --note "waiting for T5 (web)"`.

Never set another session's task status, and never do, integrate or fix another session's change: hand it to
its owner. A decision that belongs to the human (destructive data operations, product and design, permissions,
budget, resource changes) goes to the lead, never decided by silence.

## Close a task with proof

1. Finish and verify: tests pass, the change is merged or deployed as the task needs, and you checked that it
   runs.
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

## Blocked

```sh
teamrig set T4 --session api --status blocked --note "waiting for the database decision from the human"
```

Then move to your next task. When the block clears, `set --status in-progress` again. A block that needs the
human goes to the lead with the options, numbers and your recommendation.

## Handover at high context

teamrig refreshes a long-running session at a task boundary, so it never loses work to a mid-task compaction.

1. After a turn in which you set a task done, the Stop hook measures your context. When it is at or over
   `refresh.contextTokens` (250,000 by default), or the lead asked for a refresh (`teamrig refresh <id>`), it
   keeps you going with this instruction:

   ```text
   teamrig: your context is 262k (refresh at 250k) and you just finished T2. Write your handover to <home>/teams/shop/handover/web.md (what is in progress, the next step of each, open questions, where things are), then run `teamrig refresh --ready --session web`. Do not start new work.
   ```

2. Write the handover at that path: what is in progress, the next step of each, open questions, where things
   are (branches, worktrees, files, ids). It must be new: the old file left as it was is refused.
3. Run `teamrig refresh --ready --session web`. It prints `Ready. Ask the user to type /clear; your next start
   reads <path>.`. At the end of that turn the tab title becomes `shop-web: type /clear` (the session's name;
   `refresh.tabTitle: false` turns that off).
4. Ask the user to type `/clear`. Start nothing new.
5. After the clear, the session-start context says `You were refreshed after T2; read your handover first:
   <path>`. Read it, then run the start of a work block, since a cleared tab is a new Claude Code session.

The hook judges each finished task once and never loops. A team turns this off with `refresh.enabled: false`; on a
200k context window, set `refresh.contextTokens` to about 150,000.

## Lead checkpoint

At the start of each work block, and whenever the human asks for status:

```sh
teamrig inbox read --session lead && teamrig check --session lead
```

With sub-teams, add `--tree` to `check`. Then act on each flag (full table: [tasks.md](tasks.md#check-flags)):

- `PRIORITY-SKIP`: one inbox line to the owner to park the lower task and start the waiting one, or fix the order
  with `teamrig update T<n> --session lead --priority p2`.
- `OFF-GOAL`: if it belongs this week, `teamrig update T<n> --session lead --week <week>`; else ask the owner in
  one inbox line to tag its goal or park it.
- `NOT-PICKED-UP`: the owner is idle and reads no inbox: wake it with `teamrig open <id>`, or tell the human.
- `OVERDUE` or `STALE`: ask the owner what blocks it, then re-date it (`--due`) or tell the human.
- `OWNER-UNPLANNED` or `DUE-UNPLANNED`: plan it in with `--week`, or tell the human what it would push out.
- A `SKILL` flag: tell the skill's owner in one inbox line.

The lead may change a task's owner, priority, due date and week; its status and goals are its owner's. To plan a
week, tag its tasks with `--week <first day>` and print it with `teamrig plan --session lead`.

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
