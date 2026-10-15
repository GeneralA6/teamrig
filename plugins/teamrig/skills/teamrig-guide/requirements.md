# Requirements

What teamrig needs on the machine, from its code and its CI.

| Needs | Version or setting | Why |
| --- | --- | --- |
| Claude Code | any version with plugins; no minimum is set | It loads the plugin, runs its hooks and puts `teamrig` on the PATH. CI does not run Claude Code; a hand test ran on 2.1.300. |
| Node.js | 22.18 or later (`engines` in `package.json`) | `teamrig` and every hook run `node <plugin>/dist/cli/main.js`, so `node` must be on the PATH. |
| Operating system | Linux, Windows or macOS | CI runs the tests on ubuntu, windows and macos, each on Node 22 and 24. |
| git | any | The push guard reads git config and aliases; `teamrig commits check` runs git. Not needed for tasks or inboxes. |
| A terminal for `teamrig open` | see below | Only `open` uses one; every other command works in any shell. |

No Claude Code setting has to be turned on for teamrig. Which permission modes were tested:
[hooks.md](hooks.md#permissions). The GitHub CLI (`gh`) is not used.

## Install and update

```sh
claude plugin marketplace add GeneralA6/teamrig
claude plugin install teamrig@teamrig
```

While the plugin is enabled, its `bin/` folder is on the PATH of Claude Code's Bash tool (`teamrig`) and
PowerShell tool (`teamrig.cmd`). In your own terminal, outside Claude Code, `teamrig` is not on the PATH unless you
add it. Each change to the plugin raises its version; to take the newest one, follow
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
The new tab runs `claude`, so Claude Code must be on that terminal's PATH.

## The task pane (optional)

The teamrig-pane plugin shows a session's tasks beside the conversation. It has its own requirements:
[teamrig-pane guide](https://github.com/GeneralA6/teamrig-pane/blob/main/plugins/teamrig-pane/skills/teamrig-pane-guide/SKILL.md).
