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

It tells every other session by inbox line, which wakes no one: keep working, and send the lead no message until
the meeting ends, but one starting `CRITICAL`. The `cold-send` hook holds any other message to you, so a session
that has not read the line yet is held too. Then it prints the agenda:

- `DECISIONS`: each task waiting on the human's decision or approval, with its card facts;
- `LATE`: the active tasks past their due date, their own or the earlier one of a task that needs them
  (`due 10-14 (from T9)`);
- `DONE`: what finished since the last meeting;
- your unread inbox lines, marked read;
- the week's use, and under it what of the planned week fits the weekly limit.

Tell the human the meeting started in one line. `teamrig meeting agenda --session lead` prints the agenda again,
during the meeting or to prepare the next one.

Your context refresh waits for the meeting: no handover ask and no restart until it ends, unless your context
reaches `refresh.compactCeilingTokens` (185,000 by default), past which it goes on so you never run out of room.

## 2. Bring each decision as a card

Lead with what got done and what is late, in a few lines. Then one card per decision, each readable alone:

- what it is and why it matters to the human, in one or two plain lines;
- the options, with their numbers, each figure explained where it appears;
- your recommendation and why;
- the exact action (a choice, a click path or a command) and what each result leads to.

Ask for the choices with Claude Code's question picker (AskUserQuestion), at most 4 questions a call: each card's
options as its choices, your recommendation first, the card text above it.

Never point to a doc instead of a card: `teamrig show <id>` prints a task whole when the facts are thin, and a
helper on your own model can gather more. Keep decisions apart from FYIs and from hands-on asks. An owner gate
(destructive data operations, product and design, permissions, budget, resource changes) stays the human's:
a session's recommendation is not their approval.

## 3. Record each answer in the same turn

```sh
teamrig update T7 --note "owner decided: the middle tier ships first" --priority p1 --session lead
```

The note is what `meeting end` tells the task's owner, with any priority, due date or week you changed. A new order
of the human's that creates work is a new task: `teamrig add --session lead --owner <id> --source owner ...`. When a
decision changes what a session works on right now, send it one CRITICAL message; anything else waits for the end.

## 4. End

```sh
teamrig meeting end --session lead
```

Every other session gets one inbox line: the meeting ended, messages to you may go again, and the decisions on its
tasks. It lists what you recorded. `RECORDED nothing` means no task's owner hears of a decision: record each answer
with `update` before you end, and send one you forgot to its task's owner as an inbox line. A meeting you forget to
end stops holding messages 4 hours after it started; end it anyway, so the sessions are told. With your context
past `refresh.contextTokens`, the end of the turn that ends the meeting asks for your handover: the refresh the
meeting held comes at once.
