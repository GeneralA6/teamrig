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
no account.

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

*Coming: planning the week to your token limit, and holding deploys before the reset.*

![Your lead plans the week from the tokens you have left. The tasks fill the days, most important first, until the plan reaches 99.5% of your weekly limit. The last 0.5% is kept for incidents, and the task that doesn't fit moves to next week.](docs/images/plan.svg)

## Why it's different

![A built-in project manager: plans your week and flags what's late, stuck or forgotten. Thrifty with your tokens: lean, capped rules, and notes that wait instead of waking anyone. Smarter every day: what one member works out becomes a skill the whole team reuses. Never loses the thread: when its memory runs high, a member leaves a handover for a fresh start. Done means proven: a task closes only with evidence and a lesson the team keeps. Safe by default: asks before a push to main, refuses blind force-pushes and keys in notes.](docs/images/why.svg)

And the basics, done right: every task has one owner, so nothing is done twice, and big commits get flagged before
they land. Everything runs on your machine, with no account and no cloud bill.

[How it works in detail](docs/how-it-works.md) · [Every command](docs/commands.md) · [Contributing](CONTRIBUTING.md)

## Licence

[Apache License 2.0](LICENSE).
