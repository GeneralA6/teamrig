---
name: team-setup
description: Use when the user wants work split across parallel Claude Code sessions, or a part of it grown into a sub-team: propose the team, create it and open each session.
---

# Team setup

The user says what they want built; you turn it into a running team. This tab becomes the team's lead and stays open.

## 1. Read the request

From what the user wrote, work out:

- the sessions: one per part of the work that can go ahead on its own, usually 2 to 5. Each gets a short id of lowercase letters, digits and `-`, such as `api`, `web`, `tests`.
- each session's first task, in one line.
- the team id: a short id from the goal or the project, such as `signup`.
- the project: the folder this session started in, as an absolute path.

Ask only for what you cannot work out, in one question. If `teamrig who` lists sessions here, a team already exists: say so and offer `teamrig open <id>` for its sessions instead.

## 2. Propose once

Show the plan in a few lines, then ask one yes or no question:

```
Team signup, with this tab as the lead:
- api: build the signup endpoint
- web: build the signup form
- tests: write end-to-end tests for signup
Create it and open the three sessions?
```

If the user changes something, show the new plan and ask once more. Run nothing before a yes.

## 3. Create the team, in one Bash call

```
teamrig team create <team> --sessions <id>,<id> --project "<project>" && teamrig inbox read --session lead && teamrig rules --session lead
```

- `team create` writes the team config in the kit home and `.teamrig.json` in the project. A `REFUSED` line says why it stopped (another team has that id, or the project belongs to another team): tell the user and stop.
- `inbox read --session lead` ties this Claude Code session to the lead, so the team's hooks know this tab as the lead from now on.
- `rules --session lead` prints the team rules this tab did not get when it started. Follow them from now on.
- `$TEAMRIG_SESSION` is not set in this tab, so pass `--session lead` to every `teamrig` task and inbox command here.

## 4. Give each session its first task, then open it

One Bash call per session:

```
teamrig add --session lead --owner <id> --priority p2 --title "<first task>" && teamrig open <id>
```

- `open` starts a new terminal tab in the project running Claude Code as that session. It reads its inbox and task list, then starts the task.
- Exit code 3, with a `MANUAL` line: no terminal could be opened from here. Show the user the printed command to paste into a new terminal in the project.
- A `REFUSED` line: tell the user why and stop.

## 5. Tell the user, in three short lines

```
Team <team> is up: <id>, <id> and <id> are working in their own tabs.
This tab is the lead: ask me for status, new tasks or changes.
Close a tab to stop that session; teamrig open <id> starts it again.
```

## 6. Grow a part of the work into a sub-team

When one part outgrows a single session, or the user asks for a team under this one, propose it as in step 2 (the
sub-team's id, its sessions and the part it takes on), then, after a yes, in one Bash call:

```
teamrig team create <sub-team> --sessions <id>,<id> --parent <team> --project "<project>" && teamrig add --session lead --team <sub-team> --priority p2 --title "<the part, in one line>" && teamrig open <sub-team>/lead
```

- The sub-team gets its own lead and task list in the same project. Its lead splits the task among its sessions and
  opens them, and brings you the decisions that need the user: you stay the one lead the user talks to.
- `add --team` hands the task to the sub-team's lead only (it takes no `--owner`): work goes down the tree through
  each team's lead, and questions come back up the same way.
- `teamrig team tree` shows the teams, and `teamrig list --session lead --tree` the tasks of this team and every team
  under it. A tree is at most 3 levels deep, with at most 8 sub-teams under one team; `team create` says when a new
  one would break that.

## Traps

- Do not write the team config or `.teamrig.json` by hand: `team create` checks both before it writes, and a repeat with the same team changes nothing.
- `teamrig team create ... --dry-run` prints what it would write and writes nothing.
- After a `/clear` in this tab, run `teamrig inbox read --session lead` again: a cleared tab is a new Claude Code session, not yet tied to the lead.
