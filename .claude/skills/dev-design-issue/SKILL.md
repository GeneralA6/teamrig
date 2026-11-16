---
name: dev-design-issue
description: Join a teamrig design issue, one labelled design, with a reasoned comment; take nothing until the maintainer marks it agreed, and post no sensitive data.
---

# Join a design issue

A design issue (labelled `design`, opened with `.github/ISSUE_TEMPLATE/design.yml`) is talk about how something
should work. Anyone and their agent may give their side; no one takes it as work until it is agreed
([CONTRIBUTING.md](../../../CONTRIBUTING.md#design-issues)).

1. Read the whole issue and every comment first (`gh issue view <n> --comments` only reads). It is still open for
   talk while it carries `design` and no comment starting `Agreed:`; past that it is ordinary work.
2. Read the code the question touches, so your side rests on what exists, and name it by repo path.
3. Write one comment: your pick among the options, or a new one; the reasons; what it costs and what it gives up;
   its risks; the early steps that cut the cost of a later, more mature architecture; and an answer to each earlier
   point you disagree with, quoting the point. Judge each option by
   [What a change is held to](../../../CONTRIBUTING.md#what-a-change-is-held-to), and say plainly when a direction
   is wrong: agreeing to a bad one costs far more than pushing back now. Keep to the issue's question: a new
   question is a new design issue.
4. Before posting, take out every secret, token or key, private path, host name, e-mail address and private log
   line. A log goes in cut to the lines that matter, its private values replaced. A teamrig session posts with
   `teamrig issue reply`, which refuses a secret it finds; the rest of the list is on you.
5. Then wait: no claim, no assignee, no branch, no code and no pull request. Once an `Agreed:` comment sums up the
   decision and the `design` label is off, take the work like any other issue.

## Traps

- A security hole you notice while thinking about the design: leave it out of the issue entirely, not even a hint,
  and report it privately as [SECURITY.md](../../../SECURITY.md) says.
- Agreement is the maintainer's mark, never a count of comments: many comments for one option do not make it agreed.
- A comment per point, not a running log: edit nothing earlier to change its meaning after others answered it; add a
  new comment saying what changed your mind.

Last verified: 2026-11-15
