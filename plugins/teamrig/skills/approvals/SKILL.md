---
name: approvals
description: Use when a session's task waits on the lead's approval (approval:<lead>), say before a push or merge to main, to review the request and answer it with teamrig approve.
---

# Answer a session's approval request

A session that wants your go, you being the lead, say to push or merge its change to main, sets its task waiting on
you: `teamrig set T<n> --status waiting --waits approval:<lead> --note "<branch, what it lands, its tests>"`. You
get one inbox line naming the task and its note. Answer it from the register the same day; it goes to the human
only when it holds owner-gated content (step 3). Under `pushGuard.pushToProtected: lead` your approval is what
lets the session's push to a protected branch through, and your own pushes go through unasked: hold them to the
same checklist. Under `gated`, a change that misses a self-merge gate waits on you with a gate hold: its note names
the hold, and the hold's refusal names the gates it missed. Check those gates against the checklist; your approval
lets `teamrig merge` take that base, head and tree only.

## 1. Read the request

- `teamrig show T<n>`: its note names the branch, what it lands and the test run. A note that does not: decline,
  asking for them.
- The commits, in the repo: `git log --stat <main>..<branch>`, and `teamrig commits check --base <main> --tip
  <branch>` for the size rule.

## 2. Check

Read it to find what is wrong, not to agree, and hold it to every line whoever asks. A wrong direction is declined,
with the reason and the better way: a bad direction accepted costs far more than one more round trip. Approve only
when every line holds:

- Its own, finished change: the requester's task and branch, never another session's work, as only the session
  that made a change merges it.
- It fits the design: the repository's principles and architecture, the decisions already taken, or it names the
  one it changes and why. It reuses the module or helper that already does the job in place of a second copy, and
  keeps each part to one reason to change (SOLID).
- Extensibility weighed: what is cheap now and costly later (a port, a config key in place of a constant) is done
  now; a hook for a need no one has named is not built.
- Its risks are named, each with how it is softened (a break for a caller, a security or data risk, a cost, a
  migration), or `none foreseen` with why.
- Its tests are green, the run named in the note, and new behaviour comes with new tests.
- A changed threshold, limit or trigger can still fire: ask "can this still fire?" and want a test of it firing in
  the real flow, through whatever resets its count (a compaction, a context refresh, a restart), not only the comparison.
- One logical change per commit, each within the size rule or with a `Large-commit:` reason [commits].
- No unaudited dependency change: a changed manifest or lockfile names the exact versions it resolves and the
  advisories checked.
- The time: before the team's queue cutoff [delivery.schedule.queueCutoffUtc] when the change needs a
  build or a test run, and outside any no-merge window in the team's rules.
- Its reach is stated and fits where it lives: work any team using the tool would need goes into the shared tool,
  with what differs per team in a config key, not into one team's rules or a session's skill. The note or change request
  says the reach; a narrow reach on generic work, decline asking to move it.
- Nothing owner-gated inside [ownerGates]: destructive data operations, permissions, budget, resource changes,
  product or design decisions.

## 3. Answer

- Approve: `teamrig approve T<n> --session <lead> --note "<what you checked>"`. Its owner gets an inbox line, which
  wakes it, to push or merge now, then set the task's next status; `check` flags it `READY` until then. Name the head
  you checked by its full sha in the note: a merge tool that reads approvals clears only a head the note names, so a
  later push needs a new approval, unless the tool checks the later head is a rebase of the named one that keeps
  every commit's patch (`git range-diff` all `=`), its rebuilt dist and version numbers aside: any other edit to a
  version file counts.
- Decline what fails a line: `teamrig approve T<n> --session <lead> --decline --note "<the line it fails, and the
  fix>"`. Its owner gets an inbox line to fix that and ask again.
- Owner-gated content: decline with a note that says so ("owner-gated: <what>; ask the owner with a card"), so its
  owner sets it waiting on the owner's approval with a decision card. Your approval never stands in for the owner's.
- Anything else, a route, a merge or who reviews, is yours however many good answers it has: answer it yourself and
  never send it on to the owner.

## 4. After

An approval stands until the task's next status, and the push guard reads it until then. A status that keeps the
task waiting on you behind another task or a time keeps it while its note names no other commit; the same approval
set again keeps it only when its note names the approved head, so a note with no head or a new one asks anew. Its
owner's `set` refuses any other status that would drop it before the step ends, that restated wait with no head or a
new one too;
`--drop-approval` gives it up for a new ask. When `check` still flags
an approved task `READY` after its owner pushed or merged, send one inbox line to set its next status.
