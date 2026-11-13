---
name: daily-meeting
description: Use when the lead meets the human for the daily meeting, at the human's first message of the day or when asked to start or end the meeting.
---

# The owner's daily meeting

Once a day, you, the lead, meet the human: what got done, what is late, and each decision that waits on them, as a
card they can decide from alone. The team keeps working meanwhile and leaves you inbox lines instead of messages.

## 1. Start

At the human's first message of the day, or when they ask, in one Bash call:

```sh
teamrig meeting start --session lead
```

Until the meeting ends, the `cold-send` hook holds every message to you but one starting `CRITICAL`, and tells the
sender to keep working and leave it as an inbox line. So no session is told the meeting started, and none is woken.
Then it prints the agenda:

- `GOALS`: the scoreboard of the ranked goals, best rank first: done against total, spend against size, how often the
  target slipped, what is overdue and which tasks wait; read everything after it against these goals;
- `DECISIONS`: each task waiting on the human's decision or approval, with its card facts, ranked by what it
  unblocks: an expedite first, then those that free Roadmap work, then by best score. A decision that frees only
  Improvements work waits for the weekly batch, after the daily cards on the `[focus.improvementsDay]` weekday and
  shown on no other day;
- `DEDICATED`: the waits on the human in the team's core-business areas, the sessions `[decisions.dedicatedOwners]`
  names, by owning session: never a card and never read out; each session gets its own meeting after the daily
  (step 4);
- `INCIDENTS`: the active Maintenance bugs and critical tasks, yours first, then each team's under you;
- `LATER`: the cards the human put off to a time still to come (step 4): never read out before that time, then back
  in `DECISIONS`;
- `UNGATED`: the waits on the human's decision whose card names no owner gate or business decision: never read
  them out; decide those of sessions you lead and send each its answer as an inbox line;
- `OWNER-PROOF`: the waits on the human about a test, measure or proof that names no approved number it changes,
  money it spends or data it writes: approved with the work it tests, so never read them out; tell each session
  you lead to go ahead;
- `LATE`: the active tasks past their due date, their own or the earlier one of a task that needs them
  (`due 10-14 (from T9)`), yours first, then each team's under you (`web/T2`); a team with more than 5 is one count
  line naming the command that lists them;
- `DONE`: what finished since the last meeting, in groups (owner asked, each goal, urgent p1, this week's plan);
  other work and the dropped tasks are one count line each; then each team's under you: its counts and, at 5 rows or
  fewer, its grouped rows;
- `STATS`, `HEALTH`, `FLOW` and `LIMIT`: the week's numbers of your team and the teams under it, as
  `teamrig stats --tree` prints them: give the human the Health tiles in one line, each `[bad]` one with its
  number; a `LIMIT` day sat at the usage limit, so its quiet is no slack;
- `MERGES`: under `pushGuard.pushToProtected: gated`, the branches merged with no approval since the last
  meeting, check-clean ones first: news to read, while security samples the check-clean ones weekly; yours first,
  then each team's under you (`web/front`), a team with more than 5 as one count line;
- your unread inbox lines, marked read;
- the week's use, and under it what of the planned week fits the weekly limit.

Sort `DECISIONS` before you bring them: a card stays the human's only when the owner gate or business decision it
names truly applies. Any other, a route, a merge or staffing (who does a job, a reviewer, a hire), is yours however
many good answers it has: decide it now, send its owner the answer as an inbox line so it sets the task's next
status, and tell the human in the meeting as an FYI.

Tell the human the meeting started in one line. `teamrig meeting agenda --session lead` prints the agenda again,
during the meeting or to prepare the next one.

In a tree of teams only the root team's lead holds the meeting: its `DECISIONS` also lists the waits of every team
under it, named `<team>/<id>` (`web/T2`), and a child team's lead holds none.

Your context refresh waits for the meeting: no handover ask and no restart until it ends, unless your context
reaches `refresh.compactCeilingTokens` (185,000 by default), past which it goes on so you never run out of room.

## 2. Bring each decision as a card

Lead with the ship board: each open shippable slice (a goal's fewest tasks that ship something working, proven
live; at most `[focus.slicesPerSession]` open per session) and the slices planned 1 to 2 weeks ahead, one line each:
its goal, what it ships, its owner and ship date, and whether it shipped (its live proof seen), is on date, or is
slipping, with why and its new date. Until the register holds slices, they live in `ship-plan.md` in your notes
folder (`teamrig files --notes --session lead`), one row per slice: goal, slice, tasks, owner, ship date, live
proof, status; bring it up to date before the meeting, and in a tree add each child team lead's slices from its own
file. A slipping slice's decisions come first among the cards.

At the first meeting after the weekly reset, with the budget enabled, the main lead (the lead of the team
`[budget.accountLead]` names, else of the root team) brings the week report before the ship board, for information:
nothing in it asks for an answer.

- the week's split among the teams, and its reasoning (`team-setup` skill, checkpoint step);
- each team's plan: what ships, and when;
- the motivation: what the week achieves for the goals;
- last week in two lines: shipped against the plan, the share of the week used, and the leads' own share of it;
- the appeals that reached the owner, each with its case and the decision that stands.

Then what got done and what is late, in a few lines, and one card per decision, each readable alone:

- what it is and why it matters to the human, in one or two plain lines;
- the owner gate or business reason that makes it theirs;
- the options, with their numbers, each figure explained where it appears;
- your recommendation and why;
- the exact action (a choice, a click path or a command) and what each result leads to.

Ask in plain text: read each card, its options numbered and your recommendation first, and let the human answer in
their own words; never the question picker (AskUserQuestion), which the picker guard refuses in the meeting too.

Never point to a doc instead of a card: `teamrig show <id>` prints a task whole when the facts are thin; a fact the
task does not hold is its owner's to find (step 3). Keep decisions apart from FYIs and from hands-on asks. An owner
gate (destructive data operations, product and design, permissions, budget, resource changes) stays the human's:
a session's recommendation is not their approval. Each decision card names its gate (`gate:`): the owner gate or
business decision that makes it the human's; one with no gate (`UNGATED`) is not the human's: never read it out.
A test, measure or proof of approved work is approved with it: a card asking about one (`OWNER-PROOF`) is not read
out unless it names what it affects (`affects:`).
A hands-on step reaches the human only as the card's audited file (`run:`, its run line and short sha256); one
that prints `do not run` (`RUN-CHANGED`) is not asked until it is audited again, and never type the step yourself.

## 3. Send a follow-up question to the task's owner

When the human asks something about a card that its facts do not answer (a vendor's terms, a figure, how some code
behaves), finding the answer is work of the session that owns the task. Do not look it up yourself, by web or by
its notes, nor through a helper: add the question as that session's task with a deadline, in the same turn.

```sh
teamrig add --session lead --owner <id> --source owner --priority p1 --due <date> --title "Owner asks on T7: <the question>" --description "<what the human needs, and for which decision>"
```

For a task of a team under yours (`web/T2`), add `--team web` and drop `--source`: the task lands in that team, its
lead copied. The `add` tells the owner by inbox line; when the human waits for the answer in this meeting, also send the owner
one message with the deadline. Tell the human when the answer will come and go on to the next card. Relay the
answer as soon as it arrives, or bring it at the next meeting. On your tab, the lead boundary hook flags a web lookup
or a search of another session's notes, naming whom to ask.

## 4. Record each answer in the same turn

```sh
teamrig update T7 --decided --note "owner decided: the middle tier ships first" --session lead
teamrig update T7 --priority p1 --session lead
```

`--decided` takes the card off the agenda and the batches at once and marks the task decided, so its session sees it
READY and sets its next status, even one that closed before the meeting ended; it takes the note alone, so change a
priority, due date or week in a second `update`. The note is what `meeting end` tells the task's owner, with any field
you changed. A task of a team under yours takes its row's name and the note alone: `teamrig update web/T2 --decided
--note "owner decided: ..." --session lead`; its fields stay that team's. A new order
of the human's that creates work is a new task: `teamrig add --session lead --owner <id> --source owner ...`. When a
decision changes what a session works on right now, send it one CRITICAL message; anything else waits for the end.

A card the human wants to decide later, not now, is put off to a date instead of answered:

```sh
teamrig update T7 --later "2026-11-02 09:00" --note "owner put it off: waits for the vendor's quote" --session lead
```

It leaves `DECISIONS` and the decision batches for `LATER` until that time, then is asked again; `--later none`
brings it back at once. A task of a team under yours takes it too: `update web/T2 --later ... --note ...`.

When the human would rather hear a session's cards from the session that holds them, `teamrig meet <id|name>`
wakes that session's tab at once with an inbox line from the human (run again, it says when it asked and posts
nothing more while that ask waits), or opens it fresh in a new tab; it then brings its own
due cards, one at a time, and records each answer itself. It is refused when none of its cards waits on the human
now, naming those put off and until when. Record nothing for those cards here: the session does.

A `DEDICATED` session's decisions are core business: the human decides them in that session's own meeting after the
daily, from a full brief, never from a card. Agree a slot with the human for each session, then run its two lines
once: `brief:` gives the session a p1 task to have its brief ready by the slot, and `book:` books the meeting
(`teamrig meeting schedule`; a team under yours books it from that team's lead), so it notifies at its time and lists
under `MEETINGS`. At the slot the human starts it (`teamrig meeting start M<n>`); the session brings its own cards
with its brief and records each answer: record nothing for them here.

## 5. End

```sh
teamrig meeting end --session lead
```

Each session you recorded a decision for gets one inbox line with the decisions on its tasks; the others get none,
as the hold just ends. It lists what you recorded. `RECORDED nothing` means no task's owner hears of a decision:
record each answer with `update` before you end, and send one you forgot to its task's owner as an inbox line. A
meeting you forget to end stops holding messages 4 hours after it started; end it anyway, so the decisions go out.
With your context past `refresh.contextTokens`, the end of the turn that ends the meeting asks for your handover: the
refresh the meeting held comes at once.
