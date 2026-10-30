---
name: teamrig-guide
description: Use when working in a teamrig team or learning how teamrig works (commands, task rules, inbox, check flags, hooks, workflows, refusals and their fixes).
---

# teamrig guide

teamrig runs a team of Claude Code sessions in one project: each session is a terminal tab that owns one area,
one of them is the lead, and they coordinate through a shared task register and per-session inboxes, all plain
files on this machine. The `teamrig` command is on the PATH of your Bash and PowerShell tools while the plugin is enabled.

This page is the model and the daily loop. The detail lives beside it:

| File | What it holds |
| --- | --- |
| [commands.md](commands.md) | Every command: its flags, an example and what it prints |
| [tasks.md](tasks.md) | Task statuses and what each needs, when work is its own task or a step of one, inbox lines and messages, check flags, week plans, skills |
| [workflows.md](workflows.md) | Step by step: a work block, handing work over, shipping a change, closing a task, a handover, a helper, a lead checkpoint, a lesson turned into a fix, the owner's daily meeting |
| [hooks.md](hooks.md) | Each hook and mod, what it injects or blocks, and permissions |
| [errors.md](errors.md) | Every common refusal and usage error, with its fix, and the traps outside teamrig |
| [requirements.md](requirements.md) | What teamrig needs: Claude Code, Node.js, git, terminals, operating systems |

The task pane, a separate plugin that shows a session's tasks beside the conversation, has its own guide:
[teamrig-pane guide](https://github.com/GeneralA6/teamrig-pane/blob/main/plugins/teamrig-pane/skills/teamrig-pane-guide/SKILL.md).
The design notes are in [how it works](https://github.com/GeneralA6/teamrig/blob/main/docs/how-it-works.md).
To update an installed teamrig, follow
[Updating the plugin](https://github.com/GeneralA6/teamrig/blob/main/docs/how-it-works.md#updating-the-plugin).

## The model

- **Team**: a set of sessions working one project, with an id such as `shop`. Its config lists the session ids
  and which one holds the `lead` role.
- **Session**: one Claude Code tab with a short id (`api`, `web`) that never changes, and a display name
  (`shop-api` unless renamed) that may. Every command accepts the id, the current name or a former name.
- **Lead**: owns priorities, team rules and the human's decision queue, and may re-prioritize and reassign
  tasks. It is the session the human talks to.
- **Owner**: the human. Some decisions are owner gates (destructive data operations, product and design,
  permissions, budget, resource changes): only the human approves them, and silence never counts as a yes.
- **Core rules**: the numbered rules teamrig gives every session at its start (`teamrig rules` prints them). The
  human has not read them: when you tell the user about one, say what it asks in plain words, never its number alone.
- **Task register**: an append-only log of task events. Every ask that creates work is a task with an id like
  `T12`, an owner session, a priority `p1` (most urgent) to `p5`, and a status. Only the task's owner sets its
  status, except on a task `teamrig gh sync` imported from a GitHub issue (source `github`): it opens, finishes or
  drops it as GitHub has the issue. Nothing goes from the task list to GitHub.
- **Inbox**: one file per session. A line there is a note the receiver reads at its next work block or prompt;
  it wakes an idle session only when sent with `--wake now`, or with `--wake-by <time>` at that time if still
  unseen. Urgent work handed to an idle session as a task does wake it ([the wake](hooks.md#the-mod-the-wake-on-urgent-work)).
- **Message**: a Claude Code message from one session to another. It wakes the receiver, so it is only for a
  result it needs now, a decision, a blocker, a conflict or an incident. teamrig has no message command; the
  rules only say when to send one and how long it may be.
- **Hooks**: at session start teamrig injects the team rules and who you are, and gives each helper the same rules
  as it starts; at each prompt it shows you new
  inbox lines; before a shell command it guards pushes to protected branches, refuses an ad-hoc package run and,
  when the team turns it on, lets a line that only reads run without a prompt;
  at each helper launch it restates when a helper pays; at the end of a turn it
  may ask for a handover when your context is large.
- **Tree of teams**: a team may have a parent team, at most 3 levels and 8 child teams under one team. Each team
  keeps its own sessions, task list, inboxes and `rules.md`; a child team's lead answers to the parent team's lead
  (approvals, a push to main among them), and the root lead is the only one the human talks to. Task ids are one
  numbering across the tree, so a wait or an `after` may name another team's task; work crosses teams as a task
  (`teamrig add --team <team>`), a note as `<team>/<id>`. A child team's sessions also start with the `rules.md` of
  each team above, and a role it leaves to a team above names that holder (`root/security`). `teamrig team split`
  moves sessions into a new child team; `teamrig team tree` prints the tree. A sub-lead group inside one team
  (`teamrig promote`) still works, but a group with its own lead belongs in a child team.

## Which session you are

A command that acts for a session needs to know which one: pass `--session <id>`, or set `$TEAMRIG_SESSION`.
A tab started by `teamrig open <id>` has `$TEAMRIG_SESSION` and `$TEAMRIG_TEAM` set already. Otherwise the
session-start context says "pass --session <id> to every teamrig task and inbox command": do that on every
command.

`teamrig inbox read --session <id>` also ties this Claude Code session to that id (it records a mark with Claude
Code's session id), so the hooks know you from then on. Run it first in a tab teamrig did not open. A tab whose
Claude Code title (`claude --name`, `/rename`) is a session's id or current name binds itself at its first prompt,
and the hook says so; nothing is marked read. A bound tab with no title gets its session's name as title at its next
prompt, and Claude Code keeps it across `/clear` (which starts a new Claude Code session), so the new session binds
itself as it starts. After a `/clear` whose start note does not say the tab was bound, run `inbox read` again.

If you do not know which session you are, run `teamrig who` and ask the user. Never guess.

## Where things are

A command finds its team from `$TEAMRIG_TEAM`, else the nearest `.teamrig.json` (`{"team": "<id>"}`) in the
current folder or above it, else in `$CLAUDE_PROJECT_DIR` or above. Everything else is under the kit home,
`$TEAMRIG_HOME`, else `~/.teamrig`:

```text
~/.teamrig/teams/<team>/
  config.json            sessions, roles, names and every setting (teamrig config validate checks it)
  rules.md               the team's own rules, injected after the core rules and the teams' above (optional)
  backups/               old configs kept by teamrig config migrate
  handover/<id>.md       a session's handover, written before a context refresh
  tasks/T<id>/           a task's files: design.md, build.md, plan.md, review.md, evidence/, scripts/, out/
                         (teamrig files T<id> prints and makes it, in the team that holds the task)
  notes/<id>/            a session's notes that belong to no task (teamrig files --notes)
  state/
    events.jsonl         the task register, one event per line, append-only
    inbox/<id>.md        one inbox per session id
    inbox-marks.jsonl    how far each session has read its inbox
    renames.jsonl        the rename log
    refresh/             context-refresh state
    model-notices/       the model notices each session was shown
    verify-notices.jsonl today's verify notices, so each is given once a day
    logs/                teamrig test's whole outputs, test-<session>-<n>.log, the newest 20 each
```

The config's `paths` (`state`, `inbox`, `skills`) and `refresh.handoverDir` can move these. Skills are read
from the `skills` folder of Claude Code's folder (`$CLAUDE_CONFIG_DIR`, else `~/.claude`) unless `paths.skills`
says otherwise. Never edit `events.jsonl`, the inboxes or the logs
by hand: every change goes through a command, which locks, checks and appends.

## The daily loop

At the start of each work block, in one Bash call:

```sh
teamrig start --session api
```

Then work your list in priority order: `p1` before `p2`, and inside a priority the earlier due date first (a task
takes the earlier due of a task that needs it: `due 10-17 (from T9)`).

```sh
teamrig set T4 --session api --status in-progress
# ... do the work, commit it, verify it ...
# shipped, but its proof comes later (a night's flow, a measurement)? set it verifying, with the proof, when it runs and a date:
# teamrig set T4 --session api --status verifying --note "shipped" --proof "tonight's run is clean" --waits "time:2026-10-17 06:00" --due 2026-10-17 --followups none
# tests or a dry run proved it and only a live sighting is left? close it done with --watch "<what a sighting shows>"
# done, naming the tasks the work leaves (a finding, a next step), each added first, or none:
teamrig set T4 --session api --status done --note "signup endpoint merged" --evidence "PR #12, 41 tests pass" --skill none --followups none
```

Work that is not on your list yet is a task too: `teamrig add` it before you start it. When someone else must do
something, add the task for them (`--owner <their id>`) and tell them in one inbox line, or a message if it is
urgent. See [workflows.md](workflows.md) for each step in full.

## Times

Every time people read is on the team's clock (config `timeZone`, else the machine's zone), with its zone's mark:
teamrig prints `10-19 16:40 IDT`, and core rule 3 names the zone and its offset from UTC now.

- Write times the same way in task text, notes, inbox lines and messages: `04:00 IDT`, never a bare `04:00`.
- Type them the same way: `--due 2026-10-21`, `--waits "time:2026-10-21 09:00"` and `HH:MM` are read on the
  team's clock; add ` UTC` to give one in UTC.
- Use UTC only where it is the subject: a config key kept in UTC (`queueCutoffUtc`, `quietHours`), a stamp quoted
  from a log or a file (stored stamps stay ISO UTC, ending `Z`), a protocol or format that is UTC.
- Name a time that repeats by what it is (the weekly reset, the heavy cutoff) and its config key: a clock time
  moves when daylight saving starts or ends.

## How to read what teamrig prints

The first word of the output says what happened:

| Starts with | Meaning | Exit code |
| --- | --- | --- |
| `ADDED`, `SET`, `UPDATED`, `POSTED`, `READ`, `CREATED`, `RENAMED`, `OPENED`, ... | done | 0 |
| `FAILED <why>` (on stderr) | something broke: a file, git, a process | 1 |
| `REFUSED <why>` | a team rule stopped it; the reason says what to change | 2 |
| `MANUAL` | `open` could not open a terminal and printed the command to run instead | 3 |
| a usage message, then that command's usage | the command line could not be read | 64 |

A `REFUSED` is never a bug to work around: fix what it names, or take it to the lead. [errors.md](errors.md)
lists the common ones.
