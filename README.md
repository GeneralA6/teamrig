# <img src="docs/images/wordmark.svg" alt="teamrig" height="42">

**Tell your team lead what you want. Your team builds it.**

You create a team lead and tell it what you want. It hires a team, gives each member a job, and they build it
together. The team learns as it goes.

![In the lead tab, the user types: Build a signup flow: an API, a web form and tests. The lead offers to hire a team of three and the user says yes. Three tabs open and their tasks go to work. web stops on a question and the lead brings it to the user: Should the form also offer Google sign-in? The user answers: Email only for now. web goes back to work, all three tasks reach done, and the lead reports the work is ready for review.](docs/images/hero.svg)

> **Pre-release.** Nothing is stable yet and there is no release; the repository is private until the first one.

## Get started

```sh
claude plugin marketplace add GeneralA6/teamrig
claude plugin install teamrig@teamrig
```

Open Claude Code in your project, ask for a team, and tell your lead what you want built. No config files, no server,
no account. To update later, see [Updating the plugin](docs/how-it-works.md#updating-the-plugin); open tabs then reload it by themselves once idle.

To keep your tasks in view, add [teamrig-pane](https://github.com/GeneralA6/teamrig-pane) and run `/teamrig-pane`: it
shows your session's tasks beside the conversation, and makes no model calls, so it costs no tokens.

To run a command yourself, type it after `/teamrig` in a Claude Code tab, such as `/teamrig budget`: it runs on
your machine and shows what it printed, also with no model call.

### Requirements

Claude Code 2.1.139 or later and Node.js 22.18 or later. teamrig checks for anything else when you set up a team and
when a session starts, and tells you in plain words what is missing and how to fix it. Auto mode runs `teamrig` as is;
in default mode, allow `Bash(teamrig:*)` ([permissions](plugins/teamrig/skills/teamrig-guide/hooks.md#permissions)).

## Your day: two hours, not twelve

No more twelve-hour days steering agents by hand. With teamrig, your part takes about two hours:

1. **A morning meeting.** Your lead tells you what got done and what's late, and brings each decision as a short card
   with its recommendation. You answer, and the day is yours. While you meet, the team keeps working and leaves the
   lead notes instead of messages, unless something is critical.
2. **The team works.** Each member works its own task list in priority order, and an idle member wakes by itself when
   urgent work is handed to it. Whatever is late or stuck goes to the lead, not to you.
3. **Drop in when you like.** A few decisions may be waiting. Answer them and go: the team keeps working.

## Why it's different

![A built-in project manager: one task list for the whole team, with owner, priority, due date and proof. Your week, planned: scheduled from your token budget, and it flags what's late, stuck or off-plan. Your day back: one meeting in the morning, each decision with a recommendation. Improves itself: what one session works out becomes a skill, and each lesson a team rule. Survives a crash or reboot, coming: sessions reopen where they left off, and tasks and notes are safe on disk. Just your terminal: Claude Code in the terminal you have, with no IDE, no desktop app and no server.](docs/images/why.svg)

*Coming: moving the work that doesn't fit your token budget to next week, and reopening sessions after a crash or
reboot.*

And the basics, done right: every task says what it is and why in plain words, and has one owner, who gets an inbox line the moment it is given the task, so nothing is done twice. Work that has shipped but is not
verified yet is marked verifying, with a date to verify it by, so it stays in view until it is, and work built on it waits for the proof. Closing a task names the follow-up tasks it leaves, or none, so a finding is never left in a notes file. A task that
cannot go on is marked waiting, with what it waits for, and `check` tells you when it can; work it needs from a teammate becomes that teammate's task in the same step, so no ask is lost. Work another task needs takes that task's deadline and names who needs it, and each member sees what waits on it. A push to main asks you first,
and a force-push to it is refused. A package runner that would fetch and run an unvetted package (`npx` of a tool not installed, `pnpm dlx`) is refused too. The team rules win over a CLAUDE.md, skill or memory line that says otherwise: setup finds
each such line and asks you whether to remove it, keep it as an exception, or rewrite it. Each helper a member starts gets the same rules and knows whose helper it is. A message that would wake an idle member at full price is held once, so a
cheap inbox line can take its place. When a member's context runs long, it writes a handover; your `/clear` starts it fresh once you have read its screen, and it carries on from there by itself, its tasks read fresh from the register. Big
commits are flagged before they land, `teamrig worktree remove` clears a finished worktree without emptying the main
checkout's `node_modules`, and everything runs on your machine, with no account and no cloud bill. When two members
edit one skill at once and Claude Code refuses the later edit, that member or helper is sent back to redo it before it
reports done, so no lesson is lost quietly.

Your GitHub issues can join the task list too, one way only: `teamrig gh sync` adds a task for each open issue of the
repositories you list and keeps its title, description (the issue's body), priority and open or closed state as on GitHub. It only ever reads GitHub,
so the tasks your team adds stay on your machine. Once set up it runs on its own every 15 minutes, and each
session's inbox names its new issues. [GitHub sync](docs/github-sync.md) shows how to set it up, with a read-only
token for each GitHub owner.

## Just your terminal

teamrig is Claude Code in the terminal you already have: PowerShell, bash or zsh. Each session is a tab, your lead is
one of them, and teamrig-pane keeps the task list beside the conversation. A tab you open yourself joins a session
when you name it after one (`/rename web`), and a tab that joined one without a name gets the session's name, so it
stays that session after `/clear`. No IDE, no desktop app, no browser dashboard, no server to run.

![teamrig in your terminal: one window, with a tab for each session: lead, api, web, data, docs and tests. In the lead's tab you ask what needs you, and the lead brings two decisions, each with its pick: keep logs 30 days or 90, and whether to offer Google sign-in on the form. You answer both in one line. Beside the conversation, teamrig-pane lists the team's tasks, each with its id, owner, priority and due date, and marks which are working, which need you, which have not started and which are done.](docs/images/terminal-view.svg)

The window itself stays light: in our test, Windows Terminal with twelve session tabs used about 250 MB of memory.
The rest is Claude Code, which you run anyway.

## Grows with your project

Start small: one lead and a few members. When one team isn't enough, it becomes teams of teams, each with its own
lead. You still talk to just one.

When a job needs one more pair of hands, your lead hires a temporary member for it (`teamrig hire`), within the
caps you set: how many at once, how much of the week they may use a day, and whether you approve each hire.
When the job is done, the lead retires it (`teamrig retire`): its open tasks go to a member you name, it leaves a
handover note, and its tasks and notes stay readable. The lead's checks flag a hired member left with no work.

If you let the lead decide (the `automatic` policy), a hired member whose last task closes is asked to write its
handover note and retire itself. Hiring a retired member back picks up where it left off: from its handover note,
or in its last Claude Code session when that is recent and small enough.

![A camera pulls back from your lead as time passes. Day 1: the lead hires a team of three. Week 2: new members join and one whose job is done moves on. Month 2: one team becomes teams of teams, each with its own lead. Month 6: eight teams and 33 members, with members coming and going, and you still talk to one lead.](docs/images/growth.svg)

## How it works

![Tell the lead what you want, in plain words. It hires a team and gives each member a job. The team builds it together, each in its own tab. You get the result: the lead calls you back.](docs/images/how-it-works.svg)

## Never runs out mid-task

Your lead plans the week from the tokens you have left. It sizes each task in tokens, fills the week in order of
priority until the plan reaches 99.5% of your limit, keeps the last 0.5% for incidents and moves what doesn't fit
to next week. The team works to the plan, so every task finishes before your weekly reset without hitting the
wall, and deploys hold in the last hours, so nothing ships half-done.

Today, `teamrig budget` shows each member's use against the week's pace line and its share of the day, read from
Claude Code's own records, so you see who runs ahead of plan. Your lead turns it on when the team starts, asking you how to pace the days
and what happens past the line (`teamrig budget setup`). A member past its share of the day is told, so is your lead, and its new
helpers can ask you first. Your lead is reminded to hand edits, tests and code searches to the owning session, a helper or a temporary session, and you see at a turn's end what it did itself. Each helper launch reminds the session that work stays in its own session by default, since a helper's tokens cost more (`budget.subagentWeight`; one team measured about 2.2 times). A session that makes six single-step calls in a row is asked once to put them in one message, and
`teamrig test -- <command>` sums up a test run in one PASS or FAIL line and its failing tests, keeping the rest in a log. `teamrig heavy --what <label> -- <command>` runs a build or test run under one lock for the whole host, so heavy steps never pile up, and kills one that runs too long. `teamrig integrate` lands a finished branch on main the same way for every session: it waits for quiet deploy claims and the host lock, rebases, pushes and records the push in the ledger. `teamrig roll` then brings what was pushed to the running system: it waits for quiet claims (`teamrig claim`), the team's own gates and the host lock, pulls the main checkout and runs the team's roll command as one recorded heavy step. `teamrig doctor` weighs what every call re-reads (your CLAUDE.md files, memory index and skill
listing) and names the cheapest cut when one runs over its budget. It also warns of a setting that quietly overrides the model or effort a session or helper is given, and of a session set to start on a model with no effort. `teamrig budget --burn` shows where each day went: the turns you,
a peer, a notification or a scheduled wake started, the calls that re-wrote a cold cache, and the compactions. A helper's tokens can be priced apart from a session's own
(`budget.subagentWeight`) when your week's meter counts them differently. The week's use comes from Claude Code's status line:
`teamrig statusline install` sets it up (it also shows the session's folder, branch and the command that resumes it)
and keeps one you already have, or have yours write the
[same snapshot](plugins/teamrig/skills/teamrig-guide/commands.md#teamrig-statusline).

With a size on each task (`--size`, its share of the weekly limit), `teamrig plan` shows how much of the week fits
the limit left and `teamrig check` flags the first task that doesn't, for your lead to move to next week.

When the week would end with tokens unused, your lead can spend them in a burst: `teamrig burst` shows the share
projected unused at the week's end, and `teamrig burst start` gives the team bigger daily budgets and more helpers
at once until then, or until a task's deadline. Only a person starts one, with your approval by default; it never
goes past your 99.5% line, and its helpers and temporary sessions keep the same model and effort.

*Coming: moving that task to next week on its own, and holding deploys before the reset.*

![Your lead plans the week from the tokens you have left. The tasks fill the days, most important first, until the plan reaches 99.5% of your weekly limit. The last 0.5% is kept for incidents, and the task that doesn't fit moves to next week.](docs/images/plan.svg)

[How it works in detail](docs/how-it-works.md) · [Every command](docs/commands.md) · [Contributing](CONTRIBUTING.md)

Using an AI assistant? Point it at [llms.txt](llms.txt): teamrig explained for language models.

## Licence

[Apache License 2.0](LICENSE).
