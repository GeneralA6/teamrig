---
name: write-issue
description: Use before opening or rewriting a GitHub issue that someone else will take, a contributor or their agent, so its body holds the whole spec and they can work alone.
---

# Write an issue someone can take alone

An issue is the whole brief for whoever takes it, often someone outside the team, or their agent, who sees only the
issue and the repository. Each question it leaves open costs a round trip, and each rule it leaves out is broken in
the first draft. Write it so the taker can finish without asking. The steps hold for any repository and any host
with issues; the commands are GitHub's.

## 1. Read what binds the work

Before writing a line, read what the repository already has that the work must follow, and name each in the issue
with its path:

- **Where a change lives.** The repository's own rule on it (`CONTRIBUTING.md`, `CLAUDE.md`, a docs page on its
  layout): which folder or package the change goes in, what counts as one change, what a pull request holds.
- **What it must match.** The modules it extends or reuses, and the style it follows: a palette, a logo or
  wordmark, a naming rule, a docs voice. Name the file that holds each; a taker who does not know the palette picks
  their own.
- **What a pull request is held to.** Tests, sign-off, commit size, the checks CI runs.
- **What is there already.** Search the open and closed issues and pull requests (`gh issue list --state all
  --search "<words>"`, `gh pr list --state all --search "<words>"`), so the issue is no duplicate, and link the
  related ones by `#number`.

A rule the issue does not state is one the taker will not know.

## 2. The whole spec in the body

- The body is the spec. A comment is for talk: a spec in comments is missed, as a taker reads the body first and an
  agent often reads only the body.
- Write the body in a file first, so it is read in full, checked and posted whole.
- A changed spec replaces the body (`teamrig issue edit <owner/name#n> --body-file <file>` on a repository in
  `github.repos`, else `gh issue edit <n> --body-file <file>`), and one short comment says what changed. GitHub keeps
  the old body in the edit history.
- No private data: no home folder paths, e-mail addresses, host names, internal task ids or secrets. An issue may be
  public, and a copy outlives a later edit.

## 3. Its sections

These headings, in this order. Leave one out only when it has nothing to say, never vague:

- **Why**: the problem or goal in two or three sentences, and who it is for.
- **Scope** and **Out of scope**: what is in, and what is not, named, so it is not built.
- **Deliverables**: each file or change with its exact path and format (file type, size, naming, where it is linked
  from).
- **Constraints**: what step 1 found, each with its path.
- **Acceptance checks**: how the taker and the reviewer both know it is done, each a check a reader can run or see:
  a command and its expected output, a page that renders, a test that passes.
- **What the maintainer decides**: the choices left open (an option to pick, a design to approve), and what the
  taker proposes for each.
- **Review and dates**: when a draft or the options are due, how long a review takes, and the date it is wanted by,
  if any.
- **Starting points**: the files, functions and docs to read first, by path and name; line numbers drift.

## 4. A goal is a parent with sub-issues

Work that splits into parts different people can take is a parent issue, the goal (its Why, the parts, their order,
done when every part is), with one sub-issue per part, each a full issue by these steps that names its parent in its
Why. Link them as GitHub sub-issues (the parent's **Create sub-issue**, or `teamrig issue links` from the task tree),
and mark a part that must wait for another as blocked by it.

## 5. Labels and the taker

- Only labels the repository has (`gh label list`): a label added by name that does not exist is made new, typo
  and all.
- One label per meaning: one type, one priority, and one status when the repository uses status labels; never a
  second label that says the same as another (a "help wanted" beside a status that already says the issue is open
  to take).
- Assign the issue to its taker once they say they take it; until then it stays unassigned, open to anyone.

## 6. Read it back

After posting, read the issue on GitHub (`gh issue view <n>`, or its page) and check it against this list: the body
renders (headings, lists, code, links), every path exists, every `#number` is the one meant, the labels and the
parent are set, and nothing private is in it. Fix it by editing the body, then call it done.

## Posting

- A task of a teamrig team going to GitHub: `teamrig issue migrate`, its row's body written by these steps
  ([the command](../teamrig-guide/commands.md#teamrig-issue-migrate)).
- Any other new issue: `gh issue create --title "<title>" --body-file <file> --label "<label>"`, or the web form.
