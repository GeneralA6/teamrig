---
name: hire
description: Use when the lead needs a temporary session for one job (check flags SCALE-OUT), when a hired session's work is done, or to rehire a retired one.
---

# Hire, retire and rehire a session

A hired session is a temporary member for one job. You, the lead, hire it within the team config's `hiring` policy,
give it tasks, and retire it once its job is done. A sub-lead hires the same way (`--session <sub-lead>`):
its hire joins its own group, and it retires only sessions it leads, handing their tasks within its group. Its tasks,
inbox and records stay readable by its id.
`check` says when: `HIRE SCALE-OUT` on an area that cannot finish its dated work in time, `HIRE RETIRE-DUE` on a
hire with no work left.

## 1. Hire

`check` flags `HIRE SCALE-OUT (<detail>) <area>: <action>` when more of an area's dated work is due by a date than
its pace finishes by then. Its pace is the tasks it finished over the last `hiring.scaleOut.windowDays` (7), measured
once it finished `minDone` (3); its dated work is its active tasks of the top `topPriorities` (2) priorities with a
due, their own or that of a task that needs them. The detail names the slice to move (its latest open tasks that no
started work needs), its cost (a new hire's part of the team's daily budget today, a day until the slice's last due
or the week's pace end) and the week's spare; no flag is raised while the spare cannot pay. Do what the action says:
- it names an idle hire: move the slice to it, `teamrig update <task> --owner <hire> --session lead` for each task;
- else hire for the slice (the steps below, `--scope` the slice's task ids, `--reason "SCALE-OUT"`), then move it;
- the host has no room (`hire --yes` refuses): move the slice to another area.

1. Decide its job in one line (`--scope`), why the team needs it now (`--reason`) and a short id
   (lowercase letters, digits and dashes, not on the team yet).
2. Preview it, which writes nothing:
   `teamrig hire <id> --scope "<its job>" --reason "<why>" --session lead`
   It shows its name, model and effort (yours unless `--model` or `--effort`) and its review day. It gets no fixed
   daily budget: its part of the team's follows its share and queued work, like any session's.
3. Under `hiring.policy` `owner`, show the user the preview and ask; on a yes, add `--approved-by "<who>"`. Under
   `lead` or `automatic`, decide yourself: a hire is staffing, your call, never a question for the
   owner.
4. Write it: the same command with `--yes`.
5. Give it its first task before you open it, so its first `list` has work:
   `teamrig add --session lead --owner <id> --priority p2 --title "<task>" --description "<what and why>"`, then
   `teamrig open <id>`.

## 2. Retire

When `check` flags `HIRE RETIRE-DUE` (no open task for `hiring.idleHours`, as when a SCALE-OUT hire's slice is done)
or `HIRE REVIEW-DUE` (its review day passed), give it its next task or retire it. An idle hire a SCALE-OUT names to
take a slice is not flagged RETIRE-DUE meanwhile.

1. Ask it to write its handover (open work, next steps, branches, traps) to `<handover>/<id>.md`.
2. Preview, then write: `teamrig retire <id> --session lead [--to <heir>] --yes`. `--to` takes its open tasks; with
   no handover, `--no-handover "<why>"` records why.
3. Close its tab.

Under `hiring.policy` `automatic`, a hired session whose last open task closes is asked once, at its next turn end,
to write its handover, never to retire itself: you decide which workers the team needs, and the idle pass
deactivates one with no task. It says so and goes on when a new task came in first.

## 3. Rehire

Hire a retired id again with the same `teamrig hire` command. It shows the retire it comes back from and its
handover, and measures its last Claude Code session (the one that last read its inbox):

- It can be resumed when that session's transcript is still in the project folder, its context is at most
  `hiring.resumeMaxTokens` (250k) and it was idle at most `hiring.resumeMaxIdleDays` (7 days).
- Else it opens fresh, and the first prompt sends it to the handover its retire left.

After `--yes`, give it its first task, then open it:

- Fresh: `teamrig open <id>`.
- Resume: `teamrig open <id> --resume`, only when it was in the middle of something its handover does not hold
  and its area barely changed since. A resumed session re-reads its whole old context on every call, so a fresh
  start on the handover is usually cheaper.

`open --resume` measures again and refuses with the reason when the session can no longer be resumed.
