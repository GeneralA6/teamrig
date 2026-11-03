---
name: team-setup
description: Use to split work across parallel Claude Code sessions or a sub-team (propose, slim the setup, create, open), to settle local rules that override teamrig, and at each lead checkpoint.
---

# Team setup

The user says what they want the team to do, and you turn it into a running team. It can be any work, not only building software: research, writing, analysis, a migration, an audit, running operations. This tab becomes the team's lead and stays open.

## 1. Ask what they want to do, then read the request

If the user asked for a team without saying what it is for, ask first, in one question, and wait for the answer: "What do you want the team to do?" Never assume they want something built.

From what the user wrote, work out:

- the sessions: one per part of the work that can go ahead on its own, usually 2 to 5. Each gets a short id of lowercase letters, digits and `-` named after its part, such as `research`, `api`, `writeup`.
- each session's first task, in one line.
- the team id: a short id from the goal or the project, such as `pricing`.
- the project: the folder this session started in, as an absolute path.

Ask only for what you cannot work out, in one question. If `teamrig who` lists sessions here, a team already exists: say so and offer `teamrig open <id>` for its sessions instead.

## 2. Propose once

Show the plan in a few lines, then ask one yes or no question:

```
Team pricing, with this tab as the lead:
- research: gather competitors' plans and prices
- analysis: model three price points against last year's sales
- writeup: draft the recommendation, with the numbers behind it
First I back up your Claude setup and show what slimming it would save; you choose what changes.
Create it and open the three sessions?
```

If the user changes something, show the new plan and ask once more. Run nothing before a yes.

## 3. Back up the Claude setup, then slim it

Every session of the team loads the user's Claude setup (the CLAUDE.md and rules files, memory's index, the skill
listing) at its start and carries it in every turn, so a lean setup saves tokens in each of them. Back it up before
anything changes, then scan it, in one Bash call:

```
teamrig setup backup --project "<project>" && teamrig setup scan --project "<project>"
```

- `BACKED UP <n> file(s) ... to <folder>`: the folder's last part is the backup's stamp, such as
  `20261025T120000Z`. No `BACKED UP` line: tell the user why, change nothing in their setup, and go on to step 4.
  The backup keeps the team's own skills folder too (a `team-skills` line), which the slimming below edits.
- The scan's second line names the backup that undoes the slimming: `BACKUP <stamp>, made <age> ago`. It reads
  `NO BACKUP of this setup` instead: change nothing in their setup, tell the user, and go on to step 4.
- The scan only reads. Show the user its `TOTAL` line (what every session start costs) and each group of findings
  with its count and the tokens a turn it saves, in a few lines, with what you propose for it:
  - `CONTEXT` (`C<n>`), a file loaded every turn over 6,000 chars or a skill description over 250: shorten it, and
    move rules that matter only in some folders into `.claude/rules/<topic>.md` with a `paths:` frontmatter, or
    into the `CLAUDE.md` of the sub-folder they are about, so they load only there.
  - `DUPLICATE` (`D<n>`), a line that repeats one loaded before: keep the first, remove the repeat.
  - `UNUSED` (`U<n>`), a skill no transcript or `/skill-doctor` saw used in 30 days: park its folder in
    `skills-parked/` beside the `skills/` folder it is in. Claude Code no longer lists it; moving it back brings it
    back. A `U` line naming `plugin:skill (source)` has no folder to park: the user turns it off in `/skills`. An
    `unused-agent` line: park the agent file in `agents-parked/` beside its `agents/` folder. An
    `other-project-skill` or `other-project-agent` line names the projects whose sessions used it: move it out of
    the user's folder into their `.claude/skills` or `.claude/agents` (a copy in each).
  - `OVERRIDE` and `SETTINGS` need the team: step 7 settles those rule lines and the wide allow rules. Name them
    now and change nothing yet.
- Ask one yes or no per group in AskUserQuestion (up to 4 per call): what changes, in which files, and the tokens
  a turn it saves. No `CONTEXT`, `DUPLICATE` or `UNUSED` finding: say so in one line and go on to step 4.
- Carry out each yes: write the shortened or moved text with the Edit tool, and park or move a skill or agent type with Bash `mv` (`cp` first for each extra project).
  Change only the files its findings name, and never a settings file's `autoMode` line.
- Run `teamrig setup scan --project "<project>"` again and tell the user, in two lines, the `TOTAL` before and
  after, and that `teamrig setup restore <stamp>` shows what undoing it writes and the same with `--yes` puts every
  backed-up file back.

## 4. Create the team, in one Bash call

```
teamrig team create <team> --sessions <id>,<id> --project "<project>" && teamrig inbox read --session lead && teamrig rules --session lead
```

- `team create` writes the team config in the kit home and `.teamrig.json` in the project, and keeps `.teamrig.json` out of git in this clone (its `ADDED` line names the repository's `.git/info/exclude`, which git never commits). The file names a team that exists on this machine only, and sessions find the team without it in git, so never offer to commit it. An `UNCHANGED … in git: it is committed` line means the repository already has it: tell the user what that line says. A `REFUSED` line says why it stopped (another team has that id, or the project belongs to another team): tell the user and stop.
- Your first task: `team create` adds `Set up the team` to the task list, owned by you and in progress, so the setup shows in the task pane and the register like any work. Its `ADDED T<n>` line gives the id; an `UNCHANGED T<n> Set up the team` line means an earlier run added it. You close it in step 8. No such line: the team already had tasks, so there is none to close.
- Tab status: `team create` turns on the colored circle before each tab's title for what its session is doing. A `TAB STATUS on` line means the tabs show it. A `NOTE` line names what is missing: show the user the exact `env` line, the settings file it goes in and that Claude Code needs a restart, as the line says. That switch changes every Claude Code tab, also outside this team, so never edit the settings yourself unless the user asks.
- `inbox read --session lead` ties this Claude Code session to the lead, so the team's hooks know this tab as the lead from now on.
- `rules --session lead` prints the team rules this tab did not get when it started. Follow them from now on.
- The lead plans and judges the whole team's work, so it runs on Opus at xhigh effort (`launch.lead` in the team config can change that). This tab was not started by teamrig: unless the user already chose them, ask them to type `/model opus` and `/effort xhigh` here.
- `$TEAMRIG_SESSION` is not set in this tab, so pass `--session lead` to every `teamrig` task and inbox command here.

## 5. Give each session its first task, then open it

One Bash call per session:

```
teamrig add --session lead --owner <id> --priority p2 --title "<first task>" --description "<what and why>" && teamrig open <id>
```

- `open` starts a new terminal tab in the project running Claude Code as that session. It reads its inbox and task list, then starts the task.
- Exit code 3, with a `MANUAL` line: no terminal could be opened from here. Show the user the printed command to paste into a new terminal in the project.
- A `REFUSED` line: tell the user why and stop.

## 6. Turn on the daily budget

The budget turns what is left of the week into a daily budget for the team, recomputed at every reading, so the work
lasts until the weekly reset; there is no daily number to choose. Ask the user in one AskUserQuestion call with these
two questions, the recommended answer first:

- Past the line, when a session goes over its share of the day while the team runs ahead of pace: `ask-lead`
  (recommended): the lead is told and decides; `warn`: a line only; `ask`: the user is asked before its helpers
  start. `block` refuses helper launches, an urgent fix's included: never recommend it.
- Quiet hours, when helpers do not start unasked: the user's own night (ask in their local time, then convert to
  UTC: 23:00-07:00 at UTC-5 is `04:00-12:00`) with `ask`, or none.

Preview in one Bash call and show the user the lines:

```
teamrig budget setup --session lead --over ask-lead --quiet <HH:MM-HH:MM> --quiet-action ask
```

After a yes, run the same line with `--yes`. A `NOTE no status line reading yet` line means the hooks cannot see the
week's use: offer to run `teamrig statusline install`, which keeps a status line they already have (the guide's
[requirements](../teamrig-guide/requirements.md#the-status-line-optional)). Show its preview, and after a yes run
it with `--yes`; when Claude may not change its own settings, the user types `! teamrig statusline install --yes`.
If the user skips this step, say they can ask you to turn it on later.

## 7. Settle the local rules that override teamrig

The core rules win over a CLAUDE.md, a rules file, a skill, memory, a hook's text and the team's `rules.md`, except
the local rules the user keeps. A local line that says otherwise still sits in every session's context and pulls
it the other way, so settle each one with the user now, and again whenever they ask.

1. List the places and the lines to judge, in one Bash call: `teamrig rules scan`.
   - `CANDIDATE <path>:<line> [<rules>] <text>` is a line whose words touch a core rule. A word list finds a
     topic, never a meaning, so most candidates are not conflicts: judging them is your part.
   - `NEXT ... too many to judge in one read`: list them a kind at a time (`teamrig rules scan --kind memory`).
     With several large kinds, give each kind to a helper on your own model and effort that returns only the
     conflicting lines, each with its path:line, the rule and how they differ.
2. Judge each candidate against the core rule it names. It conflicts when it tells a session to do otherwise: a
   push or deploy route the rule forbids, skipping the register, its own precedence ("our CLAUDE.md wins"). A line
   that adds detail or agrees is no conflict: leave it out. A line that asks the opposite of a teamrig skill's step
   ("plain text, never the picker" against a skill that asks with the picker), or more than the core rule asks, is
   an override, a conflict too: never cut it as covered. Cut a local line as covered only when a core line of the
   same strength says the same. Then, before editing any file, record the rest as no
   conflict with the command the scan's last line names, `--except` listing each conflict:
   `teamrig rules clear --seen <digest> --except <path>:<line>,... --session lead --yes` (with the scan's
   `--kind`). The next scan then lists only new or changed lines.
3. Show the user the conflicts, each as `<path>:<line>`, its text, what the core rule asks and how they differ. The
   user has not read teamrig's rules, so say what each one asks in plain words, from the core rules in your context
   (`teamrig rules` prints them): never name a rule by its number alone. None: say so in one line and go on.
4. Ask about each in AskUserQuestion (up to 4 per call). The question says what the line asks and what teamrig asks
   instead, in plain words: "CLAUDE.md:12 says to push straight to main. teamrig has each session edit in its own
   worktree and branch, and asks you before each push to main. Which should apply?". The choices, the recommended
   one first:
   - Remove it, and teamrig's rule applies (recommended).
   - Keep it, and it wins over the rule: the core rules then name it as an exception.
   - Keep the text, but teamrig's rule wins. Warn the user that the line still sits in every session's context
     and a session may follow it, so this may not always hold; removing or rewriting it is safer.
   - Rewrite it: propose a text that agrees with the core rule, and show it before you write it.
5. Carry out each answer:
   - Remove or rewrite: edit the line in its file. A settings file's `autoMode` line, never edit: give the user
     the line to change, the file and its line, to paste themselves. A hook script's text: name the script and
     the line to the user.
   - Keep: preview `teamrig rules keep <path>:<line> --rule <n> --wins local --reason "<why>" --session lead`
     (`--wins teamrig` for the third choice), then run it with `--yes`. The team keeps at most 40.
6. Run `teamrig rules scan` again: no conflict should be left outside the `RECORDED` lines. A `GONE` line, whose
   text is no longer there: `teamrig rules forget <n> --session lead --yes`.
7. Step 3's scan had a `SETTINGS` finding of allow rules that approve a whole tool or program: run
   `teamrig permissions trim` and show the user its preview. A permissions change is theirs to make, so after a yes
   they type `! teamrig permissions trim --yes`; it backs up each file it rewrites first.

## 8. Close the setup task, then tell the user, in three short lines

Every session now runs its first task, so the setup is done. Close it with the id from step 4 and the first tasks of step 5:

```
teamrig set T<n> --session lead --status done --note "team set up: <ids> working" --evidence "<first task ids> open in their tabs" --skill none --followups <first task ids, comma-separated>
```

```
Team <team> is up: <id>, <id> and <id> are working in their own tabs.
This tab is the lead: ask me for status, new tasks or changes.
Close a tab to stop that session; teamrig open <id> starts it again.
```

## 9. Grow a part of the work into a sub-team

When one part outgrows a single session, or the user asks for a team under this one, propose it as in step 2 (the
sub-team's id, its sessions and the part it takes on), then, after a yes, in one Bash call:

```
teamrig team create <sub-team> --sessions <id>,<id> --parent <team> --project "<project>" && teamrig add --session lead --team <sub-team> --priority p2 --title "<the part, in one line>" --description "<what and why>" && teamrig open <sub-team>/lead
```

- The sub-team gets its own lead and task list in the same project. Its lead splits the task among its sessions and
  opens them, and brings you the decisions that need the user: you stay the one lead the user talks to.
- `add --team` without `--owner` hands the task to the sub-team's lead, who splits it. Any session of the tree may ask
  any team of it the same way, `--owner` naming one of its sessions; that team's lead gets a copy line and may reorder
  or reassign it. The line when the task is done or dropped goes back to the session that asked.
- `teamrig team tree` shows the teams, and `teamrig list --session lead --tree` the tasks of this team and every team
  under it. A tree is at most 3 levels deep, with at most 8 sub-teams under one team; `team create` says when a new
  one would break that.

## 10. Checkpoint: keep the team on its plan

At the start of each work block, and when the user asks for status, in one Bash call:

```
teamrig start --session lead
```

With sub-teams, run `teamrig check --tree --session lead` too. Act on each flag:

- `PRIORITY-SKIP`: a session works below its own waiting top-priority task. Send it one inbox line to park the lower
  task and start the waiting one (`teamrig inbox add --session lead --to <id> --text "..."`), or, when the order is
  wrong, change it: `teamrig update T<n> --session lead --priority p2`.
- `SELF-MADE`: a session added more tasks for itself in 24 h than `register.check.maxSelfMadePerDay`. Read them
  (`teamrig list --session <id> --source <id> --status all`), then ask it in one inbox line to drop or park each
  that serves no goal, parent task or week plan; when it repeats a step with no progress, to stop and ask you.
- `OFF-GOAL`: work in progress with no goal outside the week's plan. If it belongs in this week, plan it in:
  `teamrig update T<n> --session lead --week <week>`. If not, ask the session in one inbox line to tag its goal
  (`update --goals`, only its owner may) or to park it.
- `NO-PROGRESS`: a day ended with no goal or week-plan task moved, and the week has usage left. Ask the owner of
  the task it names, in one inbox line, to move it or the next planned task it can; when something holds the plan (a
  blocker, the order, a plan to re-cut), fix it or tell the human.
- `STOPGAP-DONE`: a stopgap's task is finished. Ask the owner of each file it lists, in one inbox line, to remove
  the stopgap; when the task was dropped, to open a new task for it or keep it by a decision.
- `NOT-PICKED-UP`: an idle session reads no inbox. Wake it with `teamrig open <id>`, or tell the user.
- `HIRE SCALE-OUT`: an area cannot finish its dated work in time, and the week's spare pays for help. Do what it
  says: move its slice to the idle hire it names, else hire for the slice and move it, else bring the owner a card
  for the cap that blocks (the `hire` skill).
- `HIRE RETIRE-DUE`: the burst a hired session was hired for is over. Give it its next task, or retire
  it: `teamrig retire <id> --session lead` (`--to <heir>` for any open task). To bring a retired one back, hire
  its id again: the hire shows whether its last Claude Code session can be resumed (`teamrig open <id> --resume`).
- `HIRE REVIEW-DUE`: a hired session's review day passed. While the team still needs it, keep it to a new review
  day (`teamrig hire <id> --review <YYYY-MM-DD> --reason "<why>" --session lead --yes`), else retire it.
- `OVERDUE` or `STALE`: ask the owning session what blocks it, then re-date it (`--due`) or tell the user.
- `READY`: a waiting task whose reasons have all cleared (its tasks finished, its time passed). Tell the owning
  session in one inbox line to go on.
- `VERIFY-OVERDUE`: a shipped change past its date to verify by. Ask the owning session whether the proof came: `done` with it,
  `in-progress` if it failed, or a new date.
- `VERIFY-BLOCKS`: work waits on a shipped change that is not proven yet. Ask the owning session in one inbox line
  to prove it (`done`) or reopen it (`in-progress`).
- `LOOP`: tasks that need each other in a circle, so none can finish. Ask the first one's owning session in one
  inbox line to make the step its own task (the flag prints the command), or re-plan it yourself (`update --after`).
- `PILE-UP`: a session holds more verifying tasks than `register.maxVerifying`. Ask it to work its queue
  (`teamrig verify`) before new work.
- `REPARKED`: a task's proof was put off to other waits `register.maxReparks` times. Ask its owner to run the
  proof now (`done`), close it `done` with `--watch` if tests or a dry run proved it, or reopen it (`in-progress`).
- `OVER-PACE`: a session holds more unfinished p1 tasks than the p1 it finished in the last 7 days, past the first p1, which is in hand. Lower the p1s
  its pace will not reach (`update --priority`), hand some to another session, or tell the user what is held.
- `OVER-LIMIT`: the week's sized work passes the weekly limit left at this task. Move it and the tasks after it to
  next week (`update --week`), or tell the user what it would cut.
- `OVER-SIZE`: a task cost more than twice its size since it was last sized. Ask its owner in one inbox line to
  re-size what is left (`update --size`, which counts from then on), split the rest into its own task, or drop it; `teamrig budget --task <id>` shows where it went.
- `OWNER-UNPLANNED` or `DUE-UNPLANNED`: plan it in with `--week`, or tell the user what it would push out.
- A skill flag: tell the skill's owner in one inbox line.

A lesson a session reports (a miss that will happen again) is routed by its numbers: measure it, sort it
(would a team doing any other work hit it?), and see that its task names a form, the first that fits of a
mechanism, a skill or a rule line, with its numbers as config defaults. Steps:
[Turn a lesson into a fix](../teamrig-guide/workflows.md#turn-a-lesson-into-a-fix).

You may change a task's owner, priority, due date, week and plan order (`--after`); its status and goals are its owner's.

## Traps

- Do not write the team config or `.teamrig.json` by hand: `team create` checks both before it writes, and a repeat with the same team changes nothing.
- `teamrig team create ... --dry-run` prints what it would write and writes nothing.
- After `inbox read --session lead`, the next prompt titles this tab with the lead's name, and a `/clear` keeps that title, so the new Claude Code session it starts binds to the lead by itself. If its start note does not say the tab was bound, run `teamrig inbox read --session lead` again.
