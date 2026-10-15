# Set up a team by hand

Two small files, one minute.

1. Install the plugin (the two commands in the [README](../README.md#get-started)). Claude Code puts the `teamrig` command on the path of each session's Bash tool.
2. Describe your team in `~/.teamrig/teams/<team>/config.json`:
   ```json
   { "configVersion": 2, "sessions": ["lead", "api", "web", "data"], "roles": { "lead": "lead" } }
   ```
3. Tie your project to the team: put `{"team": "<team>"}` in a `.teamrig.json` at the project's root.
4. Start one Claude Code tab per session, telling each its name, for example `TEAMRIG_SESSION=web claude`
   (PowerShell: `$env:TEAMRIG_SESSION='web'; claude`).

`teamrig team create <team> --sessions <id,id>` does steps 2 and 3 for you, and `teamrig open <session>` opens a tab
for a session (step 4).

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Kit home (teams and their state) | `$TEAMRIG_HOME` | `~/.teamrig` |
| The team | `$TEAMRIG_TEAM`, else the nearest `.teamrig.json` above the current folder, else above `$CLAUDE_PROJECT_DIR` | none |
| The session | `--session <id or name>` on a command, else `$TEAMRIG_SESSION` | none |
| Team members and roles | `<kit home>/teams/<team>/config.json` | none |
| Automatic archiving of the task list | `register.autoArchive` in the team config: `false` stops writes from archiving it; `teamrig compact` still does by hand | on: after the first `compact`, a write past 512 KiB of log archives it and says so in a NOTE line |
| Context refresh | `refresh` in the team config: `enabled`, `contextTokens`, `tabTitle`, `handoverDir` | on, at 250,000 tokens, marks the tab, `<team>/handover/` |
| Weekly token budget | `budget` in the team config: `enabled` adds the pacing sentence to the team rules, with `targetPct` and `reservePct`; `weeklyLimitW`, `reset`, `paceEndHoursBeforeReset`, `dailyPct`, `maxDailyPct` and `sessions.<id>.share` set the pace line and each session's daily part. A top-level block since 0.8.0: an older config's `coordinator.budget` is reported as moved | off; target 99.5%, reserve 0.5%; nothing blocks or acts |
| Where `teamrig open` opens a tab | `open.terminal` in the team config: `auto` (tmux inside tmux, else the platform's terminal), `tmux`, `windows-terminal`, `macos-terminal`, `gnome-terminal`, `konsole`, `x-terminal-emulator`, or `print` (prints the command to run) | `auto` |

`teamrig config validate` reports a broken config; `teamrig config migrate` moves an older one to the current format.
A field teamrig cannot read is used at its default and writes are refused until it is fixed; a config from a newer
teamrig is read best-effort and never written. The other keys and their defaults are in
[the config schema](../plugins/teamrig/config.schema.json). The full command list is `teamrig help`, also in
[Every command](commands.md).
