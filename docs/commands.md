# Commands

Claude runs teamrig's commands for you, from each session's Bash tool, so you rarely type one. They are listed here
for reference, with what two sessions see when they use them.

## Every command

This is what `teamrig help` prints:

```text
teamrig <command> ...   (the caller: --session <id|name>, else $TEAMRIG_SESSION)
  team create <team> --sessions <id,id> [--lead <id>] [--project <dir>] [--parent <team>] [--dry-run]
      writes the team config and ties the project folder to the team (the lead defaults to lead);
      --parent hangs it under that team's lead in a tree of teams
  team tree                    the tree of teams this team is in, with each team's lead and sessions
  open <id|name|team/id> [--prompt "<first prompt>"] [--terminal <name>] [--project <dir>]
      a new terminal tab running Claude Code as that session (team/id: another team of the tree);
      with no terminal it prints the command
  rules [--session <id|name>]  the team rules and who the session is, as a session start gives them
  add --title "<one line>" --priority p<n> [--ref <where it was asked>] [--owner <session>]
      [--source <session>|<owner source>] [--due <date>] [--goals a,b] [--week <date>] [--after T5,T6]
      --after: the tasks to finish before this one starts; its line shows "after T5"
  add --team <child team> --title .. --priority p<n> [...]   the parent lead hands that team's lead a task
  set <id> --status open|in-progress|verifying|waiting|done|dropped [--note "<what/why>"] [--evidence <proof>]
      [--skill <name>|none] [--waits decision:<who>,approval:<who>,task:T<id>,time:<date>]
      waiting needs --waits: who decides or approves (a session or the owner), a task to finish first
      (only once started) or a time; check flags it READY once its tasks finished and its time passed
  update <id> [--title ..] [--owner ..] [--priority ..] [--ref ..|none] [--due <date>|none]
      [--goals a,b|none] [--week <date>|none] [--after T5,T6|none] [--note ..]
  list [--session <owner>] [--status a,b|all] [--source <s>] [--priority p1,p2] [--due-before <date>]
      [--week <date>|none] [--goal <tag>] [--tree] [--all]
      short rows within 3,000 characters; --all: every field of every task
  show <id>
  check [--week <date>] [--tree] [--all]   tasks and skills that break a team rule,
      in a short form within 3,000 characters; --all: every flag in full
  plan [--week <date>] [--tree]    the week plan (default: the newest week that has started)
      --tree (the lead only): also every team under it, read-only, ids as <team>/T<n>
  inbox read [--session <area>]     prints the unread lines and marks them read
  inbox status [--session <area>]   unread lines per area
  inbox add --to <id|name|team/id> --text "<one line>"
      team/id: a lead may write to its parent team's lead and its child teams' leads
  who [<id|name|role>]         the name to message a session by (no argument: every session)
  rename <id|name> <new-name>  records a session's new name; its old names keep finding it
      (the session itself or the lead)
  refresh <id|name>            the lead asks a session to write its handover when it next sets a task done
  refresh --ready              the handover is written; the user types /clear for a fresh start
  doctor                       names, rename log, inboxes, rules.md and the tree of teams that need a fix
  compact [--dry-run]          archives the task list's log and rewrites its snapshot, so reads stay small;
      finished tasks over 8 days old leave the working set (show, list --status done read them);
      checks every task first and writes nothing on a difference
  budget [<id|name>] [--loops] [--day <YYYY-MM-DD>] [--all]
      each session's use today, measured from the Claude Code transcripts, against the week's pace;
      <id|name>: that session by day; --loops: the loop patterns by day; --day: a past day recounted
  budget lift <id|name> --to <pct> --stop-pct <pct> --reason "<why>" [--until <HH:MM|date>] [--reserve]
      (the lead only) that session's daily budget for today, until --until, the day's end or the week
      reaching --stop-pct; --reserve: above budget.lift.maxStopPct, in the last hour before the reset
  budget setup [--daily pace|<pct>] [--max-daily none|<pct>] [--over <action>] [--escalate <mode>]
      [--quiet <HH:MM-HH:MM>|off] [--quiet-action <action>] [--off] [--yes]
      (the lead only) writes the team's budget policy into its config and turns the budget on (--off:
      off); without --yes it shows the change and writes nothing; flags left out keep their values
  statusline                   Claude Code's status line (status JSON on stdin): saves the week's use
      for budget and prints a short status
  config validate | config migrate
  commits check --base <ref> [--tip <ref>]   commits in base..tip (default HEAD) over the size rule
      with no reason line; any is REFUSED, for an integrate script or CI
  hook push-guard | hook cold-send | hook helper-gate | hook inbox-reminder | hook session-start | hook stop
      (run by Claude Code, hook JSON on stdin)
  launch <id> --team <team> --project <dir> [--home <dir>] [--encoded-prompt <text>]
      (run by the tab that open starts: sets the session and starts Claude Code)
Team: $TEAMRIG_TEAM, else the nearest .teamrig.json ({"team": "<id>"}) above the current folder,
else above $CLAUDE_PROJECT_DIR.
Sessions: give an id, a current name or a former one; a session never named is <team>-<id>.
Dates: YYYY-MM-DD or "YYYY-MM-DD HH:MM", UTC. Kit home: $TEAMRIG_HOME, else ~/.teamrig.
Exit: 0 done, 1 failed, 2 refused by a team rule, 3 open printed the command to run itself,
64 a command line it cannot read.
One command's help: teamrig <command> --help.
```

## What a session sees

<sub>Below, lead, api, web and data are your sessions' ids; T1 and T2 are task ids; p1 is the most urgent of your
priorities; when you next type to a session, the plugin tells it about new inbox notes.</sub>

![Claude Code tabs named lead, api, web and data. Each session runs teamrig itself: the lead adds a task for api and one for web, and tells web its task is ready. Web reads the note and starts its task.](images/commands.svg)
