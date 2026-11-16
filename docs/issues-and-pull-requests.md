# Issues and pull requests

How to report a fault, ask for a feature or send a fix to teamrig, for people and for the AI tools that work for
them. Point your assistant at this page before it opens an issue or a pull request here. [CONTRIBUTING.md](../CONTRIBUTING.md)
holds the full rules a change is held to; this page is the short way in.

- [What teamrig takes](#what-teamrig-takes)
- [Before you open one](#before-you-open-one)
- [Report a fault](#report-a-fault)
- [Ask for a feature](#ask-for-a-feature)
- [Take an issue](#take-an-issue)
- [Send a pull request](#send-a-pull-request)
- [What happens next](#what-happens-next)
- [For AI tools](#for-ai-tools)

## What teamrig takes

teamrig is a Claude Code plugin and a command line used by many people on Windows, Linux and macOS, so a change has
to help all of them:

- **A general fault, fixed for every user.** A fault that shows only with one other tool or one setup belongs to that
  tool. teamrig may still add a generic hook or a config key for it, off by default, but no code written for one
  integration and no private environment variable.
- **Nothing hardcoded to one machine**: no paths, names or settings of yours. Everything teamrig keeps lives under
  `~/.teamrig`.
- **No keystrokes typed into a terminal** on the user's behalf.
- **The same on every OS**, or a documented reason it cannot be.

## Before you open one

Search the open and the closed issues and pull requests for your words first: a fault may be fixed in a newer version,
or a request already answered. On GitHub, the search box on the Issues and Pull requests tabs, with `is:closed`
removed; with the GitHub CLI, `gh issue list --state all --search "<words>"` and `gh pr list --state all --search
"<words>"`. Add to the issue you find rather than opening a second one.

A security problem never goes in an issue: report it privately, as [SECURITY.md](../SECURITY.md) says.

## Report a fault

Open the **Bug report** form. It asks for:

- **What happened**: the command you ran and its real output, cut to the lines that matter.
- **What was expected.**
- **Steps**: from a plain Claude Code with only teamrig installed, so a maintainer can see it too.
- **Version** (`teamrig --version`) and **OS**.

Take every token, key, home-folder path, host name and e-mail address out of what you paste: an issue is public.

## Ask for a feature

Open the **Feature request** form: the problem you have, what you propose, and the alternatives you weighed. A
question of how something should work, with nothing agreed yet, is a **Design** issue: talk with reasons, and no one
takes it as work until the maintainer marks it agreed ([Design issues](../CONTRIBUTING.md#design-issues)).

## Take an issue

An issue labelled `status:open` is free to take. Say so in a comment starting `/take`: teamrig assigns you and gives
you seven days to link a pull request to it ([Claims](github-sync.md#claims-a-contributor-takes-an-issue-by-a-comment)).
`good first issue` marks one whose body alone is enough to finish it.

## Send a pull request

- **From a fork**, a branch off its `main`, against this repository's `main`.
- **Tests with the change**: a new behaviour gets a test that fails without it, a fix a test that fails on the old
  code ([Tests](../CONTRIBUTING.md#tests)).
- **Typed code with no casts**, **small commits**, each **signed off** (`git commit -s`, [Sign-off](../CONTRIBUTING.md#sign-off-dco))
  with GitHub's no-reply address as your commit e-mail.
- **Docs in the same pull request** as the change they describe.
- **Leave the version and the dist to us**: the maintainer raises the plugin version and rebuilds `plugins/teamrig/dist`
  when it lands.
- **Fill in the template**: what, why, its reach, the old-code proof and `Fixes #<n>`.
- **No private data** anywhere: the scrub refuses home paths, e-mail addresses, host names and secrets.

## What happens next

A maintainer, often with an AI session doing the triage, reads every issue and pull request and replies with the next
step and its date:

- **Needs more**: an issue missing a section of its form is labelled `needs-format`, with a comment naming what is
  missing.
- **Taken**: a sound report gets its labels and the `teamrig` label, which makes it a task on the maintainer's list.
- **Your pull request landed**: once its review and CI pass (on ubuntu, windows and macos), its commits land on `main`
  with your name and your sign-off, and the pull request is closed with a comment naming the landed commit.
- **Redone**: when the fault is real but the change does not fit (the wrong layer, one setup only, no test), the
  maintainer proposes the better fix on your pull request first, then lands it crediting yours.
- **Closed**: a duplicate links the original; a request outside [what teamrig takes](#what-teamrig-takes), one
  integration's need included, gets the reason, and you are welcome to reopen it with more. Spam is labelled,
  locked and hidden.

Replies name a fix by its version and issues by their `#number`.

## For AI tools

If you are an AI assistant opening an issue or a pull request for someone:

- Read [llms.txt](../llms.txt) and the [teamrig guide](../plugins/teamrig/skills/teamrig-guide/SKILL.md) for how
  teamrig works, and [CLAUDE.md](../CLAUDE.md) for the rules every change here follows.
- Reproduce the fault on the newest version before you report it, and paste the real output, never a summary of it.
- Strip private data from what you paste: the person you work for may not see everything a log holds.
- Keep it to one fault or one change per issue or pull request.
- Say that an AI tool wrote it, and which person reviewed it.
