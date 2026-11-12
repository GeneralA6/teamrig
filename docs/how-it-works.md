# How teamrig works

teamrig is one small Node program, the Claude Code hooks that run it and a folder of plain files. Nothing runs between
sessions: no server, no daemon, no network. Each part says, as in [what teamrig does](features.md),
whether it works today, is being built (with its task id) or is planned. Parts not built yet are drawn dashed. New to
teamrig? [Start here](guides/start-here.md) first: install it, set up your first team, and the five words every page
uses.

- [The parts](#the-parts)
- [Growing the team](#growing-the-team)
- [Updating the plugin](#updating-the-plugin)
- [A task's life](#a-tasks-life)
- [Planning the week](#planning-the-week)
- [Running your day](#running-your-day)
- [Recovering a session](#recovering-a-session)
- [Keeping it safe](#keeping-it-safe)
- [Shipping from many sessions](#shipping-from-many-sessions)
- [Improving itself](#improving-itself)
- [Room for other tools](#room-for-other-tools)

## The parts

Each Claude Code session runs the same `teamrig` program, from its hooks and from its Bash tool, and that program
reads and writes your team's folder.

```mermaid
flowchart LR
  subgraph session["Each Claude Code session"]
    direction TB
    start["SessionStart hook"]
    prompt["UserPromptSubmit hook"]
    guard["PreToolUse hooks on Bash, PowerShell, SendMessage and Agent"]
    after["PostToolUse hook on reads, edits and shell calls"]
    stop["Stop hook, at each turn's end"]
    tool["Bash tool: teamrig add, set, inbox add ..."]
  end
  cli["teamrig (one Node program)"]
  folder[("~/.teamrig/teams/your-team/<br>config.json: sessions, names, lead, parent team<br>rules.md: your team's rules<br>state/events.jsonl: the task list<br>state/inbox/: one file per session<br>state/refresh/, handover/: context refresh")]
  git[("git")]
  start --> cli
  prompt --> cli
  guard --> cli
  after --> cli
  stop --> cli
  tool --> cli
  cli <--> folder
  cli -. "push guard and commits check" .-> git
```

| Part | When it runs | What it does |
| --- | --- | --- |
| SessionStart hook | a session starts, resumes, is cleared or is compacted | gives the session the core rules, its name, the lead's name, where its team sits in a tree of teams and your team's `rules.md`, after those of the teams above, all within Claude Code's 10,000-character cap for a start (a task list that does not fit comes as one line naming the command that prints it); tells you and the session, in one MODEL line, when it runs on another model than its `launch` entry asks, with the `/model` to type. It also ties a tab `$TEAMRIG_SESSION` names to that session, so the task pane keeps showing it after a /clear, marks a /clear or a compaction in the session's [turn log](guides/recover.md#the-turn-log) and removes the log's hours past `turnLog.keepHours` |
| SubagentStart hook | a session starts a helper | gives the helper the same core rules and team rules files, and says whose helper it is: the session, not the helper, sets task statuses, adds register entries and sends messages unless the helper's brief asks for them, and the helper saves its full findings in the task's folder (`teamrig files T<id>`) and returns their path; a compaction inside a helper gets the same context ([A helper's start](../plugins/teamrig/skills/teamrig-guide/hooks.md#a-helpers-start)) |
| UserPromptSubmit hook | you send a prompt | first, a prompt that looks like it holds a secret is stopped before Claude reads it, its value cleaned out of Claude Code's prompt history, and nothing below runs ([Each prompt](../plugins/teamrig/skills/teamrig-guide/hooks.md#each-prompt)); otherwise the session's new inbox lines, each shown once; to a leader, one digest of the register changes in its tree since its last prompt ([the leader digest](../plugins/teamrig/skills/teamrig-guide/hooks.md#each-prompt-the-leader-digest)); a line when it binds a hand-started tab by its title, once per cause when it cannot, when it records a Claude Code rename of the session as its team name, or when `.teamrig.json` is broken; once per level, a line telling the session it is past its daily budget while the team has no room today and, by default, is ahead of its pace line; once each, a line when a burst the session is in starts (how to work in it) and when it ends (wind down), and on the lead's tab, once a week, a line when the week's projected surplus is worth a burst ([Bursts](guides/plan-the-week.md#bursts)); nothing otherwise. It writes the prompt to the session's [turn log](guides/recover.md#the-turn-log) |
| PreToolUse hook on Bash and PowerShell | Claude runs a Bash or PowerShell command | finds every `git push` in it, through wrappers, nested shells and git aliases, and asks you or refuses; asks when it cannot read the command ([Safe pushes](guides/keep-it-safe.md#safe-pushes)) |
| PreToolUse hook on SendMessage | Claude messages another session of the team | when the receiver has been idle `messages.coldAfterMinutes` (60 by default) or longer, the message would wake it cold: its first call re-reads its whole context at full price, about 8 times a warm wake. It holds the message once with a note: an inbox line if the receiver need not act now, else every ask for it in one message, sent again; the same tab's next send to it within 15 minutes goes through. Idle time runs from the receiver's last write to its own transcript; a helper, a receiver off the team or one with no transcript yet is never held |
| PreToolUse hook on Agent and Task | Claude launches a helper | with the budget on, asks you or refuses when the session is past its daily budget while the team has no room today and, by default, is ahead of its pace line, or in quiet hours, as `budget.overAction` and `budget.quietHours` say; the lead's helpers, a lifted session's and those of a session with an open or in-progress p0 task always go |
| PostToolUse hook on reads, edits, shell calls and web lookups | a Read, Grep, Glob, Bash, PowerShell, Edit, Write, MultiEdit, NotebookEdit, WebFetch or WebSearch call returns | counts the calls in a row since the last prompt that each ran one step (a read, a lookup, an edit, a test, a build); when the run reaches `loops.chainNudgeAt` (3 by default; 0 turns it off), gives the model one line asking it to send independent reads and lookups as several tool calls in one message, join shell steps into one command, and send an edit with its re-test, priced in context re-reads. Once per run; a helper's calls are not counted. On the lead's tab, also one line at the lead's first edit outside its own files, first test or build, first research (a web lookup, or a search of another session's notes or a sub-team's folder, naming the session or child team lead to ask) and `leadBoundary.searchNudgeAt`-th code search (3 by default), asking it to hand such work off |
| Mod (`hooks/register.ts`) | in each interactive tab, while it runs; `/teamrig` in every session | runs `/teamrig <command>` in the tab with no model turn: a read at once, a command that changes the team's files only when you typed it, asking first when it adds the tab's session ([the /teamrig command](../plugins/teamrig/skills/teamrig-guide/hooks.md#the-mod-the-teamrig-command)); runs the refresh's `/clear` when the automatic restart asks ([A fresh context](guides/recover.md#a-fresh-context)); runs `/reload-plugins` once an installed plugin changed and no turn runs ([Updating the plugin](#updating-the-plugin)); wakes an idle tab when urgent work is handed to its session ([Waking on urgent work](guides/run-your-day.md#waking-on-urgent-work)) |
| Stop hook | a turn ends | after a task is marked done, asks for a handover when a refresh is due, then tells you once ([A fresh context](guides/recover.md#a-fresh-context)); after a task is set waiting, sends the session back once to its other tasks it can start (not those after the waiting one), outside quiet hours and within its daily budget; tells you once, in a MODEL line, when the session runs at another effort than its `launch` entry asks, or when Claude Code switched it to another model after its safeguards stopped a reply, with the `/effort` or `/model` to type; a Budget line as the session passes each warning level of its daily budget, and when a burst it is in starts or ends; on the lead's tab, a Lead boundary line naming the edits, tests and code searches the lead did itself that turn; nothing otherwise. It writes the turn's reply to the session's [turn log](guides/recover.md#the-turn-log) |
| `teamrig` commands | Claude runs them in its Bash tool; you type them in a terminal or after `/teamrig` | the task list, the inbox, names, settings, checks (`teamrig help`) |

A session finds its team through `$TEAMRIG_TEAM`, else the nearest `.teamrig.json` above its folder
(`{"team": "your-team"}`), else the nearest one above `$CLAUDE_PROJECT_DIR`. The folder is `~/.teamrig` unless
`$TEAMRIG_HOME` says otherwise. The task list and the name log change only under a lock, and the inboxes and read
marks only ever grow by a line, so parallel sessions never overwrite each other.

## Growing the team

Who is on a team and how it grows have their own guide, [Grow the team](guides/grow-the-team.md): session names,
child teams, hires and retires, and setting up a team with a tab for each session.

## Updating the plugin

Claude Code installs the version that the plugin's `plugin.json` gives and moves an install only when that version
rises, so every change to the plugin raises it. To take the newest one:

```sh
claude plugin marketplace update teamrig
claude plugin update teamrig@teamrig
```

Each open tab then takes the new version by itself: teamrig's mod (`hooks/register.ts`) reads Claude Code's
`installed_plugins.json` every 15 s, and once an install changed (any plugin's that applies to the tab), the file
has read the same for 10 s and nothing in the plugin store changed for 10 s (an install still copied into the
cache), it runs `/reload-plugins` in the tab while no turn runs. It runs at most one reload per 5
minutes in a tab and never two for the same installs; a refused one goes to Claude Code's debug log and is tried again
5 minutes later. A tab that does not load mods (an older Claude Code, mods off) or a plugin loaded with `--plugin-dir`
still needs `/reload-plugins` typed, or a restart. Claude Code does not check this marketplace for updates by itself
unless you turn on its auto-update in `/plugin`, under Marketplaces.

teamrig's mod tells you instead: once a newer teamrig or teamrig-pane is published, a band above the prompt names it
(`teamrig: teamrig 0.334.0 is out (you run 0.333.0)`) with an Update button, which runs the two commands above for
that plugin and shows "updating", then "updated, reloading" (or the failure in red, with Update again), and a
Dismiss button, which hides that version until a newer one is out. An update made in any tab hides the band in every
other tab within seconds. The network is asked at most
every 6 hours across the machine, and a failed check shows nothing (the guide's
[update notice](../plugins/teamrig/skills/teamrig-guide/hooks.md#the-mod-the-update-notice) has the details).

The `teamrig` the Bash tool runs is the first plugin `bin` folder on its PATH. Claude Code adds the tab's own at the end
of PATH and, from version 2.1.301, adds the new one again after `/reload-plugins`; an older Claude Code keeps the
version the tab started with until it restarts. A session teamrig starts (`teamrig open`, `teamrig restore`) leaves
the opener's plugin `bin` folders off the PATH it hands on, so its Bash tool runs the session's own install and follows
its updates.

## A task's life

Every task has one owner, and only the owner moves it; these are the usual moves.

```mermaid
stateDiagram-v2
  state "in-progress" as working
  [*] --> open: teamrig add
  open --> working: set in-progress
  working --> waiting: set waiting, with its reasons
  waiting --> working: set in-progress, once they cleared
  working --> verifying: set verifying, with its proof, a date and its follow-ups
  verifying --> done: set done, with a note, evidence, a skill and its follow-ups
  verifying --> working: set in-progress, the proof failed
  working --> done: set done, with a note, evidence, a skill and its follow-ups
  open --> dropped: set dropped, with a note
  working --> dropped: set dropped, with a note
  done --> open: reopened by the owner
```

- The owner may move a task from any status to any other; the register keeps every move.
- `done` takes `--skill none` or the name of a skill in your Claude Code skills folder; setting a task to its own
  status again needs `--note`; `add` refuses a title an open, in-progress, verifying or waiting task already has.
- `verifying` and `done` take `--followups` with the tasks the work leaves, each already on the list, or `none`, so a
  finding written only in a notes file cannot close unseen [register.requireFollowupsOn]; `show` lists them.
- `verifying` is a change that has shipped and waits for what proves it: a test run, a night's flow, a number.
  `--proof` names that proof, and `--due` the date to verify it by. It stays active, so `list`, `check`,
  `teamrig verify`, the session's start context and `inbox read` keep it in view until the owner sets it `done`
  with the proof as evidence. Work that needs it waits for that proof: its start is refused until then
  (`register.verifyGate`), and the owner hears of it in its inbox. A start that names what met the proof
  (`--met`) goes through, and the owner is asked to confirm it (`done`) or reopen the task. The owner's own first
  start of new work also waits while one of its verify steps is due: its proof's waits cleared, its verify-by day
  came, or it holds more than `register.maxVerifying`, so shipped changes get proven instead of piling up.
- `waiting` is a started task that cannot go on, with every reason it waits for (`--waits`): a decision or an
  approval (the lead's or the owner's; a peer's work is a task, asked for with `set --ask`), another task to
  finish first, or a time. It stays waiting until all of
  them have cleared: a task when it is done or dropped, a time when it passes, a decision or an approval only when
  the task's owner sets the next status. The lead recording the owner's answer to a card (`teamrig update <id>
  --decided`) drops its wait on the owner at once, so the card leaves the next agenda, and the task stays marked
  decided, flagged `READY`, until its owner acts on it and sets the next status. A task not started that needs another first is not waiting: it stays `open`,
  planned after it (`teamrig update T3 --after T2`), and its line shows `after T2`. A `blocked` written by an
  older teamrig reads as `waiting` with no reasons.
- A wait on the owner reaches the owner through the lead, in batches, so the owner is not interrupted once per
  wait. A wait counts as asked once the lead records a batch asked (`teamrig decisions asked`, kept in
  `state/decisions-asked.json`) or starts the daily meeting after it was set. A batch is due when a wait not yet
  asked is due before the next batch time (asked at once), `decisions.batchAt` waits are not yet asked, or a
  `decisions.batchTimesUtc` time passed; the lead's `start` and `check` say so in one line, and `teamrig
  decisions` prints the batch. A wait asked at once wakes the lead who asks it: the team's lead, or, in a tree of
  teams, the root team's lead. A wait whose decision frees only Improvements work is held for the weekly
  Improvements batch on `focus.improvementsDay`, as on the agenda: off that day it is in no batch and starts none.
- A task's effective due is the earliest of its own due date and the effective dues of the active tasks that need
  it (planned after it or waiting on it), so the work a dated task needs inherits its date: a row shows it as
  `due 10-17 (from T9)`, and lists, `plan`, the meeting's late tasks and `check`'s date flags go by it. A row
  also names another session's active task that needs it (`· needed by T9 (api, due 10-17)`); `show <id> --tree`
  prints what the task needs and what needs it, then the next move (who acts first, on which task); `start` and
  the live task list name the other sessions' tasks waiting on the session (`WAITING ON YOU`), the Roadmap work held
  on it past the limit first. A plan (`--after`) or a wait (`--waits task:`, `--ask`) that would close a loop is
  refused: no task in a loop can finish.
- `teamrig update` changes a task's title, owner, priority, ref, due date, goals, week, the tasks it comes after, its
  size, its type or its critical mark (`--type task|bug`, `--critical`, `--not-critical`; `none` clears the ref, due
  date, goals, week, plan or size), never the status; on a task it does not own, the lead may change the owner,
  priority, due date, week, plan order, size, type, critical mark or pin (`--pin`: the task goes above every other
  task of its owner, one pin per owner, never set by the owner itself), and any session may add a `--note` alone as
  context.
- `teamrig check` reports tasks past their effective due, not picked up 24 hours after they were handed out, untouched for 72 hours,
  or due this week but left out of the week's plan, and owner orders left out of it. A verifying task past its due
  date is `VERIFY-OVERDUE`: it was not verified by then. One with a due date is not called stale while it waits. A verifying task another task needs is `VERIFY-BLOCKS`, and a session holding more than 5 (`register.maxVerifying`) gets a `PILE-UP` on its oldest. Tasks that need each other in a circle (rows an older teamrig could write) are a `LOOP`, flagged on the lowest-numbered one. The first sized task of the week that no longer fits the weekly usage limit left is `OVER-LIMIT` (`plan` prints that line). An unfinished sized task whose cost since it was last sized, as the budget meter attributes it over the 8 UTC days it keeps, passed twice its size (`register.check.overSizeMultiple`) is `OVER-SIZE`, so its owner re-sizes what is left, which restarts the count, or splits it off. A waiting task whose every reason has cleared, or one decided, is `READY`, one waiting on a peer's decision or approval, as an older teamrig wrote it, is `PEER-WAIT`, one waiting on the owner with no decision card is `NO-CARD`, and one the owner ordered that asks the owner with no `--why-ask` is `OWNER-ORDERED` (an order approves its own work and proof), and one asking the owner to decide with no `--gate` is `UNGATED` (only an owner gate or a business decision is the owner's), and one whose card hands a hand step file (`--run`) that changed or went since the audit pinned it is `RUN-CHANGED` (the card then prints `do not run` in place of the run line). A Roadmap task whose decision or approval one of its owner's leaders has left unanswered past `focus.leaderWaitMinutes` is `ROADMAP-WAITS-ON-LEAD`, counted from when the task last asked for something new, so a task long parked on other work gives its leader the whole limit. It also reports a session that
  skips its own priorities: `PRIORITY-SKIP` is a task in progress for over 24 hours
  (`register.check.prioritySkipAfterHours`) while the same session has an open task free to start (every task it comes after finished) that outranks it, by a better band or a higher score in the same band, counted from the latest change of
  owner, status or priority on either task. `SELF-MADE` is a session that added more than 10 tasks for itself
  (`register.check.maxSelfMadePerDay`; created by it, asked by no one else) in the last 24 hours, raised on the
  first of them past that count still active: work nothing asked for, piling up that fast, may be a loop or a drift
  from the goal. `OVER-PACE` is a session holding more unfinished p1 tasks (open, in progress or waiting) than the
  p1 it finished (done or verifying) in the last 7 days and past the first p1, which is in hand, raised on the first p1 in plan order past that pace once
  the session has held tasks for 7 days: p1 then no longer says what comes first, so the lead re-prioritizes. `OFF-GOAL` is a task in progress with no goal outside the week's plan:
  work nothing in the plan asked for. teamrig has no parent tasks yet, so a goal tag or the week is what ties a task
  to the plan. `UNTRIAGED` is a task no leader has classed yet, for its leader's daily batch (`list --untriaged`). A
  quiet task of the lowest class parks out of these reads until an event brings it back (`list --parked`). `NO-PROGRESS` is a plan that stood still: no goal or week-plan task moved by its owner (started, noted, set
  waiting, shipped or closed) since the start of the day before (`register.check.goalProgressDays`; the day starts at
  `wake.dayStartUtc`, else midnight UTC), while the week has usage left. It names the first planned task its owner
  can move now. `STOPGAP-DONE` is a `stopgap T<id>` tag whose task is done or dropped, in a skill or in the files
  `register.check.stopgapFiles` names (default `CLAUDE.md` and `.claude/rules` in the project folder): the stopgap
  it marks is due to go. Then it flags skills in your Claude Code skills folder that break the skill rules. It reports and never
  blocks.
- `teamrig list` and `teamrig check` print a short form within 3,000 characters by default, since a session reads
  them at every work block: counts, short rows and `+N more`. `--all` prints every field of every task or flag.
  A command line teamrig cannot read prints only that command's usage lines; `teamrig <command> --help` shows them.
- Any session asks another team of its tree for work with `teamrig add --team web --title "..." --description "..." --priority p2`:
  the task lands in `web`'s own list, marked as from the asker (`your-team/alpha`). Without `--owner` it goes to
  `web`'s lead, who splits it among its sessions and opens them; `--owner web-front` gives it to that session, and
  `web`'s lead gets a copy line, as it sets its team's work order and may reorder or reassign it with `teamrig update`.
  A team outside the tree is refused. When the task is done or dropped, the asker gets one inbox line,
  `web/T1 done: <title> | evidence: ...`, as its own register holds no copy (its team's lead, once it left that team).
  The lead of a team above `web` relays the human's order with `--source owner`, so the task in `web` stands as the
  human's own order; any other session giving it is refused.
- `teamrig list --tree`, `check --tree` and `plan --tree` give a lead its team's tasks and those of every team
  under it, with ids like `web/T4`. They only read the other teams' lists. With `--tree`, `--session` names the
  lead asking, so a tab without `$TEAMRIG_SESSION` passes `--session lead`. The teams of a tree number their tasks
  from one count, so an id names one task in the whole tree: a new task in any of them takes the next number none
  of them has used. So a wait or an `after` may name another team's task of the tree: `set` and `update` take it,
  `list`, `check`, `plan` and `verify` hold the task while that one is open, `show` prints it read-only, and the
  wake check, the idle pass and keep-working wake, reopen or send its owner on once that team finishes it. A team
  outside a tree reads only its own log: the others are read only when an active task names an id its own list
  lacks.
- The task list is one log that only grows, a line for every move. `teamrig compact` archives it: the log becomes
the next file in `state/archive/` byte for byte and is never deleted, a fresh log starts with a line naming it,
and `state/snapshot.jsonl` holds every task as it stood, so commands and the task pane read the snapshot and the
recent lines instead of the whole history. Tasks done or dropped over 8 days ago, in no week plan from the current
one on, leave the snapshot: `show`, `list --status done` and the plan of a past week still read them from the
archive, and a task that left cannot be changed. `compact --dry-run` prints what it would archive and write, and writes nothing; a real run first
reads the new files back and holds every task against the whole history, and writes nothing on any difference.
`compact --from-history` folds the new snapshot from the archive alone, not the old snapshot: the repair for a
snapshot that lost fields an older teamrig did not read.
After that first `compact`, a write that leaves the log over 512 KiB archives it again and says so in a NOTE line,
or keeps the write and warns when archiving fails (the next write tries again). Both lines name the switch that
turns this off: `register.autoArchive: false` in the team's `config.json`, after which only `compact` archives. Every session must run teamrig
0.3.1 or later before the first `compact`: an older one refuses to write to an archived task list.
- Move every session to teamrig 0.7.0 or later before anyone sets a task `verifying`. An older teamrig skips that
  line with a warning (`1 unreadable line(s)`) and shows the task at its status before it, though it still writes;
  and its `compact` would leave the line out of the new snapshot, so never run `compact` from a teamrig older than
  0.7.0 on a task list that holds one. The default `register.requireNoteOn` already names `verifying`: list it in
  a `config.json` of your own only once every session runs 0.7.0, as an older one reports it as a config problem.
  From 0.7.0 on, a status a later teamrig adds reads as a line from a newer teamrig: the task keeps its last
  status, writes go on, and archiving waits until this teamrig is updated.
- Being built: dependencies and parent/child tasks (T205); planned start, ETA, history and token estimates
  (T209–T211).
- Token use: `teamrig budget` reads each session's use from the Claude Code transcripts (only the lines added
  since its last run, kept per session and day for 8 days in `state/usage/`) and shows it against the week's pace
  line. The daily budget is never a fixed number: at every reading, what is left to the target is spread
  over the active time to the pace end (quiet hours count at `budget.quietHours.paceWeight`). The teams of the kit
  home on one Claude account (`budget.account`, else the one the teams on its Claude config dir name, else that dir;
  each team's dir is the one its sessions last started in, kept in `state/usage/claude-config-dir.json`) split each
  day by weight: a session's weight is its share times its top queued task's weight (by priority, not how many
  tasks it has queued), a team's its sessions' summed, and each session's part of its team's
  part comes after the lifts. With sub-leads (`leads`), a team's part splits first among its sub-leads' groups and
  the sessions the lead leads directly, a group's weight its sessions' summed, and each group splits its part the
  same way.
  The week's use in percent comes from status line snapshots (`teamrig statusline install` sets the status line
  up), else from the metered W at the week's W per percent: learned from `state/usage/meter-log.jsonl` (a line
  each time the status line passes a whole percent, fitted over the newest period whose lines span 10 points, else
  over 8 weeks of lines once they do, so a limit that moves at a reset stops counting, and sooner by a newer period's
  own lines, from 2%, once their rate is 1.5 times that fit or half of it, counting only lines whose W rose from
  the one before, as a team with no tab metering repeats its W while the account's use climbs; a child team on
  its parent's account reads and writes the one of the highest team above it on that account, and every team on it
  logs a crossing as an account line with the W of all their sessions, each other team's as its own meter last
  stored it, so they all fit one W per percent; a tab another team's session runs in is left to that team's meter,
  so the use outside is that of no team), else
  `budget.weeklyLimitW`. Today's use is the use now less the use at today's start, each read between the meter
  log's lines by the W metered and held to the status line's percent, so the fitted rate prices only the part past
  the last line; once that use spans 2 points, the sessions' W today counts at today's own W per percent, so their
  parts add up to the team's day, while it is within 2 times the week's rate either way. Past 100% of the week,
  what is left is the extra-usage pool the lead enters with `teamrig budget extra` (its W per dollar learned from two spent readings, else `budget.extraWPerUsd`), spread the
  same way. A subagent's W is multiplied by `budget.subagentWeight` (default 1), what
  one W of a helper costs in W of a main session, so all W share one price. A session past its part is held (only
  p1 work wakes it, and it escalates as `budget.escalate` says) only while the team has no room today: everyone's
  use today, the use outside the team included, at or past the in-day pace: today's use in quiet hours, plus today's
  allowance times the share of today's active time gone by (the quiet-hour use already lowered the allowance, so a
  night a lift worked through does not read as a morning past the pace). So no session waits while the week has
  room. The hooks warn a session as it passes its daily budget, tell the lead, and can hold its helper launches (`budget.overAction`,
  `budget.quietHours`), never while it has p0 work: urgent work goes on past the daily stop. The lead sets that policy with `teamrig budget setup`, which shows the change before it
  writes it.
  On the way, each team's budget hooks keep its week in `usage/team.week.json` in its state folder (`state/` under
  the team's folder, unless `paths.state` moves it): the team's use of the
  account's week so far, at the week's used rate (everyone's W since the week began over the use the status line reads
  now, so the parts of every team on the account add up to its use), and that plus its part of what the account has left to
  `budget.targetPct`, for a reader that shows each team's week, such as the pane's Teams tab (`parseTeamWeek`,
  from `src/read/index.ts`, reads it). The file names the Claude account it counts in (`budget.account`, else the
  config dir the team's sessions run in) and the stretches that account's week sat at its usage limit, for a reader
  that marks those days without the meter log, such as the pane's Stats tab. It also says where the week's use
  counts from, a reset inside the week when there was one, so the status line's pace stands where `teamrig budget`
  reads it without opening the account's period on every tick. A child team keeps its own; a reader that shows it
  under its parent adds it when both name one account.
  Beside it, `usage/sessions.week.json` holds each session on the team's roster: its use of the week so far,
  at the same rate, so the sessions' parts add up to the team's, and its UTC hours with work this week, for a reader
  that shows each session's week, such as a session's card on the pane's Teams tab (`parseSessionsWeek` reads it).
  With them, `usage/tasks.week.json` holds what each task has cost in the days the meter keeps, at the account's W per
  percent (a task's days can span weeks, so not at one week's used rate), for
  a reader that ranks tasks without metering them, such as the pane's lists (`parseTasksWeek` reads it). A task with a
  size base counts only from that base, as the ranking does, so a reader scores it as `teamrig list` does. The file
  also holds the median cost of each class and type of task done in the last 14 days, which `teamrig list` sizes an
  unsized task by, so a reader sizes those as `list` does too (`storedSizing` reads them) without working them out
  again.

## Planning the week

How the week is planned and paced has its own guide, [Plan the week](guides/plan-the-week.md): the week plan and task
sizes, the daily budget, and bursts.

## Running your day

The owner's day has its own guide, [Run your day](guides/run-your-day.md): the daily meeting, never stuck on a
question, no prompt while nobody answers, notes between sessions and waking on urgent work.

## Recovering a session

How a session comes back has its own guide, [Recover from a crash or a full context](guides/recover.md): after a
crash or a reboot, a fresh context and the turn log.

## Keeping it safe

The guards that read each command before it runs have their own guide, [Keep it safe](guides/keep-it-safe.md):
safe pushes, skipped hooks, unvetted packages, secrets kept out of the conversation, privileged commands on review
and reads without a prompt.

## Shipping from many sessions

How many sessions build, merge and deploy on one host has its own guide,
[Ship from many sessions](guides/ship-from-many-sessions.md): the host lock, merging a branch, deploying it, when a
step holds back, clean measurements and the deploy state in one read.

## Improving itself

How the team keeps what it learns has its own guide, [Make it improve itself](guides/improve-itself.md): a procedure
becomes a skill, skills held to a shape, the skills scorecard, two sessions editing one skill, team rules, settling
the local rules that say otherwise and a lean setup.

## Room for other tools

Today teamrig works with Claude Code, any terminal and its own task list; other tools will come through one small
interface per kind of tool.

```mermaid
flowchart LR
  core["teamrig"]
  ai["AI coding tools: Claude Code today, Codex planned (T204)"]
  editor["Editors: any terminal today, VS Code family and JetBrains planned"]
  pm["Task tools: its own task list and GitHub Issues (read-only import) today, Jira, Linear, Asana planned (T206)"]
  core --- ai
  core --- editor
  core --- pm
```

There is no adapter interface in the code yet: what teamrig knows about Claude Code (its hook fields, its
environment variables, `~/.claude/skills`) is built in. The interface comes with the second AI tool (T204), so it is
shaped by two real tools instead of one.

A program that only shows the team's files, such as the [teamrig-pane](https://github.com/GeneralA6/teamrig-pane)
task pane, reads them through `src/read/index.ts`: the same parse and replay every teamrig command uses, with no
`node:` import anywhere behind it, so it runs where Node's built-in modules do not. It takes the text of the task
list, an inbox, the inbox read marks, the config and a turn-log line, and gives back the tasks, the unread lines and the counts
`teamrig list` warns about. From each team's whole history it also folds the numbers `teamrig stats` prints
(`registerStats`, with `registerHealth` for the Health tiles), so the pane's Stats tab and the command agree, and the
tasks behind each Health count, so a press on a tile lists the very tasks it counts. A task list that was rotated keeps a snapshot of its working set beside it and its older
lines in archive segments: the reader reads the snapshot first (`readSnapshotText`), then the task list, asks
`workingSetPlan` which segments it still needs (none, unless the snapshot is damaged or missing) and folds them with
`assemble`, so its cost follows the recent lines, never the whole history. A task list never rotated reads as
before. A rotation (`src/register/rotate.ts`, run by `teamrig compact` and by a write on a long log, under the task
list's lock) writes in an order every reader survives: the archive segment first, created whole, then the task
list replaced by the marker, then the snapshot. A rotation stopped at any step reads as before, and the next one
completes it. The reader hands `unreadOf` its own line hash: the first 16 hex digits of the SHA-256 of
the line. With no config to read, it names priorities from `DEFAULT_REGISTER`, the register settings a config that
sets none gets.

The reader builds the dependency tree (`TaskTree`) from the rows it keeps, any row with the fields `TreeTask`
names, so the effective dues and needed-by names it shows are the ones teamrig prints.

From each team's config and roster it builds the team tree (`teamNodeOf` per team, then `TeamTree`: a team's parent,
children and root), and from the text of the hire log it reads who was hired and who retired (`readHiringLog`, then
`activeHires`, `retiredSessions`, `rehiredFrom`), the same records teamrig's routing and hire commands use.
From the text of the session log (`SESSION_LOG_IN_STATE` under the team's state folder) it reads each session's
closes and reopens (`readSessionLog`, then `sessionLogBySession`, and `closedOf` for a session closed now), the
records `teamrig close`, the idle pass and `teamrig open` write, so it counts them and shows the last one.
It words a session as the tab titles do, `[acme] lead`, through `sessionDisplay` (and `bareName`, the name without
its team's prefix), so the reader and the titles cannot drift. It reads the model and effort a session starts on with
`launchOf` (its `launch` entry, the lead's defaults under the keys it leaves unset) and words them with
`describeLaunch`, as teamrig launches the session.
