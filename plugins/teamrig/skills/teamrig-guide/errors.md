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
| `REFUSED waiting needs --note` (also `verifying`, `done`, `dropped`) | Add `--note` saying what it waits for, what was done, or why it was dropped. |
| `REFUSED waiting needs --waits saying what it waits for: decision:<who>, approval:<who>, task:T<id> or time:<YYYY-MM-DD HH:MM>, comma-separated` | Add `--waits` with every reason. |
| `REFUSED --waits goes only with --status waiting` | Drop `--waits`, or set `waiting`. |
| `REFUSED T3 has not started, so it does not wait on T2: it stays open, planned after it (teamrig update T3 --after T2)` | Leave it open and plan it: `teamrig update T3 --after T2`. |
| `REFUSED T2 is already finished; nothing to wait on` | Go on: there is nothing to wait for. |
| `REFUSED time 2026-10-01 has passed: name a time to come` | Give a time still to come, in UTC. |
| `REFUSED decision lead2: lead2 is neither a session on this team nor owner` | Name a session `teamrig who` lists, or `owner`. |
| `REFUSED --after plans a task not started yet, and T4 is in-progress; a started task waits on another with --status waiting --waits task:T2` | Set it waiting with `--waits task:T2` instead. |
| `REFUSED T2 already comes after T3, directly or not, so T3 cannot come after T2` | Break the loop: one of them goes first. |
| `REFUSED verifying needs --proof saying what will prove the shipped change works` | Add `--proof` naming the proof you wait for: a test run, a night's flow, a number. |
| `REFUSED verifying needs --note saying what proves it` (with `register.requireProofOnVerifying` off) | Add `--note` naming the proof you wait for. |
| `REFUSED --proof goes only with --status verifying` | Drop `--proof`, or set `verifying`. |
| `REFUSED --due goes only with --status verifying; teamrig update T1 --due sets it otherwise` | Use `teamrig update T1 --due <date>`. |
| `REFUSED T2 needs T1, still verifying (proof: ..., owner api); start T2 once T1 is done` | T1's owner got an inbox line: work on something else until it proves T1 (`done`) or reopens it. |
| `REFUSED T1 is already done; add --note to record why you set it again` | Add a `--note`, or leave the status as it is. |
| `REFUSED the lead may change only owner, priority, due, week on a task it does not own (asked: title)` | Ask the owner to change that field. |
| `REFUSED only the owner (web) or the lead changes T2` | Ask the owner or the lead. |
| `REFUSED nothing to change` | `update` needs at least one field flag. |
| `REFUSED priority p9 is not one of p1, p2, p3, p4, p5` | Use a priority the team defines. |
| `REFUSED the title has 141 characters; the limit is 140` | Shorten the title; put detail in `--ref`. |
| `REFUSED note has 320 characters; the limit is 300` | Shorten it; point at a file instead. |
| `REFUSED note looks like it holds a secret (...); refer to where it is kept instead` | Remove the secret and name where it is kept. |
| `REFUSED due 17-10-2026 is not YYYY-MM-DD or YYYY-MM-DD HH:MM` | Write the date as `2026-10-17`. |
| `REFUSED no task T9` | Check the id with `teamrig list --status all`. |
| `REFUSED no week plan tagged yet; pass --week <YYYY-MM-DD>` (from `plan`) | Tag tasks with `--week` first, or pass `--week`. |
| `REFUSED only shop's parent lead (...) adds tasks to it` (from `add --team`) | Only the parent team's lead hands a child team work. |
| `REFUSED --tree is for the team's lead ...` | Run it without `--tree`, or as the lead. |

## Inbox

| Output | Fix |
| --- | --- |
| `REFUSED an inbox item is one non-empty line` | Put it on one line; a longer note goes in a file the line points at. |
| `REFUSED no team x with a config in this kit home` | Check the team id with `teamrig team tree`. |
| A refusal to reach another team's session | A member only writes to its own team; a lead also to its parent lead and child leads. Go through your lead. |

## Team, names and sessions

| Output | Fix |
| --- | --- |
| `REFUSED <project> is already tied to team X by <pointer>; give another --project, or remove that pointer first` | The folder belongs to another team: use another folder, or ask the user. |
| `REFUSED team X already exists at <path> with sessions ...; choose another team name, or change that config by hand` | Pick another team id, or add sessions to the existing team with the user. |
| `REFUSED the session name N is already used by ..., and Claude Code session names are machine-wide; choose another team id, or rename ... with teamrig rename` | Choose another team id. |
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
| `REFUSED context refresh is off for this team (refresh.enabled in the team config)` | The team turned refresh off; carry on. |

## Budget

From `teamrig budget lift` ([commands.md](commands.md#teamrig-budget-lift)) and `teamrig budget setup`
([commands.md](commands.md#teamrig-budget-setup)).

| Output | Fix |
| --- | --- |
| `REFUSED only the lead (lead) lifts a session's budget` | Ask the lead for the lift. |
| `REFUSED only the lead (lead) sets the team's budget` | Ask the lead to run it. |
| `REFUSED nothing written: budget.quietHours.startUtc: ...` | The line names the value the config checks reject: give the flag another one. |
| `REFUSED a lift needs --stop-pct <n>: the share of the week, in %, at which it ends` | Add `--stop-pct`. |
| `REFUSED --stop-pct 99.5 is above budget.lift.maxStopPct (99.3); only the reserve release (--reserve, in the last hour before the reset) goes up to 99.9` | Use a stop % up to 99.3, or `--reserve` in the last hour before the reset. |
| `REFUSED --stop-pct 100 is above budget.lift.reserveStopPct (99.9), the most any lift may reach` | Use a stop % up to 99.9. |
| `REFUSED --reserve releases the reserve only in the last hour before the reset, from <time> UTC` | Wait until that time, or lift without `--reserve`. |
| `REFUSED --reserve needs the week's reset: no status line snapshot gives it and budget.reset is not set` | Run `teamrig statusline install`, or set `budget.reset`. |
| `REFUSED the week's use is unknown, so the stop % cannot be judged: ...` | Run `teamrig statusline install` ([requirements.md](requirements.md#the-status-line-optional)), or set `budget.weeklyLimitW`. |
| `REFUSED the week is at 97.2%, already at or past --stop-pct 97` | The week is past that stop %: pick a higher one within the bounds, or no lift. |
| `REFUSED --until <time> UTC has passed` | Give a later `--until`. |

## Status line

From `teamrig statusline install` and `uninstall` ([commands.md](commands.md#teamrig-statusline-install)).

| Output | Fix |
| --- | --- |
| `REFUSED <settings> is not valid JSON (...); nothing written` | Fix the file at the place the message names, then run it again. |
| `REFUSED <settings> is not a JSON object; nothing written` | Claude Code's settings must be one JSON object: fix the file. |
| `REFUSED statusLine has no command string, so nothing can be added in front of it` | Give `statusLine` a `command`, or remove it. |
| `REFUSED the status line already there is a shell line with "&&", which the pipe in front would split: ...` | Put that line in a script, make the script the status line, and run install again. |
| `REFUSED the status line starts with the launcher but was changed by hand: ...` | Edit `statusLine.command` in the settings yourself. |

## Usage errors (exit 64)

| Output | Fix |
| --- | --- |
| `unknown command "x"` | See [commands.md](commands.md) or `teamrig help`. |
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
| `--week "x" is not a YYYY-MM-DD date` | Write the week's first day as `2026-10-12`. |
| `--team gives the task to that team's lead, from you: it takes no --owner or --source` | Drop `--owner` and `--source` from `add --team`. |

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
| `FAILED <path> is held by another process (waited 20000 ms); retry` | Another teamrig command holds the lock: run it again. A lock left by a crashed command is cleared after 30 s. |
| Any other `FAILED` about a file | Run `teamrig doctor`, and report what it prints to the lead. |
