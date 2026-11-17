---
name: dev-github-intake
description: Take in a teamrig issue or pull request as a maintainer, triaging labels, judging an outside fix first, landing it with credit, and running design issues.
---

# Take in issues and pull requests

For the sessions that maintain teamrig on GitHub. Contributors follow [CONTRIBUTING.md](../../../CONTRIBUTING.md);
this is the other side of it.

## An issue

1. Read it whole, with its comments, and search for one that covers it already (`gh issue list --state all
   --search "<words>"`). A duplicate closes with `teamrig issue close <owner/name#n> --duplicate-of
   <owner/name#m>` and a line saying why.
2. Labels come only from `.github/labels.json`: one type, one priority, an area. A form left half empty gets
   `needs-format` and a comment naming the missing section. Work we take on gets the accept label
   (`github.acceptLabel`, `teamrig` by default), which `teamrig issue sync` imports as a task.
3. Talk about how something should work, with nothing agreed yet, is a design issue: label it `design` (teamrig
   makes the label where it is missing) and run it as below.
4. `good first issue` goes only on a small issue whose body alone lets a newcomer finish it; rewrite the body by
   the write-issue skill first when it does not.

## A pull request from outside

1. Best fix first: judge whether its fix is the best one. If a better one exists, propose it on the pull request
   (what and why) before taking it; else say in one line why theirs is best.
2. A change under a guarded path (CONTRIBUTING.md, Review) gets a security review before it lands.
3. A change to a threshold, limit or trigger: ask "can this still fire?" Its tests must show it firing in the real
   flow, through whatever resets its count (a compaction, a `/clear`, a restart); ask for that spec when they do
   not (CONTRIBUTING.md, Tests).
4. Land it with credit: cherry-pick its source commits (`git cherry-pick -s <sha>` keeps the author), leave out its
   version and dist commits, then raise the version and rebuild the dist ourselves (`dev-ship-change`). Comment on
   the pull request naming the landed commit, and close it.
5. Reply as yourself, in plain words, with the next step and its date, and keep each promise in a task.

## A design issue

- It is never a task to take: no claim, assignee, branch or pull request until it is agreed. Join the talk by
  `dev-design-issue`.
- The decision is the maintainer's. A session sums up the sides and the options in one comment, its own pick with
  reasons, and asks for the decision once.
- Once decided: a comment starting `Agreed:` that sums up the decision, the body rewritten as a spec by the
  write-issue skill, and the label taken off (`teamrig issue label <owner/name#n> --remove design`) with a type
  label given; or the work opened as new issues linked to it.

## Nothing sensitive, anywhere public

Never post a secret, token or key, a private path, host name or e-mail address, a private log, or a security hole,
in an issue, a comment, a pull request or a commit. Read your own text for them before each post: `teamrig issue
comment` refuses a secret it finds, the rest is on you. A security hole someone posted in public is not repeated or
discussed there: tell the maintainer at once, so the comment is hidden and the report moves to a private advisory
([SECURITY.md](../../../SECURITY.md)), and reply only with a pointer to it.

Last verified: 2026-11-15
