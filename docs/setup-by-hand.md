# Set up a team by hand

Two small files, one minute.

1. Install the plugin (the two commands in the [README](../README.md#get-started)). Claude Code puts the `teamrig` command on the path of each session's Bash tool.
2. Describe your team in `~/.teamrig/teams/<team>/config.json`:
   ```json
   { "sessions": ["lead", "api", "web", "data"], "roles": { "lead": "lead" } }
   ```
3. Tie your project to the team: put `{"team": "<team>"}` in a `.teamrig.json` at the project's root.
4. Start one Claude Code tab per session, telling each its name, for example `TEAMRIG_SESSION=web claude`
   (PowerShell: `$env:TEAMRIG_SESSION='web'; claude`).

An `init` command that does steps 2 and 3 for you is planned (🗺).

## Configuration

| Setting | Where | Default |
| --- | --- | --- |
| Kit home (teams and their state) | `$TEAMRIG_HOME` | `~/.teamrig` |
| The team | `$TEAMRIG_TEAM`, else the nearest `.teamrig.json` above the current folder | none |
| The session | `--session <id or name>` on a command, else `$TEAMRIG_SESSION` | none |
| Team members and roles | `<kit home>/teams/<team>/config.json` | none |
| Context refresh | `refresh` in the team config: `enabled`, `contextTokens`, `tabTitle`, `handoverDir` | on, at 250,000 tokens, marks the tab, `<team>/handover/` |

`teamrig config validate` reports a broken config; `teamrig config migrate` moves an older one to the current
format. The full command list is `teamrig help`, also in [Every command](commands.md).
