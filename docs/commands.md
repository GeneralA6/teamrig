# Commands

Claude runs teamrig's commands for you, from each session's Bash tool, so you rarely type one. They are listed here
for reference, with what two sessions see when they use them.

## Every command

This is what `teamrig help` prints:

```text
teamrig <command> ...   (the caller: --session <id|name>, else TEAMRIG_SESSION)
  team create <team> --sessions <id,id> [--lead <id>] [--project <dir>] [--parent <team>] [--dry-run]
      writes the team config and ties the project folder to the team (the lead defaults to lead);
      --parent hangs it under that team's lead in a tree of teams
  team tree                    the tree of teams this team is in, with each team's lead and sessions
  open <id|name|team/id> [--prompt "<first prompt>"] [--terminal <name>] [--project <dir>]
      a new terminal tab running Claude Code as that session (team/id: another team of the tree);
      with no terminal it prints the command
  rules [--session <id|name>]  the team rules and who the session is, as a session start gives them
  add --title "<one line>" --priority p<n> [--ref <where it was asked>] [--owner <session>]
      [--source <session>|<owner source>] [--due <date>] [--goals a,b] [--week <date>]
  add --team <child team> --title .. --priority p<n> [...]   the parent lead hands that team's lead a task
  set <id> --status open|in-progress|blocked|done|dropped [--note "<what/why>"] [--evidence <proof>]
      [--skill <name>|none]
  update <id> [--title ..] [--owner ..] [--priority ..] [--ref ..|none] [--due <date>|none]
      [--goals a,b|none] [--week <date>|none] [--note ..]
  list [--session <owner>] [--status a,b|all] [--source <s>] [--priority p1,p2] [--due-before <date>]
      [--week <date>|none] [--goal <tag>] [--tree]
  show <id>
  check [--week <date>] [--tree]   tasks and skills that break a team rule
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
  config validate | config migrate
  commits check --base <ref> [--tip <ref>]   commits in base..tip (default HEAD) over the size rule
      with no reason line; any is REFUSED, for an integrate script or CI
  hook push-guard | hook inbox-reminder | hook session-start | hook stop
      (run by Claude Code, hook JSON on stdin)
  launch <id> --team <team> --project <dir> [--home <dir>] [--encoded-prompt <text>]
      (run by the tab that open starts: sets the session and starts Claude Code)
Team: TEAMRIG_TEAM, else the nearest .teamrig.json ({"team": "<id>"}) above the current folder,
else above $CLAUDE_PROJECT_DIR.
Sessions: give an id, a current name or a former one; a session never named is <team>-<id>.
Dates: YYYY-MM-DD or "YYYY-MM-DD HH:MM", UTC. Kit home: $TEAMRIG_HOME, else ~/.teamrig.
Exit: 0 done, 1 failed, 2 refused by a team rule, 3 open printed the command to run itself,
64 a command line it cannot read.
```

## What a session sees

<sub>Below, lead, api, web and data are your sessions' ids; T1 and T2 are task ids; p1 is the most urgent of your
priorities; when you next type to a session, the plugin tells it about new inbox notes.</sub>

![Claude Code tabs named lead, api, web and data. Each session runs teamrig itself: the lead adds a task for api and one for web, and tells web its task is ready. Web reads the note and starts its task.](images/commands.svg)
