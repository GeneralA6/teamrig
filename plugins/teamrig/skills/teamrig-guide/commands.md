# teamrig commands

Every command, its flags, one example and what it prints. The examples run in a team `shop` with the sessions
`lead`, `api` and `web`.

Rules for every command line:

- Each flag takes exactly one value (`--status done`); a switch takes none (`--tree`). Quote a value with spaces.
- `--session <id|name>` names the caller: you. Without it, `$TEAMRIG_SESSION` is used. A command that needs a
  caller and has neither stops with `--session (or $TEAMRIG_SESSION) is required`.
- Sessions are given by id, current name or former name. Task ids look like `T12`. Priorities are `p1` to
  `p5` (the team config may define more or fewer).
- Dates are UTC: `YYYY-MM-DD`, or `"YYYY-MM-DD HH:MM"`. A due day alone means the end of that day. A week is the
  date of its first day.
- A flag the command does not take, a flag given twice or a flag with no value is a usage error (exit 64). It
  prints the reason, then only that command's usage lines and where the full help is.
- `teamrig <command> --help` (or `-h`) prints that command's usage lines, or a group's (`teamrig inbox --help`).

## Tasks

### teamrig add

Adds a task to the register. Every ask that creates work is a task, added by whoever asks, in the same turn.

Flags:

- `--session <id|name>`: the caller.
- `--title "<one line>"`: required; at most 140 characters (`register.maxTitle`).
- `--priority p<n>`: required; `p1` keep the lights on, `p2` correctness, `p3` scale, `p4` this week's owner
  decisions, `p5` if budget allows (the defaults).
- `--owner <session>`: who does it; default you.
- `--source <session>|owner`: who asked; default you. `--source owner` marks an order from the human
  (`register.ownerSource`).
- `--ref <where it was asked>`: a pointer to the ask, such as a file and line or an inbox date; at most 300
  characters.
- `--due <date>`: the deadline.
- `--goals a,b`: goal tags, such as roadmap item ids.
- `--week <date>`: puts the task in the week plan that starts on that day.
- `--team <child team>`: only for a lead with sub-teams: hands that team's lead the task. It takes no
  `--owner` or `--source`.

Example:

```sh
teamrig add --session lead --owner api --priority p2 --title "Build the signup endpoint" --due 2026-10-17 --goals G1 --ref "signup spec, section 2"
```

Output:

```text
ADDED T1 open, p2, owner api, due 10-17, from lead, goals G1 | Build the signup endpoint
```

A task with the same title (ignoring case and extra spaces) that is still open, in progress or blocked is refused:
`REFUSED T1 already tracks this (open, owner api)`.

### teamrig set

Sets a task's status. Only the task's owner may.

Flags:

- `--session <id|name>`: the caller, who must own the task.
- `--status open|in-progress|blocked|done|dropped`: required.
- `--note "<what or why>"`: required for `blocked`, `done` and `dropped` (`register.requireNoteOn`), and for
  setting the status the task already has.
- `--evidence <proof>`: required for `done`: a commit, test count, path or number that proves it. Evidence
  already on the task counts.
- `--skill <name>|none`: required for `done`, and allowed only with `done`: the skill you wrote or updated, or
  `none`. A named skill must exist in the skills folder.

Example:

```sh
teamrig set T1 --session api --status done --note "endpoint merged" --evidence "PR #4, 12 tests" --skill none
```

Output:

```text
SET T1 done, p2, owner api, due 10-17, from lead, goals G1 | Build the signup endpoint
```

The status is a flag, never a word after the id: `teamrig set T1 done` is a usage error (`unexpected "done"`).

### teamrig update

Changes a task's fields. The owner may change any of them; the lead may change only the owner, priority, due
date and week of a task it does not own. The status never changes here: use `set`.

Flags:

- `--session <id|name>`: the caller.
- `--title "<one line>"`: a new title.
- `--owner <session>`: hand the task to another session.
- `--priority p<n>`: a new priority.
- `--ref <where>|none`: a new pointer, or `none` to clear it.
- `--due <date>|none`: a new deadline, or `none` to clear it.
- `--goals a,b|none`: new goal tags, or `none` to clear them.
- `--week <date>|none`: plan it into a week, or `none` to take it out.
- `--note "<text>"`: records a note with the change.

Example:

```sh
teamrig update T2 --session lead --priority p2 --due 2026-10-16
```

Output:

```text
UPDATED T2 blocked, p2, owner web, due 10-16, week 10-12, from lead | Fix the broken login form (blocked: waiting for the api error codes)
```

### teamrig list

Lists tasks, most urgent first: by priority, then due date (undated last), then id. By default only active tasks
(open, in progress, blocked), in a short form within 3,000 characters: a count per owner when there are several,
then one short row per task (its title cut to 60 characters) and `+N more` for the rows left out. `--all` prints
every field of every task.

Flags:

- `--session <owner>`: only that session's tasks. (With `--tree` it names you, the lead.)
- `--status a,b|all`: these statuses, or `all`.
- `--source <session>|owner`: only tasks asked by that session, or by the human.
- `--priority p1,p2`: only these priorities.
- `--due-before <date>`: only tasks due before that time.
- `--week <date>|none`: only tasks planned in that week, or in no week.
- `--goal <tag>`: only tasks with that goal.
- `--tree`: the lead only: also every team under it, read-only, ids as `<team>/T<n>`.
- `--all`: every task in full, one task line each, instead of the short form.

Example:

```sh
teamrig list --session web
```

Output:

```text
LIST 1 task(s) (short rows; --all for every field)
T2 blocked, p2, owner web, due 10-16 | Fix the broken login form
```

A short row reads: id, status, priority, owner, due (month-day), then the title after `|`. With `--all`:

```sh
teamrig list --session web --all
```

Output (`--all`):

```text
T2 blocked, p2, owner web, due 10-16, week 10-12, from lead | Fix the broken login form (blocked: waiting for the api error codes)
```

The task line reads: id, status, priority, owner, due (month-day), week, who asked (`from lead`, or
`owner order` for the human), goals, then the title after `|`, and a blocked task's note.

### teamrig show

Prints one task with its pointer, latest note, evidence, skill and full history.

Flags:

- `--session <id|name>`: the caller (optional).

Example:

```sh
teamrig show T1
```

Output:

```text
T1 done, p2, owner api, due 10-17, from lead, goals G1 | Build the signup endpoint
ref: signup spec, section 2
note: endpoint merged
evidence: PR #4, 12 tests
skill: none
history:
  2026-10-15 08:58 lead create owner=api source=lead priority=p2 ref=signup spec, section 2 due=2026-10-17 goals=G1
  2026-10-15 08:58 api status in-progress
  2026-10-15 08:58 api status done note="endpoint merged" evidence=PR #4, 12 tests skill=none
```

### teamrig check

Lists the tasks and skills that break a team rule. The lead runs it at each checkpoint; any session may. What
each flag means and what to do about it: [tasks.md](tasks.md#check-flags). By default it prints a short form
within 3,000 characters: each kind with its count (and its detail when every flag of it shares one), at most 5
of its tasks as short rows, then `+N more`; the same for skill flags. `--all` prints every flag in full.

Flags:

- `--session <id|name>`: the caller.
- `--week <date>`: check against that week's plan instead of the current one.
- `--tree`: the lead only: also every team under it.
- `--all`: every flag in full, one line each, instead of the short form.

Example:

```sh
teamrig check --session lead
```

Output:

```text
CHECK 2 flag(s), week 2026-10-12 (short form; --all for every flag in full)
OVERDUE 1 (due 10-14)
  T7 in-progress, p2, owner web, due 10-14 | Wire the signup form to the api
NOT-PICKED-UP 1 (assigned 10-13 09:10, no event from api since)
  T9 open, p3, owner api | Add rate limits to signup
SKILLS 1 flag(s) in /home/you/.claude/skills
  SKILL UNVERIFIED (last verified 2026-09-01, 44 d ago > 30) api api-run-migrations
```

With `--all`, one full line per flag:

```sh
teamrig check --session lead --all
```

Output (`--all`):

```text
CHECK 2 flag(s), week 2026-10-12
OVERDUE (due 10-14) T7 in-progress, p2, owner web, due 10-14, from lead | Wire the signup form to the api
NOT-PICKED-UP (assigned 10-13 09:10, no event from api since) T9 open, p3, owner api, from lead | Add rate limits to signup
SKILLS 1 flag(s) in /home/you/.claude/skills
SKILL UNVERIFIED (last verified 2026-09-01, 44 d ago > 30) api api-run-migrations
```

With no week tagged yet, the first line says `no week plan tagged yet, so the week checks are skipped`.

### teamrig plan

Prints a week plan as Markdown: the tasks tagged with that week (`--week` on `add` or `update`), grouped by
priority, with done, dropped, blocked and in-progress marks. By default the newest week that has started.

Flags:

- `--session <id|name>`: the caller.
- `--week <date>`: that week instead.
- `--tree`: the lead only: also every team under it.

Example:

```sh
teamrig plan --session lead
```

Output:

```text
# Week plan 2026-10-12

1 tasks: 0 done, 0 dropped, 1 to do. From the task register at 2026-10-15 08:58 UTC.

## p2: correctness

- [ ] **T2** Fix the broken login form (web · due 10-16 · from lead) **blocked:** waiting for the api error codes
```

With no week tagged at all: `REFUSED no week plan tagged yet; pass --week <YYYY-MM-DD>`.

## Inbox

### teamrig inbox read

Prints your unread inbox lines and marks them read. Lines the prompt hook already showed this Claude Code session
are marked read too, without being printed again (a line the hook cut is printed whole). It also ties this Claude
Code session to the area, so the hooks know you: run it at the start of every work block and after every `/clear`.

Flags:

- `--session <area>`: the inbox to read: yours.

Example:

```sh
teamrig inbox read --session web
```

Output:

```text
- 2026-10-15 08:58 lead: api error codes are in docs/errors.md
READ web: 1 new line, shown above; new ones are shown at your next prompt
```

With nothing unread: `READ web: nothing new; new ones are shown at your next prompt`. After the prompt hook showed
two lines: `READ web: 1 new line, shown above, and 2 the prompt hook showed this session, now marked read too; new
ones are shown at your next prompt`.

### teamrig inbox status

Prints how many unread lines each inbox has, without marking anything read.

Flags:

- `--session <area>`: only that inbox.

Example:

```sh
teamrig inbox status
```

Output:

```text
web 1 unread since 10-15 08:58 (never marked read)
```

### teamrig inbox add

Appends one line to another session's inbox. It does not wake the receiver: the line shows at its next prompt
or work block. Use it for anything that is not urgent.

Flags:

- `--session <id|name>`: the sender.
- `--to <id|name|team/id>`: the receiver. `<team>/<id>` reaches another team of the tree, and only a lead may
  use it: to its parent team's lead or its child teams' leads.
- `--text "<one line>"`: the note: one non-empty line, no secrets.

Example:

```sh
teamrig inbox add --session lead --to web --text "api error codes are in docs/errors.md"
```

Output:

```text
POSTED to web; web is reminded at its next prompt
```

The line is stored as `- 2026-10-15 08:58 lead: api error codes are in docs/errors.md`.

## Team

### teamrig team create

Creates a team: writes its config in the kit home and `.teamrig.json` in the project folder. The lead session
is added for you.

Flags:

- `--sessions <id,id>`: required: the member session ids.
- `--lead <id>`: the lead's id; default `lead`.
- `--project <dir>`: the project folder; default `$CLAUDE_PROJECT_DIR`, else the current folder.
- `--parent <team>`: hang the new team under that team's lead, in a tree of teams.
- `--dry-run`: print what it would write, and write nothing.

Example:

```sh
teamrig team create shop --sessions api,web --project "/home/you/shop"
```

Output:

```text
CREATED /home/you/.teamrig/teams/shop/config.json
CREATED /home/you/shop/.teamrig.json
Team shop: lead lead, sessions api, web.
Next: teamrig add --session lead --owner <id> --priority p<n> --title "<first task>" for each session, then teamrig open <id> for each.
```

Run again with the same team and sessions, it changes nothing. It refuses a team id another team already uses,
and a project folder already tied to another team.

### teamrig team tree

Prints the tree of teams this team is in, with each team's lead and members.

Flags: none.

Example:

```sh
teamrig team tree
```

Output:

```text
TREE shop, 1 team(s)
shop (this team): lead lead (shop-lead); members api (shop-api), web (shop-web)
```

### teamrig who

Prints the name to message each session by (no argument), or one session's name (`teamrig who lead`, a role,
id or name). Message sessions only by these names.

Flags: none.

Example:

```sh
teamrig who
```

Output:

```text
lead shop-lead (lead)
api shop-api
web shop-site, formerly shop-web
```

### teamrig rename

Records a session's new name (`teamrig rename <id|name> <new-name>`). Its old names keep finding it in every
command. Only the session itself or the lead may rename it.

Flags:

- `--session <id|name>`: the caller.

Example:

```sh
teamrig rename web shop-site --session lead
```

Output:

```text
RENAMED web: shop-web -> shop-site
NOTE shop-web still finds web in every teamrig command; teamrig never edits permission or auto-mode rules, so update any that name shop-web yourself
```

### teamrig rules

Prints the team rules and who the session is, exactly as a session start injects them. Run it when you did
not get them at start, such as right after `team create`.

Flags:

- `--session <id|name>`: who you are.

Example:

```sh
teamrig rules --session web
```

Output (first lines):

```text
# Team rules (teamrig core)
Where your team's rules or CLAUDE.md conflict with these, yours win. [brackets] name the config key behind a value.
```

### teamrig open

Opens a new terminal tab in the project folder running Claude Code as that session (`teamrig open <id|name>`, or
`<team>/<id>` for another team of the same tree). The tab gets `$TEAMRIG_SESSION` and `$TEAMRIG_TEAM`, the
session's model and effort from the config's `launch`, and a first prompt that reads its inbox and list.

Flags:

- `--prompt "<first prompt>"`: a first prompt instead of the default one.
- `--terminal <name>`: `auto`, `tmux`, `windows-terminal`, `macos-terminal`, `gnome-terminal`, `konsole`,
  `x-terminal-emulator` or `print`; default the config's `open.terminal` (`auto`).
- `--project <dir>`: the folder to open in; default the folder holding the team's `.teamrig.json`.

Example:

```sh
teamrig open web
```

Output:

```text
OPENED shop-web (session web) in a new Windows Terminal tab in /home/you/shop, on the default model and effort
```

A session with no `launch` entry starts on Claude Code's default model and effort; the lead's unset keys default to
model `opus` at `xhigh` effort, and `launch.<lead id>` in the config changes either one.

When no terminal can be opened (or `--terminal print`), it prints `MANUAL no terminal opened (<why>); open a
new terminal and run this:` and the command, and exits 3. Show the user that command.

### teamrig launch

What a tab started by `open` runs: it sets the session's variables and starts Claude Code under the session's
name, model and effort. You do not run it yourself; `open` writes it.

Flags:

- `--team <team>`: required.
- `--project <dir>`: required; the folder must exist.
- `--home <dir>`: the kit home, when it is not the default.
- `--encoded-prompt <text>`: the first prompt, as `open` encoded it.

Example:

```sh
teamrig launch web --team shop --project /home/you/shop
```

Output:

```text
Starting Claude Code as shop-web (session web of team shop) in /home/you/shop, on the default model and effort
```

It refuses when `claude` is not on the PATH.

### teamrig refresh

Context refresh. The lead asks a session for one (`teamrig refresh <id|name>`): after that session's next
`set ... --status done` it writes a handover and the user types `/clear`. A session whose handover is written
runs `teamrig refresh --ready`. See [workflows.md](workflows.md#handover-at-high-context).

Flags:

- `--session <id|name>`: the caller.
- `--ready`: you wrote your handover; the user may now type `/clear`.

Example:

```sh
teamrig refresh web --session lead
```

Output:

```text
REQUESTED a refresh of shop-web: after its next `set done` it writes its handover to /home/you/.teamrig/teams/shop/handover/web.md; then type /clear in its tab
```

`teamrig refresh --ready --session web` prints `Ready. Ask the user to type /clear; your next start reads
<handover path>.`

## Maintenance

### teamrig doctor

Reads the team's names, rename log, inboxes, `rules.md` and tree of teams, and prints each problem with its fix.
It only reads.

Flags: none.

Example:

```sh
teamrig doctor
```

Output:

```text
DOCTOR clean, team shop
```

Otherwise `DOCTOR N finding(s)` and one `WARN <kind> <detail and fix>` line each. Kinds: `name-gone`,
`name-shared`, `name-config`, `rename-log`, `inbox-orphan`, `inbox-unread`, `rules-long`, `tree-id`,
`tree-parent`, `tree-loop`, `tree-depth`, `tree-children`, `name-two-teams`.

### teamrig compact

Archives the task list so reads stay small. Its log becomes the next file in `state/archive/`, whole and never
deleted, a fresh log starts with a line naming it, and `state/snapshot.jsonl` holds every task as it stood. Tasks
done or dropped over 8 days ago, in no week plan from the current one on, leave the snapshot: `show`,
`list --status done` and past weeks' `plan` still read them, and they cannot be changed. A run first reads the new
files back and holds every task against the whole history, and writes nothing on any difference. After the first
run, a write that leaves the log over 512 KiB archives it again. Every session must run teamrig 0.3.1 or later
before the first run.

Flags:

- `--dry-run`: print what it would archive and write, and write nothing.

Example:

```sh
teamrig compact --dry-run
```

Output:

```text
ARCHIVE events.jsonl (3 event(s), 548 B) as archive/events-000001.jsonl
SNAPSHOT snapshot.jsonl: 3 event(s), 733 B, covering segments 1-1; folded from the history (3 event(s))
TASKS 2 kept (2 unchanged, 0 changed), 0 retired now, 0 before
HISTORY 2 task(s) from 3 event(s): the working set holds every active one as the history does
TAIL events.jsonl starts again with the rotation marker (67 B)
DRY RUN: nothing was written; teamrig compact writes the above
```

A run prints the same lines, then `DONE the tail is archived as archive/events-000001.jsonl; ...`, or
`NOTHING TO DO` when nothing came since the last run. On any difference it prints
`FAILED the rotation is refused, nothing was written: <each problem>` and exits 1.

### teamrig config validate

Checks the team config against its schema and prints each problem.

Flags: none.

Example:

```sh
teamrig config validate
```

Output:

```text
VALID /home/you/.teamrig/teams/shop/config.json
```

A broken config prints `INVALID` with each problem and exits 1. While a config has problems, commands that only
read warn and use the default for each bad field, and commands that write refuse.

### teamrig config migrate

Rewrites an older config in the current format and keeps the old file in `backups/`.

Flags: none.

Example:

```sh
teamrig config migrate
```

Output:

```text
UNCHANGED /home/you/.teamrig/teams/shop/config.json needs no migration
```

### teamrig commits check

Checks the commits in `base..tip` against the small-commits rule: a commit over 400 changed non-test lines or 15
non-test files (`commits.maxLines`, `commits.maxFiles`) needs a `Large-commit: <reason>` line. For an
integrate script or CI.

Flags:

- `--base <ref>`: required: the commit to count from, such as `origin/main`.
- `--tip <ref>`: the last commit; default `HEAD`.

Example:

```sh
teamrig commits check --base origin/main
```

Output:

```text
OK 3 commit(s) in origin/main..HEAD, none over 400 non-test lines or 15 files without a reason
```

A commit over the rule without the reason line is `REFUSED` (exit 2).

## Hooks

Claude Code runs these from the plugin's `hooks/hooks.json`, with the hook's JSON on stdin. You never run them
by hand. What each does: [hooks.md](hooks.md).

### teamrig hook session-start

Injects the team rules, who you are and your team's `rules.md` when a session starts, resumes or is cleared.

Flags: none.

Example:

```sh
teamrig hook session-start < session-start.json
```

Output: a JSON object whose `hookSpecificOutput.additionalContext` holds the rules.

### teamrig hook inbox-reminder

At each prompt, shows the inbox lines this Claude Code session has not been shown yet (at most 5 lines and 1,500
characters, each once), binds a tab started by hand to the session its Claude Code title names, and records a
rename. See [Hooks and permissions](hooks.md#each-prompt).

Flags: none.

Example:

```sh
teamrig hook inbox-reminder < prompt.json
```

Output, when lines are new:

```text
INBOX web, new in /home/you/.teamrig/teams/shop/state/inbox/web.md (each line is shown once; reading marks them read):
- 2026-10-15 08:58 lead: api error codes are in docs/errors.md
```

### teamrig hook push-guard

Before a Bash or PowerShell command, asks the human about a push to a protected branch and refuses a force-push or
deletion of one.

Flags: none.

Example:

```sh
teamrig hook push-guard < pre-tool-use.json
```

Output: nothing for a command that pushes no protected branch; otherwise a JSON permission decision (`ask` or
`deny`) with the reason.

### teamrig hook stop

At the end of each turn, after you set a task done, asks for a handover when your context is over the refresh
threshold or the lead asked for a refresh.

Flags: none.

Example:

```sh
teamrig hook stop < stop.json
```

Output: nothing on most turns; otherwise a JSON `block` decision whose reason tells you to write the handover.

## Help and version

### teamrig help

Prints the usage of every command (also `--help` and `-h`). With no command at all, teamrig prints the usage and
exits 64. `teamrig <command> --help` prints only that command's lines, the line shape and where the full help is.

Flags: none.

Example:

```sh
teamrig help
```

Output: the usage, starting:

```text
teamrig <command> ...   (the caller: --session <id|name>, else $TEAMRIG_SESSION)
```

### teamrig version

Prints the installed version, the same as `version` in the plugin's `plugin.json` (also `--version` and `-v`).

Flags: none.

Example:

```sh
teamrig version
```

Output:

```text
teamrig <version>
```
