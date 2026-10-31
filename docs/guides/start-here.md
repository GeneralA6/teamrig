# Start here

New to teamrig? This page takes you from nothing to a working team: install the plugin, ask one tab for a team, and
learn the five words every other page uses. Each step links to the page with the details.

- [Install](#install)
- [Your first team](#your-first-team)
- [Five words to know](#five-words-to-know)
- [Where to go next](#where-to-go-next)

## Install

Run the install commands under [Get started](../../README.md#get-started) in the README: two for teamrig, and two for
teamrig-pane, which keeps your tasks beside the conversation. It also names the Claude Code and Node.js versions you
need; teamrig checks for anything else when you set up a team, and tells you in plain words what is missing.

## Your first team

1. Open Claude Code in your project folder. In a tab already open, type `/reload-plugins` first.
2. Ask for a team and say what for, in plain words, for example "Build a signup flow: an API, a web form and tests."
   If you ask for a team without saying what for, it asks you first.
3. The tab proposes a team in a few lines. Before anything changes, it backs up your Claude setup and shows what each
   session start costs and what to slim, and you answer yes or no to each group of findings.
4. On your yes, the tab becomes your lead: it writes the team, gives each session its first task and opens a tab for
   it. There are no config files to write.
5. Type `/teamrig-pane` in a tab to keep the tasks in view. It makes no model calls, so it costs no tokens.

From then on you tell the lead what you want, and it hands the work out. [Setting up a
team](grow-the-team.md#setting-up-a-team) shows each step, and [Set up a team by hand](../setup-by-hand.md) the two
small files it writes, if you'd rather write them yourself.

## Five words to know

- **lead**: the session you talk to. It hands out the work, takes whatever is late or stuck, settles the operational
  calls itself and brings you the rest in batches, and meets you once a day ([Run your day](run-your-day.md)).
- **session**: one Claude Code tab on the team, with a name such as `your-team-web`. It works its own task list in
  priority order, and an idle one wakes by itself when urgent work is handed to it
  ([Who is on the team](grow-the-team.md#who-is-on-the-team)).
- **task**: one line on the team's task list, saying what and why in plain words, with one owner, a priority and a
  due date. Only its owner moves it from one status to the next ([A task's life](../how-it-works.md#a-tasks-life)).
- **waiting**: a started task that cannot go on, with each reason it waits for: a decision or an approval, another
  task, or a time. It stays waiting until every reason has cleared, and its session goes on with its other tasks
  meanwhile. A wait on you reaches you through the lead, in a batch.
- **verifying**: a change that has shipped and waits for what proves it, such as a test run, a night's flow or a
  number. It stays in view until its owner records that proof and sets it done, so a shipped change is proven, not
  assumed.

## Where to go next

| You want to | Read |
| --- | --- |
| Know what your day with the team looks like | [Run your day](run-your-day.md) |
| Plan the work to your weekly token limit | [Plan the week](plan-the-week.md) |
| Add sessions, hire for a while, or split off a child team | [Grow the team](grow-the-team.md) |
| Keep pushes, packages and secrets safe | [Keep it safe](keep-it-safe.md) |
| Look up a feature, a command or a config key | [Features](../features.md), [commands](../commands.md), [configuration](../configuration.md) |
