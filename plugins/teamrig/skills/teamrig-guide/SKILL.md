---
name: teamrig-guide
description: Use when working in a teamrig team or learning how teamrig works (commands, task rules, inbox, check flags, hooks, workflows, refusals and their fixes).
---

# teamrig guide

teamrig runs a team of Claude Code sessions in one project: each session is a terminal tab that owns one area,
one of them is the lead, and they coordinate through a shared task register and per-session inboxes, all plain
files on this machine. The `teamrig` command is on your Bash and PowerShell PATH while the plugin is enabled.

This page is the model and the daily loop. The detail lives beside it:

| File | What it holds |
| --- | --- |
| [commands.md](commands.md) | Every command: its flags, an example and what it prints |
| [tasks.md](tasks.md) | Task statuses and what each needs, inbox lines and messages, check flags, week plans, skills |
| [workflows.md](workflows.md) | Step by step: a work block, handing work over, closing a task, a handover, a helper, a lead checkpoint |
| [hooks.md](hooks.md) | The four hooks, what each injects or blocks, and permissions |
| [errors.md](errors.md) | Every common refusal and usage error, with its fix |
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
- **Task register**: an append-only log of task events. Every ask that creates work is a task with an id like
  `T12`, an owner session, a priority `p1` (most urgent) to `p5`, and a status. Only the task's owner sets its
  status.
- **Inbox**: one file per session. A line there is a note the receiver reads at its next work block or prompt;
  it never wakes an idle session.
- **Message**: a Claude Code message from one session to another. It wakes the receiver, so it is only for a
  result it needs now, a decision, a blocker, a conflict or an incident. teamrig has no message command; the
  rules only say when to send one and how long it may be.
- **Hooks**: at session start teamrig injects the team rules and who you are; at each prompt it shows you new
  inbox lines; before a shell command it guards pushes to protected branches; at the end of a turn it
  may ask for a handover when your context is large.
- **Tree of teams**: a team may have a parent team. Sub-team leads report to their parent lead, and the root
  lead is the only one the human talks to. At most 3 levels and 8 child teams under one team.

## Which session you are

A command that acts for a session needs to know which one: pass `--session <id>`, or set `$TEAMRIG_SESSION`.
A tab started by `teamrig open <id>` has `$TEAMRIG_SESSION` and `$TEAMRIG_TEAM` set already. Otherwise the
session-start context says "pass --session <id> to every teamrig task and inbox command": do that on every
command.

`teamrig inbox read --session <id>` also ties this Claude Code session to that id (it records a mark with Claude
Code's session id), so the hooks know you from then on. Run it first in a tab teamrig did not open, and again
after `/clear`, which starts a new Claude Code session. A tab whose Claude Code title (`claude --name`, `/rename`) is
a session's id or current name binds itself at its first prompt, and the hook says so; nothing is marked read.

If you do not know which session you are, run `teamrig who` and ask the user. Never guess.

## Where things are

A command finds its team from `$TEAMRIG_TEAM`, else the nearest `.teamrig.json` (`{"team": "<id>"}`) in the
current folder or above it, else in `$CLAUDE_PROJECT_DIR` or above. Everything else is under the kit home,
`$TEAMRIG_HOME`, else `~/.teamrig`:

```text
~/.teamrig/teams/<team>/
  config.json            sessions, roles, names and every setting (teamrig config validate checks it)
  rules.md               the team's own rules, injected after the core rules (optional)
  backups/               old configs kept by teamrig config migrate
  handover/<id>.md       a session's handover, written before a context refresh
  state/
    events.jsonl         the task register, one event per line, append-only
    inbox/<id>.md        one inbox per session id
    inbox-marks.jsonl    how far each session has read its inbox
    renames.jsonl        the rename log
    refresh/             context-refresh state
    model-notices/       the model notices each session was shown
    logs/                teamrig test's whole outputs, test-<session>-<n>.log, the newest 20 each
```

The config's `paths` (`state`, `inbox`, `skills`) and `refresh.handoverDir` can move these. Skills are read
from `~/.claude/skills` unless `paths.skills` says otherwise. Never edit `events.jsonl`, the inboxes or the logs
by hand: every change goes through a command, which locks, checks and appends.

## The daily loop

At the start of each work block, in one Bash call:

```sh
teamrig inbox read --session api && teamrig list --session api
```

Then work your list in priority order: `p1` before `p2`, and inside a priority the earlier due date first.

```sh
teamrig set T4 --session api --status in-progress
# ... do the work, commit it, verify it ...
# shipped, but its proof comes later (a night's flow, a measurement)? set it verifying, with a date to verify by:
# teamrig set T4 --session api --status verifying --note "tonight's run is clean"
teamrig set T4 --session api --status done --note "signup endpoint merged" --evidence "PR #12, 41 tests pass" --skill none
```

Work that is not on your list yet is a task too: `teamrig add` it before you start it. When someone else must do
something, add the task for them (`--owner <their id>`) and tell them in one inbox line, or a message if it is
urgent. See [workflows.md](workflows.md) for each step in full.

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
