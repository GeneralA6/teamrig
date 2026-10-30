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

Approve only when every line holds:

- Its own, finished change: the requester's task and branch, never another session's work, as only the session
  that made a change merges it.
- Its tests are green, the run named in the note, and new behaviour comes with new tests.
- One logical change per commit, each within the size rule or with a `Large-commit:` reason [commits].
- No unaudited dependency change: a changed manifest or lockfile names the exact versions it resolves and the
  advisories checked.
- The time: before the team's queue cutoff [delivery.schedule.queueCutoffUtc] when the change needs a
  build or a test run, and outside any no-merge window in the team's rules.
- Nothing owner-gated inside [ownerGates]: destructive data operations, permissions, budget, resource changes,
  product or design decisions.

## 3. Answer

- Approve: `teamrig approve T<n> --session <lead> --note "<what you checked>"`. Its owner gets an inbox line to
  push or merge now, then set the task's next status; `check` flags it `READY` until then.
- Decline what fails a line: `teamrig approve T<n> --session <lead> --decline --note "<the line it fails, and the
  fix>"`. Its owner gets an inbox line to fix that and ask again.
- Owner-gated content: decline with a note that says so ("owner-gated: <what>; ask the owner with a card"), so its
  owner sets it waiting on the owner's approval with a decision card. Your approval never stands in for the owner's.
- Anything else, a route, a merge or who reviews, is yours however many good answers it has: answer it yourself and
  never send it on to the owner.

## 4. After

An approval stands until the task's next status, and the push guard reads it until then. When `check` still flags
an approved task `READY` after its owner pushed or merged, send one inbox line to set its next status.
