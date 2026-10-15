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
no account. To update later, see [Updating the plugin](docs/how-it-works.md#updating-the-plugin).

To keep your tasks in view, add [teamrig-pane](https://github.com/GeneralA6/teamrig-pane) and run `/teamrig-pane`: it
shows your session's tasks beside the conversation, and makes no model calls, so it costs no tokens.

### Requirements

Claude Code 2.1.139 or later and Node.js 22.18 or later. teamrig checks for anything else when you set up a team and
when a session starts, and tells you in plain words what is missing and how to fix it.

## Your day: two hours, not twelve

No more twelve-hour days steering agents by hand. With teamrig, your part takes about two hours:

1. **A morning meeting.** Your lead tells you what got done and what's late, and brings each decision as a short card
   with its recommendation. You answer, and the day is yours.
2. **The team works.** Each member works its own task list in priority order. Whatever is late or stuck goes to the
   lead, not to you.
3. **Drop in when you like.** A few decisions may be waiting. Answer them and go: the team keeps working.

*Coming: the morning meeting, and members that wake on a new note instead of at your next prompt.*

## Why it's different

![A built-in project manager: one task list for the whole team, with owner, priority, due date and proof. Your week, planned: scheduled from your token budget, and it flags what's late, stuck or off-plan. Your day back, coming: one meeting in the morning, each decision with a recommendation. Improves itself: what one session works out becomes a skill, and each lesson a team rule. Survives a crash or reboot, coming: sessions reopen where they left off, and tasks and notes are safe on disk. Just your terminal: Claude Code in the terminal you have, with no IDE, no desktop app and no server.](docs/images/why.svg)

*Coming: scheduling the week from your token budget, the morning meeting, and reopening sessions after a crash or
reboot.*

And the basics, done right: every task has one owner, so nothing is done twice. Work that has shipped but is not
verified yet is marked verifying, with a date to verify it by, so it stays in view until it is, and work built on it waits for the proof. A task that
cannot go on is marked waiting, with what it waits for, and `check` tells you when it can. A push to main asks you first,
and a force-push to it is refused. A message that would wake an idle member at full price is held once, so a
cheap inbox line can take its place. When a member's context runs long, it writes a handover before a fresh start. Big
commits are flagged before they land, and everything runs on your machine, with no account and no cloud bill.

Your GitHub issues can join the task list too, one way only: `teamrig gh sync` adds a task for each open issue of the
repositories you list and keeps its title, priority and open or closed state as on GitHub. It only ever reads GitHub,
so the tasks your team adds stay on your machine.

## Just your terminal

teamrig is Claude Code in the terminal you already have: PowerShell, bash or zsh. Each session is a tab, your lead is
one of them, and teamrig-pane keeps the task list beside the conversation. A tab you open yourself joins a session
when you name it after one (`/rename web`). No IDE, no desktop app, no browser dashboard, no server to run.

![teamrig in your terminal: one window, with a tab for each session: lead, api, web, data, docs and tests. In the lead's tab you ask what needs you, and the lead brings two decisions, each with its pick: keep logs 30 days or 90, and whether to offer Google sign-in on the form. You answer both in one line. Beside the conversation, teamrig-pane lists the team's tasks, each with its id, owner, priority and due date, and marks which are working, which need you, which have not started and which are done.](docs/images/terminal-view.svg)

The window itself stays light: in our test, Windows Terminal with twelve session tabs used about 250 MB of memory.
The rest is Claude Code, which you run anyway.

## Grows with your project

Start small: one lead and a few members. When one team isn't enough, it becomes teams of teams, each with its own
lead. You still talk to just one.

*Coming: hiring and retiring members as the project changes.*

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
helpers can ask you first. A session that makes six single-step calls in a row is asked once to put them in one message, and
`teamrig test -- <command>` sums up a test run in one PASS or FAIL line and its failing tests, keeping the rest in a log. The week's use comes from Claude Code's status line:
`teamrig statusline install` sets it up and keeps one you already have, or have yours write the
[same snapshot](plugins/teamrig/skills/teamrig-guide/commands.md#teamrig-statusline).

*Coming: planning the week to your token limit, and holding deploys before the reset.*

![Your lead plans the week from the tokens you have left. The tasks fill the days, most important first, until the plan reaches 99.5% of your weekly limit. The last 0.5% is kept for incidents, and the task that doesn't fit moves to next week.](docs/images/plan.svg)

[How it works in detail](docs/how-it-works.md) · [Every command](docs/commands.md) · [Contributing](CONTRIBUTING.md)

Using an AI assistant? Point it at [llms.txt](llms.txt): teamrig explained for language models.

## Licence

[Apache License 2.0](LICENSE).
