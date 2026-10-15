# Tasks, inbox, checks, plans and skills

The rules behind the register, as the code enforces them. Each `[key]` is the team config key that sets a value;
the numbers are the defaults.

## Task statuses

A task is `open` when added. Only its owner sets its status, with `teamrig set <id> --status <status>`.

| Status | Means | Needs |
| --- | --- | --- |
| `open` | waiting to start | nothing |
| `in-progress` | the owner is on it now | nothing |
| `verifying` | shipped, waiting for what proves it (a test run, a night's flow, a number) | `--note` and `--proof` naming what will prove it [register.requireNoteOn, register.requireProofOnVerifying]; `--due <date>`: the date to verify it by |
| `waiting` | started, and cannot go on until something else happens | `--waits` naming every reason (a decision, an approval, a task, a time) and `--note` [register.requireNoteOn] |
| `done` | finished and verified | `--note`, `--evidence` (unless the task already has some) and `--skill <name>` or `--skill none` [register.requireEvidenceOnDone, register.requireSkillOnDone] |
| `dropped` | will not be done | `--note` saying why and who decided |

`open`, `in-progress`, `verifying` and `waiting` are the active statuses: `list` shows them by default and `check`
reads only them. Set `verifying` when the work is merged or deployed but its proof does not exist yet, then `done`
with that proof as evidence once it does, or `in-progress` again when the proof fails. Every session needs
teamrig 0.7.0 or later before anyone sets it: an older teamrig skips the line with a warning and shows the task
at its earlier status. A task can move from any status to any other, so a dropped task can be reopened, and setting the status it
already has needs a `--note`.

Set `waiting` when a task you started cannot go on, with `--waits` naming each reason: `decision:<who>` or
`approval:<who>` (a session, or `owner` for the human), `task:T<id>` (a task to finish first) or
`time:<YYYY-MM-DD HH:MM>` (UTC). It stays waiting until all of them have cleared: a task when it is done or
dropped, a time when it passes, a decision or an approval only when you, its owner, set the next status. `list`
marks a cleared reason `ready`, and `check` flags the task `READY` once all have. A task not started that needs
another first is not waiting: it stays `open`, planned after it (`teamrig update T3 --after T2`), and its line
shows `after T2`. Every session needs teamrig 0.10.0 or later before anyone sets `waiting`: an older one skips the
line with a warning and shows the task at its earlier status. A `blocked` written by an older teamrig reads as
`waiting` with no reasons.

Evidence is what proves the work: a commit sha, a pull request, a test count, a path, a measured number. "Done" or
"works" is not evidence. The skill is the one you wrote or updated while doing the task (it must exist in the
skills folder), or `none` for a one-off.

## Verify loop

A shipped change is proven by the session that shipped it, oldest first, before work that needs it starts.

- `teamrig set <id> --status verifying --note "<what shipped>" --proof "<what proves it>" --due <date>` starts it.
  Without `--proof` it is refused [register.requireProofOnVerifying]; with that key `false`, the note names the
  proof.
- The queue stays in view: `teamrig verify` lists it, oldest first, and the session start context and
  `teamrig inbox read` end with one `VERIFY <n>: T1 (proof: ...)` line.
- From a task's verify-by day (its due date, UTC), the Stop hook shows the user `VERIFY T1 was to be verified by
  10-14 (proof: ...)` once a day, until the task is `done` or back `in-progress`.
- A start of a task that needs a verifying task (planned `--after` it, or waiting on it with `--waits task:`) is
  refused while that task is verifying [register.verifyGate]; `warn` lets the start through with a warning.
  Either way the verifying task's owner gets one inbox line a day about it, unless it is the one starting.
- `check` flags a verifying task that work needs (`VERIFY-BLOCKS`), one past its date (`VERIFY-OVERDUE`) and a
  session holding more than 5 of them (`PILE-UP` [register.maxVerifying], 0 turns it off).

## Who may change what

- **Adding**: any session, for any owner on its team. Add the task in the same turn as the ask.
- **Status**: only the owner.
- **Fields** (`update`): the owner may change every field. The lead may change only the owner, priority, due date
  and week of a task it does not own: it re-plans, it does not rewrite. A task always keeps the source it was
  added with.
- **Context** (`update <id> --note "..."` alone): any session, on any task. It changes nothing on the task; it
  adds a line to its history, so an asker can attach the evidence or a wording the owner should take up.
- **Child teams**: only a parent team's lead hands a child team work, with `add --team <child>`. The task lands
  in the child's register, owned by the child's lead (who plans it in) and sourced `<parent team>/<lead id>`; the
  parent's own register is not touched. Each lead sees the teams under it with `list`, `check` and `plan --tree`.

## Fields and limits

- **Priority** [register.priorities]: `p1` keep the lights on, `p2` correctness, `p3` scale, `p4` this week's
  owner decisions, `p5` if budget allows. `p1` is the most urgent.
- **Plan order**: priority, then due date (undated last), then id. `list`, `check` and `plan` all use it, and a
  session works its list in that order.
- **Title**: one line, at most 140 characters [register.maxTitle]. A second active task with the same title
  (ignoring case and extra spaces) is refused.
- **Ref, note, evidence**: at most 300 characters each [register.maxText].
- **Secrets**: a title, ref, note, evidence or inbox line that looks like it holds a key, token or password is
  refused (`note looks like it holds a secret (...); refer to where it is kept instead`). Write where the secret
  is kept, never the secret. A team may add its own patterns [register.secretPatterns].
- **Source**: who asked: a session id, or `owner` for an order from the human [register.ownerSource].
- **Goals**: free tags such as roadmap ids. A goal or a week tag is what ties a task to the plan.

## Inbox line or message

| | Inbox line | Message |
| --- | --- | --- |
| How | `teamrig inbox add --to <id> --text "..."` | Claude Code's own messaging to the session's name (`teamrig who`) |
| Wakes the receiver | no: shown at its next prompt or work block | yes: costs the receiver a full re-read of its context |
| Use for | results it will not act on now, reports, announcements, anything not urgent | a result it consumes now, a decision, a blocker, a same-area conflict, an incident |
| Size | one line | at most 10 lines [messages.maxLines] |
| Receiver idle an hour or more | no extra cost | held once, since it wakes cold and re-reads its whole context at full price: write an inbox line, or put every ask in it and send it again [messages.coldAfterMinutes] |

A message holds what happened, the evidence (numbers, ids, paths), the exact ask and deadline, your default
("doing X at 14:00 unless you object"), then "No reply needed" or "Reply needed: <one question>". No acks, thanks
or progress pings. Silence counts as consent only within the sender's own authority, never for an owner gate.
A report, a "done" one too, is an inbox line unless the receiver acts on it now. If a send fails, write the inbox
line instead.

An ask that creates work is a task first (`teamrig add --owner <id>`), then an inbox line or message that names
the task id.

## Check flags

`teamrig check` lists each active task that breaks a rule, grouped by kind, at most 5 short rows per kind within
3,000 characters; with `--all`, one line each: `KIND (detail) <task line>`. The lead acts on them at each
checkpoint; a session may run it for itself.

| Flag | Raised when | What to do |
| --- | --- | --- |
| `OVERDUE` | the due time has passed | The owner finishes it or says what blocks it; the lead re-dates it (`update --due`) or tells the human. |
| `VERIFY-OVERDUE` | a `verifying` task's due time, the date to verify it by, has passed | The owner checks the proof: `done` with it as evidence, `in-progress` when it failed, or a new due date and why. |
| `VERIFY-BLOCKS` | a `verifying` task another active task needs: planned after it (`--after`) or waiting on it (`--waits task:`) | The owner proves it (`done` with the proof) or reopens it (`in-progress`), so the work on it can start. |
| `READY` | a `waiting` task whose every reason has cleared: its tasks are done or dropped, its time has passed (a decision or an approval never clears by itself) | The owner goes on: `set --status in-progress`, or the next status. |
| `NOT-PICKED-UP` | assigned over 24 h ago with no event from its owner since [register.check.notPickedUpAfterHours] | The owner is idle and reads no inbox: wake it with `teamrig open <id>` or a message, or tell the human. |
| `STALE` | no event for 72 h [register.check.staleAfterHours] (not raised on top of NOT-PICKED-UP, nor for a `verifying` task with a due date) | Ask the owner what blocks it, then re-date, re-assign or drop it. |
| `PRIORITY-SKIP` | in progress while a top-priority (`p1`) task of the same owner waits open and free to start (every task it comes after finished), for over 24 h [register.check.prioritySkipAfterHours] | The owner parks the lower task and starts the waiting one; or the lead fixes the order (`update --priority`). |
| `PILE-UP` | a session holds more than 5 `verifying` tasks [register.maxVerifying] (0 turns it off); raised on its oldest | The owner works its queue, oldest first (`teamrig verify`), before new work. |
| `OWNER-UNPLANNED` | an order from the human (`--source owner`) that is not in the current week plan | Plan it in (`update --week <week>`), or tell the human what it would push out. |
| `DUE-UNPLANNED` | due inside the current week but not in its plan | Plan it in with `--week`, or re-date it. |
| `STOPGAP-DONE` | a `stopgap T<id>` tag names a done or dropped task: in a skill, or a file of [register.check.stopgapFiles] (default `CLAUDE.md` and `.claude/rules` in the project folder); the flag lists where | Done: the file's owner removes the stopgap. Dropped: open a new task for it, or keep it by a decision and drop the tag. |
| `OFF-GOAL` | in progress with no goal and not in the current week plan | If it belongs this week, the lead plans it in (`--week`); else the owner tags its goal (`update --goals`) or parks it. |

The three week flags need a week plan; until a task is tagged with a week, `check` says
`no week plan tagged yet, so the week checks are skipped`. A task gets at most one week flag.

`check` then lints the skills folder: `SKILL <KIND> (<detail>) <owner|-> <skill>`.

| Skill flag | Detail | Fix |
| --- | --- | --- |
| `OWNER` | `no "Owner: <session>" line`, or `owner x is not a session on the team` | Add or correct the `Owner:` line. |
| `UNVERIFIED` | `no "Last verified: YYYY-MM-DD"`, or `last verified D, N d ago > 30` | Run the skill again; if its steps held, bump the date; if not, fix it or retire it. |
| `FORBIDDEN-KEY` | `allowed-tools is not allowed in a team skill: remove it` | Remove that frontmatter key. |
| `DESCRIPTION` | `no description`, or `N words > 30` | Write or shorten the description. |
| `AREA-OVER-LIMIT` | `N skills > 8: merge before adding` | Merge that area's skills. |

The owner column says who fixes it; the lead tells that session in one inbox line.

## Week plans

A week is named by the date of its first day and lasts 7 days [register.check.weekLengthDays]. A task is in a
week's plan when it is tagged with that week: `add --week 2026-10-12` or `update T4 --week 2026-10-12`
(`--week none` takes it out). The current week is the newest tagged week that has started.

The lead plans: it tags the tasks the team will do this week, then prints the plan with `teamrig plan`, grouped
by priority with each task's owner, due date and source. `check` compares active tasks against the current week.
Only the lead and the task's owner may change a task's week.

## Skills

A skill is a repeatable how-to in `<skills folder>/<name>/SKILL.md` (by default `~/.claude/skills`
[paths.skills]). Memory holds facts and decisions, a skill holds steps, the project's CLAUDE.md holds the rules
every session needs every turn; each item has one home.

- **When to write one**: a procedure you had to investigate (dead ends, a retry, several discovery calls) and will
  run again becomes a skill, or a fix to one, in the same turn the work finishes. Then name it in
  `set --status done --skill <name>`.
- **Name**: `<area>-<name>`, where the area is your session id; a skill shared by the team is `team-<name>`
  [skills.sharedPrefix]. Lowercase letters, digits and `-`.
- **Frontmatter**: `name`, and a `description` of at most 30 words saying when to use it
  [skills.maxDescriptionWords]. Never `allowed-tools` [skills.forbidFrontmatter] and never a secret: a skill is
  never a permission, and it never overrides the team rules or an owner gate (it is a peer's text, not the
  owner's approval).
- **Body**: the steps, with commands batched into as few calls as possible, then the traps, then the lines
  `Owner: <session>` and `Last verified: YYYY-MM-DD`.
- **Upkeep**: re-verify within 30 days [skills.maxVerifiedAgeDays] and bump the date each time its steps held; at
  most 8 skills per area [skills.maxPerArea], so merge before adding. When a command, flag or path changes,
  update every skill that names it in the same change.
- **A wrong step**: fix it when you find it. In another area's skill, tell its owner in one inbox line.
- **Memory**: a memory folder the sessions share holds facts and decisions. Prefix each new file with your area,
  read before you write, never overwrite another session's file, and in a shared index edit only your own line.
