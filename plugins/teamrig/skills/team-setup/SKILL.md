---
name: team-setup
description: Use when the user wants work split across parallel Claude Code sessions or a part grown into a sub-team (propose, create, open each session), and at each lead checkpoint.
---

# Team setup

The user says what they want built; you turn it into a running team. This tab becomes the team's lead and stays open.

## 1. Read the request

From what the user wrote, work out:

- the sessions: one per part of the work that can go ahead on its own, usually 2 to 5. Each gets a short id of lowercase letters, digits and `-`, such as `api`, `web`, `tests`.
- each session's first task, in one line.
- the team id: a short id from the goal or the project, such as `signup`.
- the project: the folder this session started in, as an absolute path.

Ask only for what you cannot work out, in one question. If `teamrig who` lists sessions here, a team already exists: say so and offer `teamrig open <id>` for its sessions instead.

## 2. Propose once

Show the plan in a few lines, then ask one yes or no question:

```
Team signup, with this tab as the lead:
- api: build the signup endpoint
- web: build the signup form
- tests: write end-to-end tests for signup
Create it and open the three sessions?
```

If the user changes something, show the new plan and ask once more. Run nothing before a yes.

## 3. Create the team, in one Bash call

```
teamrig team create <team> --sessions <id>,<id> --project "<project>" && teamrig inbox read --session lead && teamrig rules --session lead
```

- `team create` writes the team config in the kit home and `.teamrig.json` in the project. A `REFUSED` line says why it stopped (another team has that id, or the project belongs to another team): tell the user and stop.
- `inbox read --session lead` ties this Claude Code session to the lead, so the team's hooks know this tab as the lead from now on.
- `rules --session lead` prints the team rules this tab did not get when it started. Follow them from now on.
- The lead plans and judges the whole team's work, so it runs on Opus at xhigh effort (`launch.lead` in the team config can change that). This tab was not started by teamrig: unless the user already chose them, ask them to type `/model opus` and `/effort xhigh` here.
- `$TEAMRIG_SESSION` is not set in this tab, so pass `--session lead` to every `teamrig` task and inbox command here.

## 4. Give each session its first task, then open it

One Bash call per session:

```
teamrig add --session lead --owner <id> --priority p2 --title "<first task>" --description "<what and why>" && teamrig open <id>
```

- `open` starts a new terminal tab in the project running Claude Code as that session. It reads its inbox and task list, then starts the task.
- Exit code 3, with a `MANUAL` line: no terminal could be opened from here. Show the user the printed command to paste into a new terminal in the project.
- A `REFUSED` line: tell the user why and stop.

## 5. Turn on the daily budget

The budget turns the week's tokens into a daily allowance for the team, so the work lasts until the weekly reset.
Ask the user in one AskUserQuestion call with these three questions, the recommended answer first:

- Daily allowance: `pace` (recommended): each midnight, what is left of the week spread over the days left. Offer a
  cap with it (`--max-daily <pct>`), so a slow start cannot pile up into one huge day. Or a fixed percent per day
  (`--daily <pct>`).
- Past the line, when a session goes over its share of the day while the team runs ahead of pace: `ask-lead`
  (recommended): the lead is told and decides; `warn`: a line only; `ask`: the user is asked before its helpers
  start. `block` refuses helper launches, an urgent fix's included: never recommend it.
- Quiet hours, when helpers do not start unasked: the user's own night (ask in their local time, then convert to
  UTC: 23:00-07:00 at UTC-5 is `04:00-12:00`) with `ask`, or none.

Preview in one Bash call and show the user the lines:

```
teamrig budget setup --session lead --daily pace --over ask-lead --quiet <HH:MM-HH:MM> --quiet-action ask
```

After a yes, run the same line with `--yes`. A `NOTE no status line reading yet` line means the hooks cannot see the
week's use: offer to run `teamrig statusline install`, which keeps a status line they already have (the guide's
[requirements](../teamrig-guide/requirements.md#the-status-line-optional)). Show its preview, and after a yes run
it with `--yes`; when Claude may not change its own settings, the user types `! teamrig statusline install --yes`.
If the user skips this step, say they can ask you to turn it on later.

## 6. Tell the user, in three short lines

```
Team <team> is up: <id>, <id> and <id> are working in their own tabs.
This tab is the lead: ask me for status, new tasks or changes.
Close a tab to stop that session; teamrig open <id> starts it again.
```

## 7. Grow a part of the work into a sub-team

When one part outgrows a single session, or the user asks for a team under this one, propose it as in step 2 (the
sub-team's id, its sessions and the part it takes on), then, after a yes, in one Bash call:

```
teamrig team create <sub-team> --sessions <id>,<id> --parent <team> --project "<project>" && teamrig add --session lead --team <sub-team> --priority p2 --title "<the part, in one line>" --description "<what and why>" && teamrig open <sub-team>/lead
```

- The sub-team gets its own lead and task list in the same project. Its lead splits the task among its sessions and
  opens them, and brings you the decisions that need the user: you stay the one lead the user talks to.
- `add --team` hands the task to the sub-team's lead only (it takes no `--owner`): work goes down the tree through
  each team's lead, and questions come back up the same way.
- `teamrig team tree` shows the teams, and `teamrig list --session lead --tree` the tasks of this team and every team
  under it. A tree is at most 3 levels deep, with at most 8 sub-teams under one team; `team create` says when a new
  one would break that.

## 8. Checkpoint: keep the team on its plan

At the start of each work block, and when the user asks for status, in one Bash call:

```
teamrig start --session lead
```

With sub-teams, run `teamrig check --tree --session lead` too. Act on each flag:

- `PRIORITY-SKIP`: a session works below its own waiting top-priority task. Send it one inbox line to park the lower
  task and start the waiting one (`teamrig inbox add --session lead --to <id> --text "..."`), or, when the order is
  wrong, change it: `teamrig update T<n> --session lead --priority p2`.
- `OFF-GOAL`: work in progress with no goal outside the week's plan. If it belongs in this week, plan it in:
  `teamrig update T<n> --session lead --week <week>`. If not, ask the session in one inbox line to tag its goal
  (`update --goals`, only its owner may) or to park it.
- `STOPGAP-DONE`: a stopgap's task is finished. Ask the owner of each file it lists, in one inbox line, to remove
  the stopgap; when the task was dropped, to open a new task for it or keep it by a decision.
- `NOT-PICKED-UP`: an idle session reads no inbox. Wake it with `teamrig open <id>`, or tell the user.
- `HIRE RETIRE-DUE`: a hired session has had no open task for `hiring.idleHours`. Give it its next task, or retire
  it: `teamrig retire <id> --session lead` (`--to <heir>` for any open task). To bring a retired one back, hire
  its id again: the hire shows whether its last Claude Code session can be resumed (`teamrig open <id> --resume`).
- `HIRE REVIEW-DUE`: a hired session's review day passed. Decide whether its job goes on; retire it when done.
- `OVERDUE` or `STALE`: ask the owning session what blocks it, then re-date it (`--due`) or tell the user.
- `READY`: a waiting task whose reasons have all cleared (its tasks finished, its time passed). Tell the owning
  session in one inbox line to go on.
- `VERIFY-OVERDUE`: a shipped change past its date to verify by. Ask the owning session whether the proof came: `done` with it,
  `in-progress` if it failed, or a new date.
- `VERIFY-BLOCKS`: work waits on a shipped change that is not proven yet. Ask the owning session in one inbox line
  to prove it (`done`) or reopen it (`in-progress`).
- `PILE-UP`: a session holds more verifying tasks than `register.maxVerifying`. Ask it to work its queue
  (`teamrig verify`) before new work.
- `OWNER-UNPLANNED` or `DUE-UNPLANNED`: plan it in with `--week`, or tell the user what it would push out.
- A skill flag: tell the skill's owner in one inbox line.

You may change a task's owner, priority, due date, week and plan order (`--after`); its status and goals are its owner's.

## Traps

- Do not write the team config or `.teamrig.json` by hand: `team create` checks both before it writes, and a repeat with the same team changes nothing.
- `teamrig team create ... --dry-run` prints what it would write and writes nothing.
- After `inbox read --session lead`, the next prompt titles this tab with the lead's name, and a `/clear` keeps that title, so the new Claude Code session it starts binds to the lead by itself. If its start note does not say the tab was bound, run `teamrig inbox read --session lead` again.
