# Set up a team by hand

Two small files, one minute.

1. Install the plugin (the two commands in the [README](../README.md#get-started)). Claude Code puts the `teamrig` command on the path of each session's Bash tool.
2. Describe your team in `~/.teamrig/teams/<team>/config.json`:
   ```json
   { "configVersion": 3, "sessions": ["lead", "api", "web", "data"], "roles": { "lead": "lead" } }
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
| Task descriptions | `register.requireDescription` in the team config (since 0.44.0): `false` lets `add` go without `--description` and lets `update --description none` clear one | on: `add` needs a description |
| The verify loop | `register` in the team config: `requireProofOnVerifying` (`false`: a note naming the proof is enough), `verifyGate` (`warn` lets a start that needs a verifying task through, with a warning), `maxVerifying` (`0` turns the `PILE-UP` flag off) | `true`, `refuse`, `5` |
| Context refresh | `refresh` in the team config: `enabled`, `contextTokens`, `everyTasks`, `everyTasksMinTokens`, `tabTitle`, `autoRestart`, `restartDelaySeconds`, `endCommand` (these three since 0.37.0), `handoverDir` | on, at 120,000 tokens or every 3 tasks from 80,000, marks the tab, restarts the session 15 s after its turn ends, no end command, `<team>/handover/` |
| Hiring temporary sessions | `hiring` in the team config (since 0.36.0): `policy` (`off`; `owner`: each `teamrig hire` needs `--approved-by`; `lead`; `automatic` since 0.45.0: the lead decides and a hired session may retire itself once its tasks close), `maxSessions`, `dailyPct`, `maxDailyPct`, `idleHours` and `reviewDays` | the owner approves each hire; 2 hired at once; 1% of the week a day each, 3% in all; 4 idle hours; review after 7 days |
| Weekly token budget | `budget` in the team config: `enabled` adds the pacing sentence to the team rules, with `targetPct` and `reservePct`; `weeklyLimitW`, `reset`, `paceEndHoursBeforeReset`, `dailyPct`, `maxDailyPct` and `sessions.<id>.share` set the pace line and each session's daily part; `subagentWeight` (since 0.35.0) is what one W of a subagent costs in W of a main session. `lift.maxStopPct` and `lift.reserveStopPct` (since 0.9.0) bound the stop % of the lead's `teamrig budget lift`. The lead's `teamrig budget setup` (since 0.14.0) writes `enabled`, `dailyPct`, `maxDailyPct`, `overAction`, `escalate` and `quietHours`, with a preview first. A top-level block since 0.8.0: an older config's `coordinator.budget` is reported as moved | off; target 99.5%, reserve 0.5%; subagent weight 1; lifts stop by 99.3%, or 99.9% with `--reserve` in the last hour; nothing blocks or acts |
| Status line snapshots for `teamrig budget` | `budget.statusSnapshotDir` in the team config, relative to the team's folder; written by `teamrig statusline` once `teamrig statusline install` makes it Claude Code's status line, or by your own status line in the same format ([the status line](../plugins/teamrig/skills/teamrig-guide/requirements.md#the-status-line-optional)) | `<kit home>/usage/live` |
| Pushes to protected branches | `pushGuard` in the team config: `protectedBranches` lists them (an empty list guards nothing); `pushToProtected` (since 0.11.0) set to `allow` lets a normal push through with a note instead of a question. Force-push, mirror and delete stay refused; a `--force-with-lease` push and a command teamrig cannot read still ask | `main` and `master`; `ask` |
| GitHub issues imported as tasks | `github` in the team config: `repos` (`owner/name`, at most 20), `sessions` (a repository to the session that owns its issues), `owners` (a GitHub login to a session), `closedDays` (how far back closed issues are read) and `everyMinutes` (how often the hooks sync on their own; 0 = by hand only); `teamrig gh sync` reads them through `gh`, with the read-only token saved as `teamrig-gh-<owner>` when there is one, and never writes to GitHub ([GitHub sync](github-sync.md)). `$TEAMRIG_GITHUB=off` turns it off on one machine | off (no repos); `closedDays` 14, `everyMinutes` 15 |
| Where `teamrig open` opens a tab | `open.terminal` in the team config: `auto` (tmux inside tmux, else the platform's terminal), `tmux`, `windows-terminal`, `macos-terminal`, `gnome-terminal`, `konsole`, `x-terminal-emulator`, or `print` (prints the command to run) | `auto` |

`teamrig config validate` reports a broken config; `teamrig config migrate` moves an older one to the current format.
A field teamrig cannot read is used at its default and writes are refused until it is fixed; a config from a newer
teamrig is read best-effort and never written. The other keys and their defaults are in
[the config schema](../plugins/teamrig/config.schema.json). The full command list is `teamrig help`, also in
[Every command](commands.md).
