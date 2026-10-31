# Errors and refusals

What teamrig prints when it stops, and what to do. `REFUSED` (exit 2) means a team rule stopped the command; a
usage error (exit 64) means the command line could not be read and is followed by that command's usage; `FAILED`
(exit 1, on stderr) means a file, git or another program failed. Never work around a refusal: fix what it names,
or take it to the lead.

## No team, wrong session

| Output | Fix |
| --- | --- |
| `REFUSED no team here: create one with teamrig team create <team> --sessions <id,id>, set $TEAMRIG_TEAM, or put .teamrig.json {"team": "<id>"} in the project folder` | Run the command from the project folder, or set `$TEAMRIG_TEAM`. Create a team only if the user wants one. |
| `--session (or $TEAMRIG_SESSION) is required` | Add `--session <your id>`. If you do not know it, run `teamrig who` and ask the user. |
| `REFUSED db is not a session on this team (sessions: lead (shop-lead), api (shop-api), web (shop-web))` | Use one of the ids or names listed. |
| `REFUSED the team config has 2 problem(s) (first: ...); run: teamrig config validate` | Run `teamrig config validate` and fix each problem it lists in the config; reads still work meanwhile. |
| `REFUSED no team config at <path>; create it with: teamrig team create <team> --sessions <id,id>` | The pointer names a team with no config: create it, or fix `.teamrig.json`. |

## Tasks

| Output | Fix |
| --- | --- |
| `REFUSED T1 already tracks this (open, owner api)` | An active task has this title: work on that one, or ask its owner. |
| `REFUSED only the owner (api) sets the status of T1` | Tell the owner in an inbox line; only it sets the status. |
| `REFUSED done needs --evidence: a commit, test count, path or number that proves it` | Add `--evidence` with real proof. |
| `REFUSED done needs --skill <name> (the skill written or updated) or --skill none` | Add `--skill <name>` or `--skill none`. |
| `REFUSED no skill named x; write it first or use --skill none` | Write the skill to `<skills folder>/x/SKILL.md` first, or use `none`. |
| `REFUSED --skill goes only with done` | Drop `--skill`. |
| `REFUSED done needs --followups T<id>,... naming the tasks this work leaves (a finding, a next step), or --followups none` (also `verifying`) | Add each finding or next step as a task (`teamrig add`) and name them, or use `--followups none`. |
| `REFUSED --followups names T9, which is not on the task list: add it first (teamrig add)` | `teamrig add` the follow-up, then name its id. |
| `REFUSED --followups names T1 itself: name the tasks it leaves` (also `names T2 twice`) | Name each other task once. |
| `REFUSED --followups goes only with verifying, done, dropped` | Drop `--followups`. |
| `REFUSED T1 is a bug: done needs its review, --cause, --how and --missed-log (...)` (also `verifying`) | Give the parts it names: the root cause, how it got in, and the test, monitor or log that missed it, each a follow-up task or why none can (`teamrig help set`). |
| `REFUSED --how goes only with a bug: mark it first, teamrig update T1 --type bug` | Mark the task a bug first, or drop the review flags. |
| `REFUSED critical marks only a bug: give --type bug too` | Add `--type bug`, or drop `--critical`. |
| `--problem was renamed: use --type bug [--critical] (or --type task)` | Mark a bug with `--type bug`, a critical one with `--type bug --critical`, and quiet the bug hint with `--type task`. |
| `REFUSED --missed-test says "T124": give at least 3 plain words besides task ids, ...` | Say what the follow-up adds, as well as its id. |
| `REFUSED a missed part names T9, which is not on the task list: add it first (teamrig add)` | `teamrig add` the follow-up, then name its id. |
| `REFUSED waiting needs --note` (also `verifying`, `done`, `dropped`) | Add `--note` saying what it waits for, what was done, or why it was dropped. |
| `REFUSED waiting needs --waits saying what it waits for: decision:<who>, approval:<who>, task:T<id> or time:<YYYY-MM-DD HH:MM>, comma-separated` | Add `--waits` with every reason. |
| `REFUSED --waits goes only with --status waiting or verifying` | Drop `--waits`, or set `waiting` (or `verifying`, for what its proof waits for). |
| `REFUSED a wait on owner's decision needs a card, so owner decides from it alone: --question ...` | Add the four card flags it prints: what is decided, the options with their numbers, your recommendation, the default. |
| `REFUSED a card needs --question, --options, --recommend and --default (--options for a decision): ...` | A task not waiting yet has no card to build on: give every part. |
| `REFUSED --options lists 1: a decision lists at least 2, separated by \|` | List every choice, separated by `\|`; an approval may list none. |
| `REFUSED --recommend says "T378 option 2": give at least 3 plain words besides task ids, so it reads without the task list` (any part) | Say it in words: what the option is and what it costs. |
| `REFUSED --question, --options, --recommend and --default go only with --status waiting or verifying on a decision or an approval` | Drop the card flags, or wait on the decision. |
| `REFUSED T3 has not started, so it does not wait on T2: it stays open, planned after it (teamrig update T3 --after T2)` (or `stays waiting`, for one waiting since before it started) | Leave its status and plan it: `teamrig update T3 --after T2`. |
| `REFUSED T3 is done, so it waits on nothing: reopen it (teamrig set T3 --status in-progress), then set it waiting on T2` (or `is dropped`) | Reopen it with `--status in-progress`, then set it waiting on T2. |
| `REFUSED T2 is already finished; nothing to wait on` | Go on: there is nothing to wait for. |
| `REFUSED time 10-01 09:00 IDT has passed: name a time to come` | Give a time still to come, on the team's clock or marked UTC. |
| `REFUSED decision lead2: lead2 is neither the lead (lead) nor owner` | Name the lead, or `owner`. |
| `REFUSED approval api: approval waits are for the lead (lead) and owner; wait on api's work by its task: teamrig set T3 --status waiting --ask api --text "<the work you need>"` | Run the command it names: a peer's work is a task, never an approval. |
| `REFUSED --ask goes only with --status waiting` | Add `--status waiting`, or ask with `teamrig add --owner <id>`. |
| `REFUSED --ask goes only with --status waiting: the asked task starts open, and a proof waits only on a task in progress or verifying, so T1 waits on it until it starts (teamrig set T1 --status waiting --ask api --text "<the run>")` | Run the command it names; once the asked task has started, set T1 `verifying` with `--waits task:<its id>`. |
| `REFUSED T3 has not started, so it does not wait: ask with teamrig add --owner api --title "<the work>", then plan T3 after that task (teamrig update T3 --after <its id>)` | Run both commands it names: T3 stays open until that task is done. |
| `REFUSED T5 already tracks this (open, owner api): wait on it with --waits task:T5` | Wait on the task that exists: `teamrig set T3 --status waiting --waits task:T5`. |
| `REFUSED --after plans a task not started yet, and T4 is in-progress; a started task waits on another with --status waiting --waits task:T2` | Set it waiting with `--waits task:T2` instead. |
| `REFUSED T3 -> T2 -> T3 would be a loop, and no task in a loop can finish: make the step T3 needs from T2 its own task: teamrig add --owner api --title "<the step>", then teamrig update T3 --after <its id>` (an `--after` link) or `...: teamrig set T3 --status waiting --ask api --text "<the step>"` (a `--waits task:` link) | T2 already needs T3, by a plan dependency or a task wait. Run the command it names: the step T3 needs becomes a task of its own that needs nothing back. |
| `REFUSED verifying needs --proof saying what will prove the shipped change works` | Add `--proof` naming the proof you wait for: a test run, a night's flow, a number. |
| `REFUSED verifying needs --note saying what proves it` (with `register.requireProofOnVerifying` off) | Add `--note` naming the proof you wait for. |
| `REFUSED verifying needs --waits saying when its proof runs: time:<YYYY-MM-DD HH:MM> when it runs, or task:T<id> for a task in progress or verifying whose end runs it; if tests or a dry run proved it and its proof is a sighting, close it done with --watch "<what a sighting shows>" instead` | Add `--waits` with the time the proof runs, or the task whose end runs it. If only a live sighting is left, set it `done` with `--evidence` and `--watch`. |
| `REFUSED T2 is open: a proof waits only on a task in progress or verifying; until it starts, set T1 waiting on it (--status waiting --waits task:T2)` | Set T1 `waiting` on T2; set it `verifying` with `--waits task:T2` once T2 has started. |
| `REFUSED T1's proof waited on task:T2, which has cleared: run the proof now and set it done, or name when it runs with --waits (...)` | The proof is due now: run it and set T1 `done`, or give `--waits` with the time or task it now runs on. |
| `REFUSED T1's proof was put off to other waits 2 times [register.maxReparks]: run the proof now and set it done, close it done with --watch "<what a sighting shows>" if tests or a dry run proved it, or reopen it (teamrig set T1 --status in-progress)` | Do one of the three; the limit stops a proof that keeps moving and never runs. |
| `REFUSED --watch goes only with --status done` | Drop `--watch`, or set `done`. |
| `REFUSED --watch needs --evidence: the tests or dry run that proved the change` | Add `--evidence` naming them. |
| `REFUSED --proof goes only with --status verifying` | Drop `--proof`, or set `verifying`. |
| `REFUSED --due goes only with --status verifying; teamrig update T1 --due sets it otherwise` | Use `teamrig update T1 --due <date>`. |
| `REFUSED T2 needs T1, still verifying (proof: ..., owner api); start T2 once T1 is done, or with --met "..."` | T1's owner got an inbox line: work on something else until it proves T1 (`done`) or reopens it. If the proof already exists, start T2 with `--met "<what shows it>"`; T1's owner is asked to confirm it. |
| `REFUSED --met goes only with a start that a verifying task it needs holds` | `--met` names what met a held proof: drop it, since nothing verifying holds this change. |
| `REFUSED T1 is already done; add --note to record why you set it again` | Add a `--note`, or leave the status as it is. |
| `REFUSED a leader may change only owner, priority, due, week, after, size, kind, pin on a task it does not own (asked: title)` | Ask the owner to change that field. |
| `REFUSED only the owner (web) or the lead (lead) changes T2` | Ask the owner or a leader it names (a sub-lead's member: `a leader above web (backend or lead)`). |
| `REFUSED backend hands T2 only to itself or a session it leads (importer, search); the lead (lead) moves work between groups` | Hand it within your group, or ask the lead to move it to another. |
| `REFUSED nothing to change: give a field or a --note` | `update` needs a field flag, or a `--note` to add alone. |
| `REFUSED priority p9 is not one of p0, p1, p2, p3, p4, p5` | Use a priority the team defines, or p0 for urgent work. |
| `REFUSED the title has 141 characters; the limit is 140` | Shorten the title; put the detail in `--description`. |
| `REFUSED add needs --description "<what and why, in plain words>"` | Add `--description` saying what the task is and why, for a person who has not seen the ask. A team that does not want it sets `register.requireDescription` to `false`. |
| `REFUSED the description has 2001 characters; the limit is 2000` | Shorten it; point at a file for the rest. |
| `REFUSED T1 keeps a description while register.requireDescription is on: give a new one instead of none` | Give `update --description` a new text instead of `none`. |
| `REFUSED note has 320 characters; the limit is 300` | Shorten it; point at a file instead. |
| `REFUSED note looks like it holds a secret (...); refer to where it is kept instead` | Remove the secret and name where it is kept. |
| `REFUSED due 17-10-2026 is not YYYY-MM-DD or YYYY-MM-DD HH:MM` | Write the date as `2026-10-17`. |
| `REFUSED no task T9` | Check the id with `teamrig list --status all`. |
| `REFUSED no week plan tagged yet; pass --week <YYYY-MM-DD>` (from `plan`) | Tag tasks with `--week` first, or pass `--week`. |
| `REFUSED team shop is not in app's team tree, so app/alpha may not add its tasks` (from `add --team`) | Only a team of your own tree takes your asks; ask a team of another tree through its people. |
| `REFUSED team shop: front is not a session on this team (sessions: ...)` (from `add --team --owner`) | Name a session of that team, by id or name (`teamrig who`), or drop `--owner` to give the task to its lead. |
| `REFUSED --tree is for the team's lead ...` | Run it without `--tree`, or as the lead. |

## Inbox

| Output | Fix |
| --- | --- |
| `REFUSED an inbox item is one non-empty line` | Put it on one line; a longer note goes in a file the line points at. |
| `REFUSED no team x with a config in this kit home` | Check the team id with `teamrig team tree`. |
| A refusal to reach another team's session | Any session reaches any session of its tree (`teamrig team tree` shows it); a separate tree is out of reach. `--wake now` reaches another team only from the lead of a team above it: post the line without `--wake`. |

## Team, names and sessions

| Output | Fix |
| --- | --- |
| `REFUSED <project> is already tied to team X by <pointer>; give another --project, or remove that pointer first` | The folder belongs to another team: use another folder, or ask the user. |
| `REFUSED team X already exists at <path> with sessions ...; choose another team name, or change that config by hand` | Pick another team id, or add sessions to the existing team with the user. |
| `REFUSED the session name N is already used by ..., and Claude Code session names are machine-wide; choose another team id, or rename ... with teamrig rename` | Choose another team id. |
| `REFUSED only a lead hires sessions: the lead (<id>), or a sub-lead into its own group` | Ask your leader to hire the session. |
| `REFUSED hiring.policy is off: the team takes no hires by command` | Ask the owner whether to allow hires; the lead then sets `hiring.policy` in the team config. |
| `REFUSED hiring.policy is owner: the owner approves each hire; ask the owner, then pass --approved-by "<who>"` | Ask the owner (in a child team the refusal names the parent team's lead, and for a sub-lead its own leader, who takes it to the owner), then run the hire again with `--approved-by`. |
| `REFUSED <id> owns open task(s) T1: pass --to <heir> to hand them over, or close them first` | Retire it with `--to <heir>`, or let it close its tasks first. |
| `REFUSED no handover at <path>: write it (open work, next steps, branches, traps) or pass --no-handover "<why>"` | Ask the session to write its handover there, or retire it with `--no-handover "<why>"`. |
| `REFUSED <id> holds roles.<role>: give the role to another session first` | Set the role to another session in the team config, then retire it. |
| `REFUSED github.owners names <id> for <login>: point it at another session first` | Point that login (or the repository in `github.sessions`) at another session, then retire it. |
| `REFUSED only a lead over the session retires it (the lead, or its sub-lead): the leader decides which workers the team needs` | Ask the session's leader (its sub-lead, else the lead) to retire it. |
| `REFUSED <sub-lead> hands work only within its group: the heir <id> is not led by <sub-lead>; the lead (<id>) moves work between groups` | Pass an heir in your group (or yourself), or ask the lead to retire it. |
| `REFUSED <id> is already on the team: a hired session is kept with --review <YYYY-MM-DD> --reason "<why>"` | To keep a hired session to a new review day, pass both; to hire another session, give a new id. |
| `REFUSED only a lead over the session keeps it (the lead, or its sub-lead): the leader decides which workers the team needs` | Ask the session's leader (its sub-lead, else the lead) to keep it. |
| `REFUSED <id> is set up with the team, not hired: it has no review day to keep` | Nothing to keep: only a hired session has a review day. |
| `REFUSED the review day <day> has passed` (or `is not a YYYY-MM-DD date`) | Give a future day, `YYYY-MM-DD`. |
| `--scope: a keep of <id> changes only its review day` (exit 2; also `--name`, `--model`, `--effort`, `--approved-by`, `--burst`) | Drop the flag: a keep leaves the hire's job and launch as they are. |
| `REFUSED <id> was not hired back after a retire: --resume resumes only a rehired session's last Claude Code session` | Open it without `--resume`. |
| `REFUSED not resumed: <why>; open it fresh on its handover: teamrig open <id>` | Its last Claude Code session is gone, too big or too long idle: open it fresh with the command shown. |
| `--resume "<value>" is not a Claude Code session id` (exit 2) | `launch` was given something other than a session id; open the session again with `teamrig open <id>`. |
| `REFUSED team X has N child teams (...), and a team has at most 8: hang some under another team` | Put the new team under another team with `--parent`. |
| `REFUSED only web itself or the lead may record its new name` | Ask that session or the lead to run `rename`. |
| `REFUSED x is already the name of ...` / `x is the id of another session` | Choose another name. |
| `REFUSED Claude Code (claude) is not on PATH; install it, then run this again` | Install Claude Code or fix the PATH. |
| `REFUSED the project folder <dir> does not exist` | Pass an existing folder to `--project`. |
| `MANUAL no terminal opened (...); open a new terminal and run this:` and a command (exit 3) | Show the user the command to run in a new terminal; or pass `--terminal <name>`. |

## Refresh

| Output | Fix |
| --- | --- |
| `REFUSED only the lead (shop-lead) asks for a refresh` | Only the lead asks; a session refreshes itself when the Stop hook asks. |
| `REFUSED no refresh was asked of you: ...` | Nothing to do: carry on. |
| `REFUSED write your handover to <path> first` | Write the handover, then run `refresh --ready` again. |
| `REFUSED <path> is the handover from before; write this refresh's handover there` | Rewrite the file with the current state. |
| `REFUSED <path> is <n> bytes, over refresh.handoverMaxBytes (<max>): ...` | Rewrite the whole file short, with only what the next session needs, then run `refresh --ready` again. |
| `REFUSED context refresh is off for this team (refresh.enabled in the team config)` | The team turned refresh off; carry on. |
| Inbox: `the automatic restart did not happen: <why>; type /clear for a fresh start` | Ask the user to type `/clear`; your handover still waits for the fresh start. |
| Inbox: `you were restarted, but refresh.endCommand was not found` (or `failed (...)`) | The SessionEnd hooks the hard end skipped did not run: tell the lead, whose team config names that program. |

## Budget

From `teamrig budget lift` ([commands.md](commands.md#teamrig-budget-lift)), `teamrig budget cut`
([commands.md](commands.md#teamrig-budget-cut)), `teamrig budget extra`
([commands.md](commands.md#teamrig-budget-extra)) and `teamrig budget setup`
([commands.md](commands.md#teamrig-budget-setup)).

| Output | Fix |
| --- | --- |
| `REFUSED api's budget is lifted only by web or lead` | The caller leads no group over that session: ask one of the leaders it names (nearest first) for the lift. |
| `REFUSED web's group's budget is lifted only by lead` | A sub-lead does not lift its own group: ask a leader it names. |
| `REFUSED api's budget is cut only by web or lead` | The caller leads no group over that session: ask one of the leaders it names (nearest first) for the cut. |
| `REFUSED --group lifts a sub-lead's group, and api leads none` | Lift the session without `--group`, or name its sub-lead. |
| `REFUSED --group lifts a sub-lead's group; lead is the lead, whose group is the whole team` | No lift takes a part of the whole team: lift a session, or a sub-lead's group. |
| `REFUSED only the lead (lead) lifts a session of a team under its own` | A `<team>/<session>` lift is the lead's: ask it. |
| `REFUSED team ops is not a team under team web` | The lead lifts only sessions of teams below its own: ask the lead of a team above both. |
| `REFUSED team web is on another Claude account than team app, so team app's daily budget cannot top its sessions up` | The teams' weeks are separate: web's own lead lifts its session. |
| `REFUSED on team web, ...` | The session is not on that team: check its id with `teamrig who`. |
| `REFUSED the other lifts in force give 60.0% of web's group's daily budget, so --part 60 would give more than all of it; the most this lift may give is 40.0%. web's group gets 6.0% of the week today and has used 2.5%; lead can lift it: ...` | Lift by at most the part it names, or ask the leader it names to lift the whole group with the command it gives. Outside a group, the line ends after the most this lift may give. |
| `REFUSED only the lead (lead) sets the team's budget` | Ask the lead to run it. |
| `REFUSED nothing written: budget.quietHours.startUtc: ...` | The line names the value the config checks reject: give the flag another one. |
| `REFUSED a lift needs --stop-pct <n>: the share of the week, in %, at which it ends` | Add `--stop-pct`. |
| `REFUSED --stop-pct 99.5 is above budget.lift.maxStopPct (99.3); only the reserve release (--reserve, in the last hour before the reset) goes up to 99.9` | Use a stop % up to 99.3, or `--reserve` in the last hour before the reset. |
| `REFUSED --stop-pct 100 is above budget.lift.reserveStopPct (99.9), the most any lift may reach` | Use a stop % up to 99.9. |
| `REFUSED --reserve releases the reserve only in the last hour before the reset, from 2026-10-21 03:00 IDT` | Wait until that time, or lift without `--reserve`. |
| `REFUSED --reserve needs the week's reset: no status line snapshot gives it and budget.reset is not set` | Run `teamrig statusline install`, or set `budget.reset`. |
| `REFUSED the week's use is unknown, so the stop % cannot be judged: ...` | Run `teamrig statusline install` ([requirements.md](requirements.md#the-status-line-optional)), or set `budget.weeklyLimitW`. |
| `REFUSED the week is at 97.2%, already at or past --stop-pct 97` | The week is past that stop %: pick a higher one within the bounds, or no lift. |
| `REFUSED --until <time> has passed` | Give a later `--until`. |
| `REFUSED only the lead (lead) enters the extra-usage pool` | Ask the lead to enter the dollars. |
| `REFUSED the week's period is unknown (no status line reading and no budget.weeklyLimitW), so the entry has no period to belong to` | Run `teamrig statusline install` ([requirements.md](requirements.md#the-status-line-optional)), or set `budget.weeklyLimitW`. |

## Bursts

From `teamrig burst start`, `teamrig burst end` ([commands.md](commands.md#teamrig-burst-start)) and
`teamrig hire --burst` ([commands.md](commands.md#teamrig-hire)).

| Output | Fix |
| --- | --- |
| `REFUSED only the lead (lead) starts a burst` (or `ends a burst`) | Ask the lead. |
| `REFUSED burst.policy is off: the team takes no bursts` | Ask the owner whether to allow bursts; the lead then sets `burst.policy` in the team config. |
| `REFUSED burst.policy is owner: a burst spends more of the week, so the owner approves each one; ...` | Ask the owner (in a child team the refusal names the parent team's lead, who takes it to the owner), then run it again with `--approved-by "<who>"`. |
| `REFUSED a surplus burst runs until ...; end it first: teamrig burst end --reason "<why>"` | One burst at a time: end the one in force first, or work within it. |
| `REFUSED a surplus burst starts only from <time> (burst.surplusHours 48 before the reset) until the pace end` | Wait for the window, or start a deadline burst for work due sooner. |
| `REFUSED only 3.1% of the week is projected unused at the pace end, below burst.minSparePct (5.0%): ...` (with other teams on the account: `only 3.1% of the week, this team's part of the account's 6.2%, is projected unused ...`) | There is no surplus for the team to spend: no burst. `teamrig burst` shows the projection. |
| `REFUSED a deadline burst needs --stop-pct <n>: ...` (or `--by <time>`, `--task <ids>`) | Add the flag the line names. |
| `REFUSED --stop-pct 99.7 is above budget.targetPct (99.5): a burst never spends the reserve` | Use a stop % up to `budget.targetPct`. |
| `REFUSED --helpers 5 is above burst.maxHelpers (3)` (or `--hires`, `burst.maxHires`) | Ask for fewer, or ask the owner to raise the cap. |
| `REFUSED T12 is done: a burst works on open tasks only` | Name only tasks still open, in progress, verifying or waiting. |
| `REFUSED the week's use or reset is unknown, so the burst cannot be judged: ...` | Run `teamrig statusline install`, or set `budget.weeklyLimitW` and `budget.reset`. |
| `REFUSED no burst is in force: nothing to end` | Nothing to end: `teamrig burst` shows the state. |
| `REFUSED no burst is in force: hire --burst hires for one (teamrig burst)` | Start a burst first, or hire without `--burst`. |
| `REFUSED the burst allows 1 hire, and 1 is on the team` | Retire a burst hire whose job is done, or work without another. |
| `REFUSED --model haiku: a burst hire runs on the lead's model (opus), never another` (or `--effort medium is below the lead's high`) | Drop `--model`, or give the lead's model and at least its effort. |
| `--task and --by name a deadline burst's work: a surplus burst takes neither` (exit 64) | Drop them, or start a deadline burst. |

## Status line

From `teamrig statusline install` and `uninstall` ([commands.md](commands.md#teamrig-statusline-install)).

| Output | Fix |
| --- | --- |
| `REFUSED <settings> is not valid JSON (...); nothing written` | Fix the file at the place the message names, then run it again. |
| `REFUSED <settings> is not a JSON object; nothing written` | Claude Code's settings must be one JSON object: fix the file. |
| `REFUSED statusLine has no command string, so nothing can be added in front of it` | Give `statusLine` a `command`, or remove it. |
| `REFUSED the status line already there is a shell line with "&&", which the pipe in front would split: ...` | Put that line in a script, make the script the status line, and run install again. |
| `REFUSED the status line starts with the launcher but was changed by hand: ...` | Edit `statusLine.command` in the settings yourself. |

## Restore at logon

From `teamrig restore install` and `uninstall` ([commands.md](commands.md#teamrig-restore-install)).

| Output | Fix |
| --- | --- |
| `REFUSED teamrig can set up the logon check on Windows only so far, not on linux; ...` | Run `teamrig restore run` after a crash or reboot. |
| `FAILED SET <entry or shortcut>: ...: PowerShell ended with exit 1: ...` (exit 1) | The steps done before it are listed under it: fix the reason it names, then run install again, which redoes only what is missing. |
| `FAILED the shortcut scan printed no list of shortcuts: ...` or `FAILED PowerShell ...` (exit 1) | Install could not read the `Restore Claude Sessions` shortcuts and changed nothing: fix the reason it names, then run it again. |
| A `logon:` line other than `logon: started` in `<kit home>/restore/restore.log` | The check at logon did not run or failed, and the line says why; `teamrig restore run` reopens the sessions by hand. |
| `check: started` with no `check: <n> to restore` after it, or `run: tab opened` with no other `run:` line after it, in `<kit home>/restore/restore.log` | The check, or the restore's tab, ended before it got that far (killed, or its terminal closed); `teamrig restore` lists the sessions still to reopen and `teamrig restore run` reopens them. |
| `check: opened the restore tab; windows-terminal exited 0` with no `run: tab opened` after it in `<kit home>/restore/restore.log` | The terminal took the tab but its command never ran: Windows Terminal ended right after its launcher returned, or the tab's shell could not start teamrig; `teamrig restore run` reopens the sessions by hand. |
| No `logon: started` line in `<kit home>/restore/restore.log` since a reboot | No logon ran the launcher: no one logged on yet, or the logon entry is gone (`teamrig restore install` shows it), or the launcher predates this line (`teamrig restore install --yes` writes the new one). |
| `FAILED: teamrig not found in the Claude Code plugin list` in the window the `Restore Claude Sessions` shortcut opened, and a `shortcut:` line in `<kit home>/restore/restore.log` | The run launcher found no installed teamrig plugin, or could not start the run; the window stays open 60 seconds. Install the plugin again (`claude plugin install teamrig@teamrig`), or run `teamrig restore run` in a terminal. |
| `run: interrupted by <signal> after <counts>` in `<kit home>/restore/restore.log`, or a `run: started` line with no `run: done` after it | The restore's tab was closed (or the run was killed) before every session reopened; `teamrig restore` lists those still to reopen and `teamrig restore run` reopens them. |

## Usage errors (exit 64)

| Output | Fix |
| --- | --- |
| `unknown command "x"` | See [commands.md](commands.md) or `teamrig help`. |
| `the command line held a line break, and cmd.exe, which runs teamrig.cmd for PowerShell and cmd, dropped everything after it, so nothing was done. ...` | `teamrig.cmd` rebuilds a multi-line argument from the command line cmd.exe ran, and refuses when that line does not match the arguments cmd passed on. Run the command from Bash, keep each argument on one line, or run `node "<plugin>/dist/cli/main.js"` with the same arguments, as the message says. |
| `unexpected "done"` | The status is a flag: `teamrig set T1 --status done ...`. |
| `<cmd> takes no --x` | That command has no such flag: check its section in [commands.md](commands.md). |
| `--x is given twice` | Give each flag once; a list is comma-separated (`--goals G1,G2`). |
| `--x needs a value` | Give the value, quoted if it has spaces. |
| `priority "2" is not p<n>: write p2` | Write priorities as `p2`. |
| `priority "t2" is the old tier spelling: write p2` | Write `p2`. |
| `--tier was renamed: use --priority` | Use `--priority`. |
| `"9" is not a task id like T12` | Write task ids as `T9`. |
| `--status "finished" is not open\|in-progress\|verifying\|waiting\|done\|dropped` | Use one of those six. |
| `--status blocked was replaced by waiting: use --status waiting --waits <reason> (...)` | Set `waiting` with what it waits for. |
| `--waits "soon" is not one of decision:<who>, approval:<who>, task:T<id> or time:<YYYY-MM-DD HH:MM>, comma-separated` | Write each reason as `kind:value`. |
| `--text goes only with --ask <session>: it is the work asked for` | Add `--ask <session>`, or drop `--text` (a status note is `--note`). |
| `--ask needs --text "<the work asked for>": the title of the task it creates` | Add `--text` naming the work. |
| `--week "x" is not a YYYY-MM-DD date` | Write the week's first day as `2026-10-12`. |
| `--team adds the task from you: it takes no --source, unless it names your own team` | Drop `--source` from `add --team`: the task is marked as from you. |

## Requirements

Not refusals: `WARN` lines from `team create`, `requirement` findings from `doctor`, and a note at session start
([the check](requirements.md#the-requirements-check)).

| Output | Fix |
| --- | --- |
| `git is not installed or not on PATH, and teamrig needs it: install it from git-scm.com, then restart Claude Code.` | Install git, or put its folder on the PATH, then restart Claude Code. |
| `Claude Code 2.1.130 is older than teamrig needs (2.1.139 or later): run claude update, then restart Claude Code.` | Update Claude Code; the hooks do not run on an older one. |
| `Node.js 20.11.1 is older than teamrig supports (22.18.0 or later): install the current LTS from nodejs.org, then restart Claude Code.` | Install a newer Node.js and make it the `node` on the PATH. |
| `The teamrig check for git failed (<reason>).` | The check itself failed; the rest still ran. Run `teamrig doctor` again, and report the reason to the lead if it stays. |

## Failures (exit 1)

| Output | Fix |
| --- | --- |
| `FAILED git cannot list the commits in X..HEAD from <dir>` | Run `commits check` inside a git repository, with a base ref that exists (`git fetch` first). |
| `INVALID <config path>: N problem(s), each read as its default until fixed` | Fix each listed problem in the config, then run `config validate` again. |
| `FAILED <path> is held by another process (waited 20000 ms); retry` | Another teamrig command holds the lock: run it again. A lock whose command crashed is taken over at once; one older than `lock.ttlMs` (5 min) is taken over even if its pid runs again. |
| Any other `FAILED` about a file | Run `teamrig doctor`, and report what it prints to the lead. |

## Traps outside teamrig

Not teamrig output: what any session on a shared checkout or on Windows runs into, and the habit that avoids it.

- **No bare `git stash` on a shared checkout.** Every worktree of a repository shares one stash stack, so another
  session's `git stash pop` takes your changes. Commit on your own branch, or move scratch files to your scratchpad.
- **Name a program literally.** A program held in a variable set by `$(...)`, or set outside the line, is only
  known when the line runs, so [the push guard](hooks.md#before-a-shell-command-the-push-guard) asks the human. In
  auto mode, Claude Code also refuses a session isolated in a worktree a command whose program comes from a variable,
  and a complex command that names git in a part it cannot check (`github` and typed notes count). Write the program
  or its full path in the command, and put a long script in a file in your scratchpad.
- **Claude Code's cron times are local time**, not UTC: convert a UTC time before you schedule it.
- **Delete through a guarded variable or a literal path.** With `DIR` empty, `rm -rf "$DIR"/x` aims at the root, so
  Claude Code asks the human; `"${DIR:?}"/x` stops when it is empty. Claude Code reads a relative path against the
  session's folder, not a `cd` earlier in the line, so write the full path.
- **Edit with the Edit tool**, never a throwaway script written by a heredoc and removed with `rm`: that `rm` raises
  the checks above, and the change is never shown as an edit. A scratch file goes in your scratchpad, by its full
  path, and stays there.
- **Git Bash rewrites arguments.** One that looks like a Unix path (`/app`) becomes a Windows path
  (`C:/Program Files/Git/app`), and a `$` in `node -e` code can be expanded before node reads it. Write the code to a
  file in your scratchpad and run `node <file>`.
