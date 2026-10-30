# Plan the week

A team shares one weekly usage limit. teamrig plans the week against it and paces each day, so the work fits and no
session runs dry mid-task: the lead tags and sizes the week's tasks, `teamrig budget` reads each session's use
against the week's pace line, and a burst spends what the week would leave unused. Each feature's keys in the
[team config](../configuration.md) set what it does.

- [The week plan](#the-week-plan)
- [The daily budget](#the-daily-budget)
- [Bursts](#bursts)

Every command is in [commands](../../plugins/teamrig/skills/teamrig-guide/commands.md), and what each hook does in
[hooks and permissions](../../plugins/teamrig/skills/teamrig-guide/hooks.md).

## The week plan

A week is named by the date of its first day. The lead tags the tasks the team will do that week, and sizes each
one: what it still costs, in percent of the weekly usage limit. Only the lead and a task's owner change its week.

```sh
teamrig update T4 --week 2026-10-26 --size 1.5   # in the week of 10-26, 1.5% of the weekly limit left to spend
teamrig plan                                       # the week in force, grouped by priority, and whether it fits
```

- What fits: `plan` sums the sized to-do tasks (open, in progress or waiting; a verifying task's spend is already
  used) in plan order against what is left of `budget.targetPct` (99.5% by default) after the week's use, read
  from the newest status line: `fits: p1 12% · p2 8.5% (left 31% of the week)`. It names the first task past that
  line, which `check` flags `OVER-LIMIT`, and how many have no size. The last `budget.reservePct` (0.5%) is kept
  for incidents. With `--tree`, the lead sees one fit over every team under it, as one account limit covers them.
- What drifts: `check` compares the active tasks with the plan. An owner's order not in it is `OWNER-UNPLANNED`,
  a task due inside the week but not in it `DUE-UNPLANNED`, work in progress with no goal outside it `OFF-GOAL`,
  and a task that cost more than twice its size, as the budget meter attributes it, `OVER-SIZE`.

More in [week plans](../../plugins/teamrig/skills/teamrig-guide/tasks.md#week-plans).

## The daily budget

The week is paced, not rationed by hand. `teamrig budget` measures each session's use from the Claude Code
transcripts in W, weighted tokens (a helper's at `budget.subagentWeight`), and shows the week against its pace
line, from the newest status line reading ([teamrig statusline](../../plugins/teamrig/skills/teamrig-guide/commands.md#teamrig-statusline)):

```text
Week: 31.0% used at 12:00 IDT (status line); the pace line is at 28.6%: 2.4 points ahead. Resets Wed 10-21 04:00 IDT.
```

- The pace line climbs to `budget.targetPct` by `budget.paceEndHoursBeforeReset` (1) hours before the reset. Each
  day, what is left to it is spread over the active time to the pace end, and each session's daily budget is its
  part of the team's, by its share and its queued work.
- No session waits while the team has room: everyone's use today, the use outside the team included, below the
  team's in-day pace. With `budget.enabled` on, the Stop hook shows a Budget line as a session passes each of
  `budget.warnAtPct` (80 and 100) of its daily budget, then every 25 points more; once the team has no room left
  today, the lead is told.
- Past its part once the team has no room, a session is held: only p0 work wakes it or keeps its idle tab open, and
  its helper launches can be held too ([the daily budget](../../plugins/teamrig/skills/teamrig-guide/hooks.md#the-daily-budget-warnings-and-the-helper-gate)).
- A leader moves budget for a day: `teamrig budget lift` gives one session, or a sub-lead's group, a part of its
  parent's daily budget until a stop % (at most `budget.lift.maxStopPct`, 99.3), the end of the day or `--until`;
  the lead also tops up a session of a team under its own, `<team>/<session>`, from its own team's daily budget.
  `--part` is a percent of that parent's daily budget, not of the week: the `LIFTED` line and the lifts table in
  `teamrig budget` give the share of the week it comes to now.
- On a short day, when the week's use is past its pace line so what is left gives the day less than the line plans,
  every session keeps its part by default. With `budget.pauseByPriority` on, the day funds the work in priority order
  instead, across every team on the Claude account: the lead, the coordinator owner and lifted sessions first, then
  the queued work p0 first, idle sessions last. A session none of it reaches gets a daily budget of 0, marked
  `(paused)`, and is held once the team has no room; a burst's floor still holds it up.
- Past 100% of the week, the extra usage put in on claude.ai is entered with `teamrig budget extra` and spread over
  the days left the same way.
- Where the W went: `budget --task T<n>` gives each session's W on one task, `--burn` each day's sources (the
  owner, peer messages, notifications, scheduled wakes, subagents), `--loops` the costly loop patterns and
  `--misses` the rule misses per session.

## Bursts

A burst is a time-boxed scale-out for when the week will end with tokens unspent, or work must land by a time.
For its time, each session in it gets a daily budget of at least the burst's floor and may run more helpers at
once; the lead may also hire sessions for it. The same gates hold as on any other day. Like the team's daily
budget, the floor is never fixed: at every reading, what is left to the burst's stop % is spread over the active
time to the burst's end by the same pace rule, and its sessions share today's part evenly, so a burst that spends
fast gives less a day and one that spends slowly gives more. The floor at its start is kept in its record.

- Who starts one: a person, by command, never a hook. `teamrig burst` shows the week, its projected surplus and
  what to run; `teamrig burst start surplus|deadline --reason "<why>"` previews the burst, and `--yes` starts it.
  `burst.policy` is `owner` by default (each burst names its approver with `--approved-by`, since spending more of
  the week is a budget call; a child team's lead asks its parent team's lead, who takes it to the owner), `lead`, or `off`. No value starts a burst by itself; the lead's hook only suggests
  one, once a week, when the surplus is worth it.
- A surplus burst covers the whole team (or `--sessions`) from `burst.surplusHours` (48) before the reset until the
  pace end, once the team's part of the week projected unused is at least `burst.minSparePct` (5%). The account's
  spare is the use so far plus the week's mean rate so far, nights included, until the pace end, against
  `budget.targetPct`; teams sharing the Claude account split it by weight as they split the daily budget (each
  session's share times its queued work, summed per team, lifts included), so a lift inside one team moves no spare
  between teams. A burst's daily floor is not split: it is a share of what the account has left to the stop %,
  which the other teams' use already lowers.
- A deadline burst covers the owners of its `--task` tasks (or `--sessions`) until `--by`, at the latest the reset,
  and needs a `--stop-pct`.
- Its bounds: the stop % is at most `budget.targetPct`, so a burst never spends the incident reserve; it ends at its
  time, when the week reaches its stop %, or by `teamrig burst end --reason "<why>"`. It runs up to `--helpers`
  (`burst.maxHelpers`, 3) at once per session and `--hires` hired sessions (`burst.maxHires`, 2; none unless set).
  Quiet hours still apply, and a lift wins over it for its session.
- How its sessions work: the model is told once, with the next prompt, to split only independent tasks, to give
  each edit in a repo its own worktree, to merge one change at a time, to keep its model and effort for its
  helpers and never to skip a test or check. A burst hire runs on the lead's model at no lower effort.
- Its log: each start and end is a line in `state/usage/bursts.jsonl`; `teamrig budget` marks a session's budget
  "(burst)" and names the burst, and `check` flags its hires RETIRE-DUE once it is over.
