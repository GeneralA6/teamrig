# Requirements

What teamrig needs on the machine, from its code and its CI.

| Needs | Version or setting | Why |
| --- | --- | --- |
| Claude Code | 2.1.139 or later | It loads the plugin, runs its hooks and puts `teamrig` on the PATH. Every hook uses the exec form (`args`), which Claude Code added in 2.1.139. CI does not run Claude Code; hand tests ran on 2.1.299 and 2.1.300. The automatic refresh's `/clear` comes from the plugin's mod (Claude Code's function hooks, tried on 2.1.299); a Claude Code that does not load it gets the restart instead. |
| Node.js | 22.18 or later (`engines` in `package.json`) | `teamrig` and every hook run `node <plugin>/dist/cli/main.js`, so `node` must be on the PATH. 22.18 is the floor `package.json` sets; no older Node.js is tested. |
| Operating system | Linux, Windows or macOS | CI runs the tests on ubuntu, windows and macos, each on Node 22; a newer Node.js is not tested. |
| git | any | The push guard reads git config and aliases; `teamrig commits check` runs git. Not needed for tasks or inboxes. |
| A terminal for `teamrig open` | see below | Only `open` uses one; every other command works in any shell. |

## The requirements check

teamrig checks git, Claude Code and Node.js itself, and says what is missing in one plain line with the fix
([errors](errors.md#requirements)):

- when a session of a team starts, shown to the user once per Claude Code session;
- when `teamrig team create` sets up a team, as `WARN` lines before anything else;
- in `teamrig doctor`, as `requirement` findings.

It reads `$AI_AGENT` for the running Claude Code (set since Claude Code 2.1.120), the running Node.js, and the PATH
for git, and starts no program. Below Claude Code 2.1.139 the hooks cannot run, so only `team create` and `doctor`
can say so; below 2.1.120 the version is unknown and nothing is said. Outside a team's projects the hooks say nothing.

No Claude Code setting has to be turned on for teamrig in auto mode. In default mode, the allow rule
`Bash(teamrig:*)` saves a question before each command: [hooks.md](hooks.md#permissions). The GitHub CLI (`gh`) is needed only for `teamrig gh sync`, which reads GitHub
issues: [GitHub sync](https://github.com/GeneralA6/teamrig/blob/main/docs/github-sync.md).

## Install and update

```sh
claude plugin marketplace add GeneralA6/teamrig
claude plugin install teamrig@teamrig
```

While the plugin is enabled, its `bin/` folder is on the PATH of Claude Code's Bash and PowerShell tools:
`bin/teamrig` serves bash, `bin/teamrig.cmd` PowerShell and cmd. An argument that holds a line break, such as a
multi-line `--description`, reaches teamrig whole from all three, although cmd.exe alone would cut it at the break
([the refusal when it cannot](errors.md#usage-errors-exit-64)). In your own terminal, outside Claude Code, `teamrig`
is not on the PATH unless you add that folder. Each change to the plugin raises its version; to take the newest one, follow
[Updating the plugin](https://github.com/GeneralA6/teamrig/blob/main/docs/how-it-works.md#updating-the-plugin).

## Terminals for `teamrig open`

`--terminal auto` (the default, [open.terminal]) tries tmux when run inside tmux, then the platform's own:

| Platform | Terminal | Program it runs |
| --- | --- | --- |
| any, inside tmux | `tmux` | `tmux new-window` (tmux 3.0 or later) |
| Windows | `windows-terminal` | `wt.exe` |
| macOS | `macos-terminal` | Terminal, through `osascript` |
| Linux | `gnome-terminal`, then `konsole`, then `x-terminal-emulator` | the first one found |

When none works, or with `--terminal print`, `open` prints the command to run in a new terminal and exits 3.
With [open.teamWindow] on, each tab of the team's sessions (`open`, a meeting start, a refresh restart, the idle
pass's reopen, a restore after a reboot) opens in a Windows Terminal window of the team's own, `teamrig-<team>`, made
when none is open, so each team's tabs stay apart; the other terminals open as before.
The new tab runs `claude`, so Claude Code must be on that terminal's PATH.

## The status line (optional)

`teamrig budget` reads each session's use from the transcripts with no setup. The week's use in percent and its
reset come from Claude Code's status line, which a plugin cannot set. Set it once with this command, in a terminal
or typed as `! teamrig statusline install` in Claude Code. It shows the change; run it again with `--yes` to write
it:

```sh
teamrig statusline install
```

It writes a small launcher to `<kit home>/bin`, which finds the installed plugin each time it runs, so a plugin
update needs no new setup, and makes it the status line in your user `settings.json` (`~/.claude/settings.json`,
or in `$CLAUDE_CONFIG_DIR`). A status line you already have keeps running: the launcher goes in front of it in a
pipe and hands it the same input ([commands.md](commands.md#teamrig-statusline-install)). The launcher saves a
small snapshot per Claude Code session in the team's `budget.statusSnapshotDir`, keeps the week's reading in that
folder's `.week` file for the hooks to read and, on a plan with a five-hour window, that window's in `.five-hour`,
and prints the model and the plan's use. `teamrig statusline
uninstall` takes it back out. You can instead have your own status line write the same snapshot JSON
([commands.md](commands.md#teamrig-statusline)) and point `budget.statusSnapshotDir` at its folder; delete a
`.week` and `.five-hour` left there by `teamrig statusline`, else teamrig keeps reading its old week. Without either, set `budget.weeklyLimitW` and `budget.reset` for daily budgets in percent, or
`teamrig budget` shows W only.

## The task pane (optional)

The teamrig-pane plugin shows a session's tasks beside the conversation. It has its own requirements:
[teamrig-pane guide](https://github.com/GeneralA6/teamrig-pane/blob/main/plugins/teamrig-pane/skills/teamrig-pane-guide/SKILL.md).
