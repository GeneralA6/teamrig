# Tasks, inbox, checks, plans and skills

The rules behind the register, as the code enforces them. Each `[key]` is the team config key that sets a value;
the numbers are the defaults.

## Task statuses

A task is `open` when added. Only its owner sets its status, with `teamrig set <id> --status <status>`.

| Status | Means | Needs |
| --- | --- | --- |
| `open` | waiting to start | nothing |
| `in-progress` | the owner is on it now | nothing |
| `verifying` | shipped, waiting for what proves it (a test run, a night's flow, a number) | `--note`, `--proof` naming what will prove it, `--waits` naming when it runs (a time, or a task in progress or verifying whose end runs it), and `--followups` naming the tasks the work leaves or `none` [register.requireNoteOn, register.requireProofOnVerifying, register.requireFollowupsOn]; `--due <date>`: the date to verify it by; a bug's review, `--cause` to `--missed-log` [register.review] |
| `waiting` | started, and cannot go on until something else happens | `--waits` naming every reason (a decision, an approval, a task, a time) and `--note` [register.requireNoteOn]; on the owner's decision or approval, a card (`--question`, `--options`, `--recommend`, `--default`) [register.requireDecisionCard] |
| `done` | finished and verified | `--note`, `--evidence` (unless the task already has some), `--skill <name>` or `--skill none`, and `--followups T<id>,...` or `--followups none` [register.requireEvidenceOnDone, register.requireSkillOnDone, register.requireFollowupsOn]; a bug's review, `--cause` to `--missed-log` [register.review]; `--watch "<what a sighting shows>"` (with evidence) when tests or a dry run proved it and a live sighting is still to come |
| `dropped` | will not be done | `--note` saying why and who decided; `--followups` may name the tasks the work moved to |

`open`, `in-progress`, `verifying` and `waiting` are the active statuses: `list` shows them by default and `check`
reads only them. Set `verifying` when the work is merged or deployed but its proof does not exist yet, then `done`
with that proof as evidence once it does, or `in-progress` again when the proof fails. When tests or a dry run
already proved it and only a live sighting is left (a night's run, a page a user opens), set it `done` with
`--watch` instead. Every session needs
teamrig 0.7.0 or later before anyone sets it: an older teamrig skips the line with a warning and shows the task
at its earlier status. A task can move from any status to any other, so a dropped task can be reopened, and setting the status it
already has needs a `--note`.

Set `waiting` when a task you started cannot go on, with `--waits` naming each reason: `decision:<who>` or
`approval:<who>` (the lead, or `owner` for the human; a child team's lead asks its parent team's lead, `app/lead`), `task:T<id>` (a task to finish first) or
`time:<YYYY-MM-DD HH:MM>` (on the team's clock unless marked UTC). It stays waiting until all of them have cleared: a task when it is done or
dropped, a time when it passes, a decision or an approval only when you, its owner, set the next status. `list`
marks a cleared reason `ready`, and `check` flags the task `READY` once all have. When the lead records the owner's
answer (`update <id> --decided`), the wait on the owner goes at once and the task stays waiting, marked decided
(`owner decided, by lead`; `show` prints the answer) and `READY`, until you act on it and set the next status. A task not started that needs
another first is not waiting: it stays `open`, planned after it (`teamrig update T3 --after T2`), and its line
shows `after T2`.

While a task waits, keep working your other tasks in priority order: those that do not come after it, and not the
same change. At your next turn end after the `set`, the Stop hook sends you back once when you own such a task
([how](hooks.md#end-of-a-turn-keep-working-while-a-task-waits)); with nothing left to start, end the turn.

What a task needs is the tasks it comes after and the tasks it waits on. A task takes the earlier due date of an
active task that needs it, at any depth (its effective due, `due 10-17 (from T9)` on its row), so the work a dated
task needs comes first: lists, `plan`, the meeting's late tasks and `check`'s date flags go by it. A row names
another session's active task that needs it (`· needed by T9 (api, due 10-17)`), `teamrig show T9 --tree`
prints both ways of the tree and the next move, and `teamrig start` lists the other sessions' tasks waiting on
yours (`WAITING ON YOU`). A plan or a wait that would close a loop (`T3 -> T9 -> T3`) is refused, since no task
in a loop can finish: make the step one of them needs its own task.

A peer's work is never a decision or an approval, so `approval:api` is refused: wait on that work by its task.
`teamrig set T3 --status waiting --ask api --text "<the work>"` adds it as api's task (from you, at T3's priority
and goals, its description naming T3), tells api, and sets T3 waiting on it, in one write; `--due` is then the
asked task's due date. A budget hold is a time (`time:<date>`), never an approval. A new decision or approval wait
posts the lead one inbox line (`T3 waits on your approval: <the card's question, else the note>`; an owner wait too,
since the lead keeps the owner's decision queue), unless the lead set it. The lead asks the owner in batches
(`teamrig decisions`), so an owner wait's line ends with when the owner hears of it: `AT ONCE` when it is due
before the next batch (the line then wakes the lead; through a sub-lead you are given the `--wake now` line to post
the lead; with wakes off, message the lead), else in the batch due now or the next.

A wait on the owner's decision or approval needs a card, so the owner decides from it alone, never from a bare
task number [register.requireDecisionCard]: `--question` (what is decided), `--options` (the choices with their
numbers, separated by `|`: at least two for a decision; none or as many for an approval), `--recommend` (which,
and why) and `--default` (what happens with no answer by the due date). Each part says at least 3 plain words
besides task ids. A wait on the lead may carry one too; any other status refuses the flags. Setting `waiting`
again keeps the card, and a flag given then changes only its part. `show` prints the card, and the meeting
agenda reads it out with the title of each other task it names. An owner's order approves its own work and proof,
so a task the owner ordered asks the owner only with `--why-ask` (how the order must change, what new it needs, or
why only the owner can see the result), printed as `why asked:`; `set` refuses one without it, and `check` flags
an older one `OWNER-ORDERED`. Only an owner gate [ownerGates] or a business decision is the owner's to decide, so
a wait on the owner's decision names it with `--gate` (one of the owner gates, or `business`), printed as `gate:`;
`set` refuses one without it, and `check` flags an older one `UNGATED`. Any other question is the session's or its
leader's, however many good answers it has: decide it, or wait on your leader (`--waits decision:<leader>`).

Every session needs teamrig 0.10.0 or later before anyone sets `waiting`: an older one skips the
line with a warning and shows the task at its earlier status. A `blocked` written by an older teamrig reads as
`waiting` with no reasons.

Evidence is what proves the work: a commit sha, a pull request, a test count, a path, a measured number. "Done" or
"works" is not evidence. The skill is the one you wrote or updated while doing the task (it must exist in the
skills folder), or `none` for a one-off.

## Verify loop

A shipped change is proven by the session that shipped it, oldest first, before work that needs it starts.

- `teamrig set <id> --status verifying --note "<what shipped>" --proof "<what proves it>" --waits "time:<YYYY-MM-DD HH:MM>" --due <date> --followups none`
  starts it (name the tasks the work leaves in place of `none`).
  Without `--proof`, or without `--waits` naming when the proof runs, it is refused
  [register.requireProofOnVerifying]; with that key `false`, the note names the proof. A proof runs at a time
  (`time:<date>`, for an event that comes on a date) or when a task in progress or verifying ends (`task:T<id>`);
  one with neither would be put off without end. `approval:owner` (with a card) may stand beside one, for a proof
  only the owner can try, which then reaches the meeting's DECISIONS.
- A proof another party makes is that party's task: ask it with `teamrig set <id> --status waiting --ask <session>
  --text "<the run or check>"`, which adds it and makes the task wait on it. Once that task has started, set yours
  verifying with `--waits task:T<id>`: a proof waits only on a task in progress or verifying.
- Set verifying again without `--waits` and the waits stay while none cleared; once one cleared the proof is due
  now, and keeping it is refused. `check` flags the task `READY` once all cleared.
- A change tests or a dry run proved, whose proof left is a live sighting (a night's run, a page a user opens),
  closes `done` with its evidence and `--watch "<what a sighting shows>"`. `teamrig verify`, the start context and
  `teamrig inbox read` list it under `WATCH` until it is set `done` again without `--watch`, or reopened
  (`in-progress`) if the sighting shows a fault.
- The queue stays in view: `teamrig verify` lists it, oldest first, and the session start context and
  `teamrig inbox read` end with one `VERIFY <n>: T1 (proof: ...)` line.
- From a task's verify-by day (its due date, on the team's clock), the Stop hook shows the user `VERIFY T1 was to be verified by
  10-14 (proof: ...)` once a day, until the task is `done` or back `in-progress`.
- A start of a task that needs a verifying task (planned `--after` it, or waiting on it with `--waits task:`) is
  refused while that task is verifying [register.verifyGate]; `warn` lets the start through with a warning.
  Either way the verifying task's owner gets one inbox line a day about it, unless it is the one starting. Once the
  proof exists, `--met "<what shows it>"` lets the start through, and the owner's line asks it to set the task
  `done` or reopen it.
- A session's first start of a new task is refused while one of its own verify steps is due [register.verifyGate]:
  its proof's waits cleared, its verify-by day came, or it holds more than 5 verifying tasks (the oldest it can
  act on) [register.maxVerifying]. Clear each: `done` with the proof, `in-progress` if it failed, verifying with
  `--waits` for when its proof runs, or a new `--due` with a `--note` saying why. A task already started is never
  held.
- A proof put off to other waits 2 times in a row [register.maxReparks] cannot be put off again: setting the task
  verifying with other waits is refused, so its owner runs the proof (`done`), closes it `done` with `--watch` if
  tests or a dry run proved it, or reopens it (`in-progress`). Keeping
  the same waits, or naming the first waits of a task that had none, is not putting it off.
- `check` flags a verifying task that work needs (`VERIFY-BLOCKS`), one past its date (`VERIFY-OVERDUE`), one put
  off to the limit (`REPARKED`) and a session holding more than 5 of them (`PILE-UP` [register.maxVerifying], 0
  turns it off).

## Who may change what

- **Adding**: any session, for any owner on its team. Add the task in the same turn as the ask.
- **Status**: only the owner.
- **Fields** (`update`): the owner may change every field. The lead may change only the owner, priority, due date,
  week and plan order (`--after`) of a task it does not own: it re-plans, it does not rewrite. A task always keeps the source it was
  added with.
- **Context** (`update <id> --note "..."` alone): any session, on any task. It changes nothing on the task; it
  adds a line to its history, so an asker can attach the evidence or a wording the owner should take up.
- **Asks across teams**: any session asks another team of its tree for work with `add --team <team>`. The task
  lands in that team's register, sourced `<asker's team>/<id>`, owned by `--owner` (a session of that team, by id
  or name), else by that team's lead (who plans it in); when the owner is not the lead, the lead gets a copy line
  and may reorder or reassign it (`update --priority|--after|--owner`). The asker's own register is not touched;
  once the task is done or dropped, the asker gets one inbox line (`web/T1 done: <title> | evidence: ...`), or its
  team's lead once the asker left that team. `--team` naming your own team is a plain add. Each lead sees the teams
  under it with `list`, `check` and `plan --tree`.
  The teams of a tree number their tasks from one count: an id names one task in the whole tree, whichever team
  holds it. A wait or an `after` may name another team's task (`--waits task:T9`): the task stays held while T9
  is open, `show T9` prints it read-only, and the wake check tells its owner once that team finishes it.

## A task or a step

A task is one piece of work that one owner ships and proves. A step is work inside a task: it lands in the task's
change and the task's proof proves it, so it needs no row of its own. For each piece of work, the first line that
holds decides:

1. **Another session does it**: its own task (`add --owner <id>`, or `set <yours> --status waiting --ask <id>`
   when yours cannot go on without it).
2. **It waits on what the rest does not, or needs another priority or an earlier due date**: its own task, so its
   wait or date shows on its own row and does not hold up the rest. A wait is on a task (a goal is waited on by
   its tasks), a time, or an owner decision or approval; a later owner call (a delete after a swap) is a wait the
   work before it does not have. A wait that holds the whole task is the task's own: set it `waiting`. "Before
   it grows" is a reason, not a date.
3. **It is more than one commit and has a proof of its own** (the run, number or live check that shows it works,
   not its specs): its own task, so it reaches `verifying` and `done` when it is ready. A fix you cannot yet name
   as one commit counts as more.
4. **Else it is a step**: list it in the task's description (`update --description`) when it is known at the
   start, else add a context line when it turns up (`update <id> --note "step: ..."`). A one-commit fix you make
   in the block you find it needs no entry at all (rule 5).

Two sizes need a second look. Too coarse: a task that, once started, will not reach `verifying` or `done` within
72 h [register.check.staleAfterHours] splits at its proof points, so each part reports when it is ready. Too
fine: one-commit leftovers of one owner that wait on nothing share one task (`Follow-ups of T12`), a step each,
not a row each; a step that grows past a commit or gains a wait moves out, by the list above.

When a task splits, its row keeps the steps that stay (retitle it with `update --title` when they change what it
is), and each part that moves out gets a new row with the task's source (`add --source`), priority and goals, and
its week while that week is current (`set --ask` copies the priority and goals): `check` reads each task's own
tags, so a part without them is flagged `OFF-GOAL` or `DUE-UNPLANNED`. A row left with no step is dropped, its
`--followups` naming the new rows.

A part ties to the work it serves by plan order, since the register has no parent field: the whole is planned
after its parts (`teamrig update T9 --after T10,T11`), so each part takes the whole's due (`due 10-17 (from T9)`),
its row names the whole (`needed by T9`), and `teamrig show T9 --tree` prints both. That whole is the parent task
rule 5 names. Keep a whole only when it has a proof beyond its parts (a live check across them); when it is just
their sum, a goal tag ties the parts together, and the old row stays only for the steps left in it.

Three shapes, split by the list:

- **A bundle of unrelated follow-ups** ("Review follow-ups": say why a cache is kept and what it costs, which
  another task may make moot; fix two stale comments; the nightly export overruns its slot past 13 customers).
  The cache question waits on the other task: its own task, planned after it (line 2). The export fix has no date
  but is more than a commit, proven by a night past 13 customers: its own task (line 3). The comments are one
  commit (line 4): fix them now and drop the row, its followups naming the two new tasks; else the row is
  retitled for them.
- **One fix in several steps** ("Timing audit defects 3-9": seven gaps, one owner, one priority, one proof, a
  night whose timings add up): one task, a step each in its description (line 4). A defect that turns out to
  need the owner's call moves out (line 2).
- **A step of a plan that has its own wait** ("Migration step 3: swap in the cleaned table", after step 2's
  parity run and the owner's OK, then retire the old table on the owner's call): its own task, planned after
  step 2 and set `waiting` on the OK (line 2); the dry-run count for the owner is a step of it (line 4); retiring
  the old table waits on a later owner call, so it is a task planned after the swap (line 2). The plan's goal tag
  ties its steps together, with no task for the whole.

## Fields and limits

- **Priority** [register.priorities]: `p1` keep the lights on, `p2` correctness, `p3` scale, `p4` this week's
  owner decisions, `p5` if budget allows. `p1` is the most urgent the config names. Above them every team has
  teamrig's own `p0`, for urgent work done right now: `check` flags an open one `URGENT`, so its owner parks the task
  in hand and starts it; a session held by its budget still wakes for it, and it goes on past the daily stop, helpers
  too.
- **Plan order**: by the first of these on which two tasks differ, each a field the task has: pinned (the one
  task per owner that a leader above it pinned with `update --pin`, above every other key); priority (`p0`, then `p1` first); in progress (a started task stays on top within its priority); effective due (the earliest first, undated
  last); what it unblocks (the best priority among the active tasks that need it, then the most of them); in the
  week plan in force; size (the smallest first, unsized last); then id (the oldest first). `list`, `check` and
  `plan` all use it, and a session works its list in that order. A `list` row ends with the key that put it ahead
  of the next row: `· ahead: in progress`, `· ahead: due`, `· ahead: unblocks T9 p1 +2` (the best task that needs
  it, its priority, how many more), `· ahead: in week 10-19` or `· ahead: size 0.5%`; no reason means the pin or the
  priority (the row shows them) or the id decided.
- **Title**: one line, at most 140 characters [register.maxTitle]. A second active task with the same title
  (ignoring case and extra spaces) is refused.
- **Description**: what the task is and why, in plain words for a person who has not seen the ask; newlines are
  kept, at most 2,000 characters. `add` needs one [register.requireDescription]; its owner changes it with
  `update --description`, and `show` prints it under the title. A status note then says only what changed.
- **Ref, note, evidence**: at most 300 characters each [register.maxText].
- **Secrets**: a title, description, ref, note, evidence or inbox line that looks like it holds a key, token or password is
  refused (`note looks like it holds a secret (...); refer to where it is kept instead`). Write where the secret
  is kept, never the secret. A team may add its own patterns [register.secretPatterns].
- **Source**: who asked: a session id, or `owner` for an order from the human [register.ownerSource].
- **Goals**: the goals the task serves, by tag (`--goals A1,B2`), or `--goals none` when it serves none. A goal or a
  week tag is what ties a task to the plan. The lead records the team's goals, each with its window and every slip
  of its target (`teamrig goal add`, `goal set`, `goal list`, `goal show`). How tags meet them is the
  [register.goals] mode. `free` (the default) takes any tag, `checked` refuses a tag that is not a goal of the team or
  a team above it (`goal B9 is not a goal record of the team or a team above`: fix the tag, or have the goal
  added), and `required` also needs an owner-asked, p0 or p1 `add` to name its goal or say `none` (`an
  owner-asked task names its goal: --goals <tag>, or --goals none`).

## Inbox line or message

| | Inbox line | Wake line | Message |
| --- | --- | --- | --- |
| How | `teamrig inbox add --to <id> --text "..."` | the same with `--wake now` | Claude Code's own messaging to the session's name (`teamrig who`) |
| Wakes the receiver | no: shown at its next prompt or work block | an idle one, once for the lines posted within 2 minutes [wake.batchSeconds]; a busy one sees it at its next tool call's end | yes, each message: costs the receiver a full re-read of its context |
| Use for | results it will not act on now, reports, a "done" one too, announcements | a result it acts on now, a decision, a blocker, a same-area conflict, an incident | a live back-and-forth |
| Size | one line | one line | at most 10 lines [messages.maxLines] |
| Receiver idle an hour or more | no extra cost | wakes it cold, once | held once, since it wakes cold and re-reads its whole context at full price: write a line (a wake line if it must act now), or send it again for a live back-and-forth [messages.coldAfterMinutes] |
| To the lead during the daily meeting | read after the meeting | wakes the lead after the meeting | held, unless it starts with `CRITICAL` (`teamrig meeting start`) |

A wake line or a message says what happened, the evidence (numbers, ids, paths), the exact ask and deadline, your
default ("doing X at 14:00 unless you object"), then "No reply needed" or "Reply needed: <one question>". No acks,
thanks or progress pings. Silence counts as consent only within the sender's own authority, never for an owner gate
or for a change that breaks a caller you named. A report, a "done" one too, is a line without `--wake`. If a send
fails, write the line instead.

With `wake.enabled: false` no line wakes anyone, so a message is how to wake a peer: one only for a result it acts on
now, a decision, a blocker, a same-area conflict or an incident, and everything else an inbox line. Rule 3 of the
core pack says whichever of the two holds for the team.

An ask that creates work is a task first (`teamrig add --owner <id>`): `add` posts the owner an inbox line naming
the task id, so only urgent work needs a message too. When a task you started cannot go on without that work,
`teamrig set <your task> --status waiting --ask <id> --text "<the work>"` adds it and waits on it at once.

## Check flags

`teamrig check` lists each active task that breaks a rule, grouped by kind, at most 5 short rows per kind within
3,000 characters; with `--all`, one line each: `KIND (detail) <task line>`. The lead acts on them at each
checkpoint; a session may run it for itself.

| Flag | Raised when | What to do |
| --- | --- | --- |
| `URGENT` | an open `p0` task (teamrig's own level for urgent work, above every configured one) free to start (every task it comes after finished); with a due, the detail names the lead's deadline burst (`burst start deadline --task <id> --by <its due> ...`) | The owner parks the task in hand and starts it now; the lead may run the burst to pay for finishing it by its due. |
| `OVERDUE` | the effective due time has passed: its own, or the earlier due of an active task that needs it (the detail names it: `due 10-14, from T9`) | The owner finishes it or says what blocks it; the lead re-dates it (`update --due`) or tells the human. |
| `VERIFY-OVERDUE` | a `verifying` task's due time, the date to verify it by, has passed | The owner checks the proof: `done` with it as evidence, `in-progress` when it failed, or a new due date and why. |
| `LOOP` | active tasks need each other in a circle (`T2 -> T5 -> T2`), planned after or waiting on one another, as an older teamrig could write; raised on the lowest-numbered one | None of them can finish: the owner makes the step its own task (the flag prints the command), or the lead re-plans it (`update --after`). |
| `VERIFY-BLOCKS` | a `verifying` task another active task needs: planned after it (`--after`) or waiting on it (`--waits task:`) | The owner proves it (`done` with the proof) or reopens it (`in-progress`), so the work on it can start. |
| `READY` | a `waiting` task whose every reason has cleared, or a `verifying` task whose proof waits all have: its tasks are done or dropped, its time has passed (a decision or an approval never clears by itself); or a task decided, the owner's answer recorded with `update --decided`, whose waits left have cleared | The owner goes on: `set --status in-progress`, or the next status; for a verifying one, checks the proof now; for a decided one, acts on the answer `show <id>` prints. |
| `NO-REASON` | a `waiting` task with no reason, as a line from an older teamrig reads | The owner sets what it waits for (`set --status waiting --waits ...`) or its next status. |
| `NO-CARD` | a `waiting` task waits on the owner's decision or approval with no card, as one set before cards reads [register.requireDecisionCard] | The owner sets it waiting again with the card (`set --status waiting --waits ... --question ... --options ... --recommend ... --default ...`). |
| `OWNER-ORDERED` | a task the owner ordered waits (or its proof waits) on the owner's decision or approval with no `--why-ask`, as one set before it was required, or while cards are not [register.requireDecisionCard], reads | The owner drops the wait on the owner, since the order approves its own work and proof, or sets it again with `--why-ask "<how the order must change, what new it needs, or why only the owner can see the result>"`. |
| `UNGATED` | a task waits (or its proof waits) on the owner's decision with a card naming no owner gate or business decision, as one set before `--gate` was required reads [register.requireDecisionCard] | The owner decides it, or waits on its leader, since only an owner gate [ownerGates] or a business decision is the owner's; or sets it again with `--gate "<the owner gate, or business>"`. |
| `PEER-WAIT` | a `waiting` task (or a `verifying` task's proof) waits on the decision or the approval of a session that is neither the lead nor the owner, as an older teamrig wrote | The owner waits on that work by its task instead: `set --status waiting --ask <session> --text "<the work>"`. |
| `NOT-PICKED-UP` | assigned over 24 h ago with no event from its owner since [register.check.notPickedUpAfterHours] | The owner is idle and reads no inbox: wake it with `teamrig open <id>` or a message, or tell the human. |
| `STALE` | no event for 72 h [register.check.staleAfterHours] (not raised on top of NOT-PICKED-UP, nor for a `verifying` task with a due date, nor for a `waiting` task with a `time:` reason still to come) | Ask the owner what blocks it, then re-date, re-assign or drop it. |
| `PRIORITY-SKIP` | in progress while a top-priority (`p1`) task of the same owner waits open and free to start (every task it comes after finished), for over 24 h [register.check.prioritySkipAfterHours] | The owner parks the lower task and starts the waiting one; or the lead fixes the order (`update --priority`). |
| `SELF-MADE` | a session added more than 10 tasks for itself (created by it, asked by no one else) in the last 24 h [register.check.maxSelfMadePerDay] (0 turns it off); raised on the first of them past that count still active | The lead reads them (`list --session <id> --source <id> --status all`): each must serve a goal, a parent task or the week plan, else its owner drops or parks it; a run of the same step with no progress is a loop: the owner stops and asks the lead. |
| `PILE-UP` | a session holds more than 5 `verifying` tasks [register.maxVerifying] (0 turns it off); raised on its oldest | The owner works its queue, oldest first (`teamrig verify`), before new work. |
| `REPARKED` | a `verifying` task whose proof was put off to other waits 2 times in a row [register.maxReparks] (0 turns it off); `set` refuses another | The owner runs the proof now and sets it `done`, closes it `done` with `--watch` if tests or a dry run proved it, or reopens it (`in-progress`). |
| `OVER-PACE` | a session holds more unfinished top-priority (`p1`) tasks (open, in progress or waiting) than the p1 it finished (done or verifying) in the last 7 days, past the first p1, which is in hand, once it has held tasks for 7 days; raised on the first p1 in plan order past that pace | The lead re-prioritizes: lowers the p1s that pace will not reach this week (`update --priority`), moves them to another session, or tells the human what is held. |
| `OVER-LIMIT` | the first sized to-do task of the week in force that no longer fits the weekly usage limit left, summed in plan order (`teamrig plan` shows the line) | The lead moves it and the sized tasks after it to next week (`update --week`), cuts or re-sizes work, or tells the human. |
| `OVER-SIZE` | an unfinished sized task whose cost since it was last sized, as the budget meter attributes it over the 8 UTC days it keeps, passed twice its size [register.check.overSizeMultiple] (0 turns it off); none while the W of one percent is unknown | Its owner (or the lead) re-sizes what is left (`update --size`, which counts from then on), splits the rest into its own task, or drops it; `teamrig budget --task <id>` shows where the W went. |
| `OWNER-UNPLANNED` | an order from the human (`--source owner`) that is not in the current week plan | Plan it in (`update --week <week>`), or tell the human what it would push out. |
| `DUE-UNPLANNED` | effectively due inside the current week but not in its plan | Plan it in with `--week`, or re-date it. |
| `STOPGAP-DONE` | a `stopgap T<id>` tag names a done or dropped task: in a skill, or a file of [register.check.stopgapFiles] (default `CLAUDE.md` and `.claude/rules` in the project folder); the flag lists where | Done: the file's owner removes the stopgap. Dropped: open a new task for it, or keep it by a decision and drop the tag. |
| `OFF-GOAL` | in progress with no goal and not in the current week plan | If it belongs this week, the lead plans it in (`--week`); else the owner tags its goal (`update --goals`) or parks it. |
| `NO-PROGRESS` | no goal or week-plan task moved (its owner started, noted, set waiting, shipped or closed it) since the start of the day before [register.check.goalProgressDays] (0 turns it off), while the week has usage left; the day starts at `wake.dayStartUtc`, else midnight UTC. Raised on the first planned task in plan order that its owner can move now (open or in progress) and that day already held | Its owner moves it, or the next planned task it can; the lead finds what holds the plan (a blocker, the order, a plan to re-cut) and fixes it or tells the human. |

The three week flags need a week plan; until a task is tagged with a week, `check` says
`no week plan tagged yet, so the week checks are skipped`. A task gets at most one week flag.

`check` then prints the hire flags, under a `HIRES <n> flag(s)` line printed only when there are some:
`HIRE <KIND> (<detail>) <session>: <what to do>`, the session being the area a SCALE-OUT is on or the hired session.
A session's own `start` shows the flags on itself.

| Hire flag | Raised when | What to do |
| --- | --- | --- |
| `SCALE-OUT` | more of an area's dated work (its active tasks of the top 2 priorities [hiring.scaleOut.topPriorities] with a due, their own or a needing task's) is due by a date than its pace finishes by then: the tasks it finished over the last 7 days [hiring.scaleOut.windowDays], once it finished 3 [hiring.scaleOut.minDone]. Never for the lead or a hired session, nor while the team's part of the week's projected spare (split among the teams on the Claude account) cannot pay the slice (a new hire's part of the team's daily budget today, a day until its last due or the week's pace end) or that part is unknown | The lead moves the slice it names (the latest open tasks no started work needs) to the idle hire it names, else hires for it and moves it (`hire --yes` refuses while the host has no room). |
| `RETIRE-DUE` | the burst a hired session was hired for (`teamrig hire --burst`) is over; a hire with no task is never due to retire for it: the idle pass deactivates it | A lead over it gives it its next task, or retires it (`teamrig retire <id>`). |
| `REVIEW-DUE` | a hired session's review day has passed | A lead over it keeps it to a new review day while the team still needs it (`teamrig hire <id> --review <YYYY-MM-DD> --reason "<why>" --yes`), else retires it (`teamrig retire <id>`). |

`check` then lints the skills folder: `SKILL <KIND> (<detail>) <owner|-> <skill>`. A skill a session of another team of
the tree owns, when that team reads the same folder, is left to that team's `check`, so each flag shows once.

| Skill flag | Detail | Fix |
| --- | --- | --- |
| `OWNER` | `no "Owner: <session>" line`, or `owner x is not a session on the team` | Add or correct the `Owner:` line. Until then this flag and the skill's other flags print under UNOWNED and go to the lead. |
| `UNVERIFIED` | `no "Last verified: YYYY-MM-DD"`, or `last verified D, N d ago > 30` | Run the skill again; if its steps held, bump the date; if not, fix it or retire it. |
| `VERIFIED-NOTE` | `text after the "Last verified:" date: keep the date alone, a lesson on its own line` | Cut the line to `Last verified: YYYY-MM-DD`. A lasting lesson goes on its own line (a trap bullet); a run's details go in its task's evidence. Every run then changes only the date, so two sessions verifying the skill at once never edit the same text. |
| `FORBIDDEN-KEY` | `allowed-tools is not allowed in a team skill: remove it` | Remove that frontmatter key. |
| `DESCRIPTION` | `no description`, or `N words > 30` | Write or shorten the description. |
| `SIGNATURE` | `"Signature: <regex>" is not a valid regex, so the scorecard misses its uses` | Fix the pattern: `teamrig skills scorecard` counts the skill's missed uses with it. |
| `GRANT` | `pod-exec in a.js, which auto mode does not see: with the owner's grant add "Grants: pod-exec", else drop the call`, or `"Grants: x" names no grant kind` | A script at the top of the skill's folder makes that call: get the owner's grant and name its kind on a `Grants:` line, or drop the call from the script. |
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

A skill is a repeatable how-to in `<skills folder>/<name>/SKILL.md` (by default `~/.claude/skills`, or `$CLAUDE_CONFIG_DIR/skills`
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
  `Owner: <session>` (for a shared skill, the session that owns the tool it runs) and `Last verified: YYYY-MM-DD`. Add a ``Signature: `<regex>` `` line for each tool call that
  shows the procedure run by hand (matched against the tool's name and command, such as `teamrig inbox read`):
  `teamrig skills scorecard` then counts each such run with no load of the skill as a missed use.
- **Listing**: a session teamrig launches lists another area's skill by name only, without its description, so its
  words stay out of every call [skills.otherAreas]; shared and personal skills stay in full. When other sessions run
  your skill too, name them on a `Used by: <session>, <session>` line in its body and they list it in full. The
  start line counts the skills listed by name only; a restart reads the skills again.
- **Grants**: auto mode judges a script call by its own command (`node flow.js`), never by what the script runs,
  so a script beside the SKILL.md can make a privileged call unseen. Name each kind its scripts make on a
  `Grants: pod-exec, secret-read, auth-header` line (kubectl exec; a cluster secret or a credential env variable;
  a credential header), each one the owner granted; without the grant, write the call inline or drop it.
  `teamrig check` reads the scripts beside the SKILL.md, not their specs (`a.test.ts`, `a.spec.mjs`, `test_a.py`,
  `a_test.py`): the test runner runs a spec, never the skill.
- **Upkeep**: re-verify within 30 days [skills.maxVerifiedAgeDays] and bump the date each time its steps held; at
  most 8 skills per area [skills.maxPerArea], so merge before adding. When a command, flag or path changes,
  update every skill that names it in the same change.
- **Limits**: `teamrig check` flags each skill that breaks one of the limits above. Core rule 13 names them only
  through this section, so the always-loaded pack stays short.
- **A wrong step**: fix it when you find it. In another area's skill, tell its owner in one inbox line.
- **Memory**: a memory folder the sessions share holds facts and decisions. Prefix each new file with your area,
  read before you write, never overwrite another session's file, and in a shared index edit only your own line.
