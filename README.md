<h1 align="center"><img src="docs/images/wordmark.svg" alt="teamrig" height="48"></h1>

<p align="center"><b>Tell your team lead what you want. Your team builds it.</b></p>

<p align="center">teamrig turns the Claude Code sessions in your terminal into a team: a lead, its members and one task
list, planned to your token budget, safe while you're away, and better each week.</p>

<p align="center">
  <a href="#get-started">Get started</a> ·
  <a href="#how-it-works">How it works</a> ·
  <a href="#why-its-different">Why it's different</a> ·
  <a href="docs/features.md">Everything it does</a> ·
  <a href="docs/commands.md">Commands</a>
</p>

![In the lead tab, the user types: Build a signup flow: an API, a web form and tests. The lead offers to hire a team of three and the user says yes. Three tabs open and their tasks go to work. web stops on a question and the lead brings it to the user: Should the form also offer Google sign-in? The user answers: Email only for now. web goes back to work, all three tasks reach done, and the lead reports the work is ready for review.](docs/images/hero.svg)

Each session is a tab in the terminal you already have (PowerShell, bash or zsh), and your lead is one of them. No
IDE, no desktop app, no server and no account: in our test, Windows Terminal with twelve session tabs used about
250 MB of memory.

> **Pre-release.** Nothing is stable yet and there is no release; the repository is private until the first one.

## Get started

Install teamrig, and teamrig-pane to keep your tasks beside the conversation:

```sh
claude plugin marketplace add GeneralA6/teamrig
claude plugin install teamrig@teamrig

claude plugin marketplace add GeneralA6/teamrig-pane
claude plugin install teamrig-pane@teamrig-pane
```

While the repositories are private, accept the invites to both first: Claude Code clones a marketplace with your own
git login, so `git clone https://github.com/GeneralA6/teamrig` must work in your terminal.

Open Claude Code in your project (in a tab already open, type `/reload-plugins` first), ask for a team, and tell your
lead what you want done. No config files to write.

- **Your tasks in view:** install [teamrig-pane](https://github.com/GeneralA6/teamrig-pane) and run `/teamrig-pane`
  in a tab. It shows the session's tasks beside the conversation and makes no model calls, so it costs no tokens.
- **A command by hand:** type it after `/teamrig`, such as `/teamrig budget`. It runs on your machine and shows what
  it printed, also with no model call.
- **Updates:** see [Updating the plugin](docs/how-it-works.md#updating-the-plugin). Open tabs reload it by themselves
  once idle.

### Requirements

Claude Code 2.1.139 or later and Node.js 22.18 or later. teamrig checks for anything else when you set up a team and
when a session starts, and tells you in plain words what is missing and how to fix it. Auto mode runs `teamrig` as is;
in default mode, allow `Bash(teamrig:*)` ([permissions](plugins/teamrig/skills/teamrig-guide/hooks.md#permissions)).
Windows and Linux: on Linux the tests and a smoke run pass; the tab circles and teamrig-pane are proven on Windows only.

## How it works

1. **Tell the lead what you want**, in plain words.
2. **It hires a team** and gives each member a job: tasks on one list, one owner each.
3. **The team builds it together**, each member in its own tab, working its tasks in priority order. Whatever is late
   or stuck goes to the lead, not to you.
4. **You get the result.** The lead calls you back, and brings any decision in a batch.

![Tell the lead what you want, in plain words. It hires a team and gives each member a job. The team builds it together, each in its own tab. You get the result: the lead calls you back.](docs/images/how-it-works.svg)

One task's trip, as you see it in your terminal:

![In the lead's tab you type: Users need a password reset. The lead adds T17 Password reset for api, p1, due today, and it appears in teamrig-pane's list. In api's tab, api starts it, edits and tests, then merges it with teamrig merge: it waits in line while web holds the lock, then rebases on main and pushes. web's task and then T17 turn done in the pane.](docs/images/task-flow.svg)

## Your day: two hours, not twelve

No more twelve-hour days steering agents by hand. With teamrig, your part takes about two hours:

1. **A morning meeting.** Your lead tells you what got done and what's late, and brings each decision as a short card
   with its recommendation. You answer, and the day is yours. While you meet, the team keeps working and leaves the
   lead notes instead of messages, unless something is critical.
2. **The team works.** Each member works its own task list in priority order, and an idle member wakes by itself when
   urgent work is handed to it, and once each morning at the day start you set. Whatever is late or stuck goes to the
   lead, not to you.
3. **Drop in when you like.** A few decisions may be waiting: the lead brings them in batches, not one interruption
   each, and one that cannot wait at once. Answer them and go: the team keeps working.

![A lead's morning in its own tab, one plain sentence a step, each tool run folded into one line. data asks whether to rerun last night's failed import now; that is operational, so the lead decides it, sends data the answer, and data goes back to work. The week's plan holds only 7 tasks; the lead fills it to 48, fitted to the week's tokens, and the flags fall from 63 to 12. Host memory is low, 1.8 GB free, so it closes docs and tests, idle with nothing to start: 3.9 GB free, and teamrig open resumes either one. web's question is a product call, so it waits for your morning meeting.](docs/images/lead-morning.svg)

*The lead's morning: it settles the operational calls itself and keeps the product calls for your meeting.*

## Why it's different

Each of these is something a single Claude Code tab can't do on its own.

![A built-in project manager: one task list for the whole team, with owner, priority, due date and proof. Your week, planned: scheduled from your token budget, and it flags what's late, stuck or off-plan. Your day back: one meeting in the morning, each decision with a recommendation. Improves itself: what one session works out becomes a skill, and each lesson a team rule. Survives a crash or reboot: sessions reopen where they left off, and tasks and notes are safe on disk. Just your terminal: Claude Code in the terminal you have, with no IDE, no desktop app and no server.](docs/images/why.svg)

### A project manager built in

One task list for the whole team. Every task says what it is and why in plain words, and has one owner, a priority
and a due date; the owner gets an inbox line the moment it is given the task, so nothing is done twice. Work that has
shipped stays *verifying* until its proof exists, and work that can't go on is *waiting*, naming what it waits for, so
nothing closes unproven and no ask is lost. The lead's checks flag what's late, stuck, piling up or off the week's
goals.

![teamrig in your terminal: one window, with a tab for each session: lead, api, web, data, docs and tests. In the lead's tab you ask what needs you, and the lead brings two decisions, each with its pick: keep logs 30 days or 90, and whether to offer Google sign-in on the form. You answer both in one line. Beside the conversation, teamrig-pane lists the team's tasks, each with its id, owner, priority and due date, and marks which are working, which need you, which have not started and which are done.](docs/images/terminal-view.svg)

### Your day back

Decisions come to you as short cards with the options, the numbers and the lead's pick, batched into your morning
meeting instead of one interruption each. With `pickerGuard`, a member that needs a decision makes it when it is its
own, else records it on its task and goes on with its next one, so no tab sits at a question while you're away. An
idle member wakes by itself when urgent work is handed to it.

![Your morning meeting in the lead's tab. You say Morning; the lead opens the meeting, and the sessions hold the messages that aren't critical until it ends. It says what got done since yesterday, what is late and what your OK last night already started, then brings three decisions as numbered cards, each with the facts in numbers, the options with their cost, its pick with a reason and what happens with no answer: guest checkout, a second test database, and retiring an old API. You answer all three in one line, 1 A, 2 B, 3 as recommended. The lead records them on their tasks, web goes back to work on guest checkout, and the meeting closes: the held messages go out.](docs/images/lead-meeting.svg)

*Your morning meeting: three decisions as numbered cards, answered in one line.*

### Never runs out mid-task

Your lead plans the week from the tokens you have left: it sizes each task, fills the week by priority until the plan
reaches 99.5% of your weekly limit, keeps the last 0.5% for incidents and moves what doesn't fit to next week.
`teamrig budget` shows each member's use against the week's pace line, and deploys hold in the last hours before the
reset, so nothing ships half-done. When the week would end with tokens unused, a burst spends them, with your
approval. Past your weekly limit, the extra usage you put in (`teamrig budget extra`) is spread over the days left
the same way.

*Coming: moving the task that doesn't fit to next week on its own.*

![Your lead plans the week from the tokens you have left. The tasks fill the days, most important first, until the plan reaches 99.5% of your weekly limit. The last 0.5% is kept for incidents, and the task that doesn't fit moves to next week.](docs/images/plan.svg)

### Improves itself

A procedure a member works out and will run again becomes a skill in the same turn, and a lesson becomes a team rule.
Setup first backs up your Claude setup and shows what each turn costs; it shortens, dedupes and parks what you say
yes to, one group at a time, and shows the cost before and after (`teamrig setup restore` puts it all back).
The team rules win over a CLAUDE.md, skill or memory line that says otherwise: setup finds each such line
(`teamrig rules scan`) and asks you whether to remove it, keep it as an exception or rewrite it.
`teamrig skills scorecard` shows whether each skill earns its place: its loads, the times its procedure was run by
hand instead, and the calls each run takes. Each member lists another member's skills by name only, unless the
skill names it as a user, so a growing skills folder does not fill every call. When two members edit one skill at
once and Claude Code refuses the later edit, that member is sent back to redo it, so no lesson is lost quietly.

### Survives a crash, a reboot and a full context

Tasks, notes and inboxes live on disk, so nothing is lost with a tab. After a reboot, `teamrig restore run` reopens
each session the shutdown killed, in its folder and at its last effort, never one you or teamrig closed on purpose,
and prompts the ones that were mid-turn to carry on; `teamrig restore install` runs it at each logon on Windows. When
a member's context runs long, it writes a handover; once it is idle and you're away, teamrig restarts it after a
20-second countdown you can hold, and it carries on from the handover by itself.

*Coming: reopening sessions at logon on macOS and Linux.*

### Grows with your project

Start with one lead and a few members. When a job needs one more pair of hands, the lead hires a temporary member
(`teamrig hire`) when the host has room for one more tab, under the policy you set: whether you approve each hire. The
lead's checks say when. Once the job is done, `teamrig retire` hands its open tasks to a member
you name and leaves a handover note, and hiring it back picks up where it left off. When one team isn't enough, it
becomes teams of teams: `teamrig team split` moves a few members, with the tasks they own, into a child team with its
own lead, task list and rules. A task keeps its number across the tree, any member asks any team of it for work, and
you still talk to one lead.

![A camera pulls back from your lead as time passes. Day 1: the lead hires a team of three. Week 2: new members join and one whose job is done moves on. Month 2: one team becomes teams of teams, each with its own lead. Month 6: eight teams and 33 members, with members coming and going, and you still talk to one lead.](docs/images/growth.svg)

### Safe while you're away

A push to main asks you first, and a force-push to it is refused. A package runner that would fetch and run an
unvetted package (`npx` of a tool not installed, `pnpm dlx`) is refused, and so is an install of a version published
in the last two weeks or with a known advisory, or one that would rewrite a worktree's `node_modules` linked to the
main checkout's. A call that would print a secret file, the whole environment or a
Kubernetes secret, or whose command line or written file holds a token or a password as text, is refused before it runs, and a secret
a call prints anyway is redacted before Claude sees it. A repository's git hooks call `teamrig secrets`, which refuses
a commit or a push that adds a token or a secret file, whoever makes it. Each helper a member starts gets the same team rules and knows whose
helper it is. Everything runs on your machine, with no account and no cloud bill.

## Also in the box

- **Notes between sessions:** `teamrig inbox add` leaves a line the receiver reads at its next prompt, for one session
  or a group (`--to all`, `leads`, `group:web`). A message that would wake an idle member at full price is held once,
  so a cheap note can take its place.
- **Tab status:** on in every new team, each tab's title starts with a colored circle: ready, working, waiting on you,
  waiting on your decision, an API error or compacting. A tab named after a session (`/rename web`) joins it.
- **Turn log:** each session's prompts and replies for the last day, secrets masked, so a refresh never takes away
  what you were reading.
- **Token savers:** `teamrig doctor` weighs what every call re-reads and names the cheapest cut, and `teamrig test`
  sums up a test run in one line.
- **Status line:** `teamrig statusline install` shows the week's use, the folder, the branch and the command that
  resumes the session.
- **Auto mode knows the team:** `teamrig automode install` adds the team's protected branches, task commands, build
  wrappers and own-branch rebases to Claude Code's auto-mode facts, so auto mode stops asking about them.
- **A model per session:** each session starts on its own model and effort, and you're told when one runs on another.
- **GitHub issues in the task list:** `teamrig gh sync` reads your repositories' open issues every 15 minutes, one way
  only ([GitHub sync](docs/github-sync.md)).
- **Shipping from many sessions:** `teamrig heavy` runs builds and test runs under one host lock, `teamrig merge`
  merges a finished branch (by a push, or through your own merge command such as a pull request), `teamrig deploy` brings it to the running system (or, with `--targets`, restarts some services onto new config with
  nothing pulled), and `teamrig deploy-status` shows it all in one read
  ([Ship from many sessions](docs/guides/ship-from-many-sessions.md)).
- **Reads without a prompt:** with `readonlyShell`, a shell line that only reads (`grep`, `git log`, `kubectl get`)
  runs without asking.
- **Tidy history:** big commits are flagged before they land, `teamrig worktree add` makes every session's worktree
  the same ready way, and `teamrig worktree remove` clears a finished one without emptying the main checkout's
  `node_modules`.

## Learn more

| Page | What's in it |
| --- | --- |
| [How it works in detail](docs/how-it-works.md) | The design, the files and [updating the plugin](docs/how-it-works.md#updating-the-plugin) |
| [Keep it safe](docs/guides/keep-it-safe.md) | The guards: safe pushes, skipped hooks, unvetted packages, secrets, privileged commands on review |
| [Run your day](docs/guides/run-your-day.md) | The daily meeting, a question that never stops a session, notes between sessions, waking on urgent work |
| [Recover from a crash or a full context](docs/guides/recover.md) | Sessions reopened after a crash or a reboot, a fresh context at a task boundary, the turn log |
| [Plan the week](docs/guides/plan-the-week.md) | The week plan and task sizes against the weekly limit, the daily budget and its pace line, bursts |
| [Grow the team](docs/guides/grow-the-team.md) | Setting up a team with a tab per session, session names, hires and their retire, child teams under the lead |
| [Ship from many sessions](docs/guides/ship-from-many-sessions.md) | The host lock for builds and test runs, merging a branch, deploying it, clean measurements beside deploys |
| [Make it improve itself](docs/guides/improve-itself.md) | Lessons kept as skills and team rules, the skills scorecard, settling local rules that say otherwise, a lean setup |
| [Everything teamrig does](docs/features.md) | Every feature, and whether it works today |
| [Every command](docs/commands.md) | Each command with its flags, as `teamrig help` prints it |
| [Every config key](docs/configuration.md) | Each key of the team config with its type, default and meaning, drawn from the schema |
| [Set up a team by hand](docs/setup-by-hand.md) | The two small files a team needs, if you'd rather not ask the lead |
| [GitHub sync](docs/github-sync.md) | GitHub issues in the task list: repositories, tokens and each failure's fix |
| [llms.txt](llms.txt) | teamrig explained for language models: point your AI assistant at it |
| [Contributing](CONTRIBUTING.md) | How teamrig is built: `npm ci` sets the git hooks, every change lands through a reviewed pull request (from a fork for outside contributors), tests, sign-off and the local gate |

## Licence

[Apache License 2.0](LICENSE). Every copy keeps the [NOTICE](NOTICE) file, and a changed copy you share takes a name of
its own ([the name policy](TRADEMARKS.md)).
