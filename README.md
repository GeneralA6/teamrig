# <img src="docs/images/wordmark.svg" alt="teamrig" height="42">

**One lead. Many AI sessions. One task list.** Run several Claude Code sessions on one project as one team, without
two of them owning the same task or force-pushing your main branch. You name the sessions; one leads and hands out
tasks, every task has one owner, and each session sees its own tasks and inbox notes. Claude runs the `teamrig`
commands below for you; you need a terminal, Claude Code and Node.js 22.18 or later.

```sh
claude plugin marketplace add GeneralA6/teamrig
claude plugin install teamrig@teamrig
```

Then [set up your team](#quick-start): two small files, one minute.

<sub>Below, lead, api, web and data are your sessions' names; T1 and T2 are task ids; tier 1 is the most urgent of your
priority tiers; when you next type to a session, the plugin tells it about new inbox notes.</sub>

![Claude Code tabs named lead, api, web and data. Each session runs teamrig itself: the lead adds a task for api and one for web, and tells web its task is ready. Web reads the note and starts its task.](docs/images/hero.svg)

> **Pre-release.** Nothing is stable yet and there is no release; the repository is private until the first one.
> Status marks below: ✅ works today · 🚧 being built (task id) · 🗺 planned.

## Why teamrig

Parallel AI sessions on one project collide, forget what was asked of them, and burn through your budget. teamrig gives
them what a human team has: one list of who does what, a way to pass notes, and shared rules, all in plain files on
your machine.

| You get | How | Status |
| --- | --- | --- |
| **Nothing to run or host** | Plain files on disk, a small CLI and Claude Code hooks. Works offline; no account. | ✅ |
| **A task list nobody loses** | `teamrig add`, `set`, `update`, `list`, `show`: owner, priority tier, due date, goals and week; `show` also lists who changed the task. `check` finds tasks that break a team rule; `plan` prints the week. | ✅ |
| | Dependencies and parent/child tasks | 🚧 T205 |
| | Planned start and ETA, history across tasks (`history --by <session>`), token estimates | 🚧 T209, T210, T211 |
| **Notes between sessions, no server** | `teamrig inbox add --to web`; the receiver is reminded at its next prompt and reads with `inbox read`. `who` gives the name to message a session by. | ✅ |
| **A lead that runs the team** | One session holds the lead role in the team config; every session learns at start who it is and whom to message. | ✅ |
| | Names that survive a rename: `teamrig rename` keeps the session's id, and every old name still works; `teamrig doctor` finds name and inbox problems | ✅ |
| | Sub-team leads (a team tree) | 🗺 |
| **Shared rules, loaded every time** | At start, each session gets the core rules and your team's own rules (`teams/<team>/rules.md` in the kit home; over 3,500 characters, a pointer to it); `check` also lints your skills. | ✅ |
| **Safe pushes from parallel sessions** | A push guard asks before any push to a protected branch (such as main) and refuses a `--force` push or a delete of one (a `--force-with-lease` push asks); `commits check` holds commits to a size rule. | ✅ |
| | A deploy coordinator: one push at a time, a lock for heavy steps, no-deploy windows | 🗺 T228 |
| **Survives reboots** | Reopens your sessions and tabs after a restart | 🗺 T201 |
| **Budget control** | Pacing to the weekly limit, pauses by priority, a daily cap | 🗺 |
| **Hire and retire sessions** | From off to automatic within a budget; rehire from a handover note | 🗺 T212 |
| **Settings and upgrades** | `teamrig config validate` and `config migrate` | ✅ |
| | A new-version notice and `teamrig upgrade` with rollback | 🗺 T203 |
| **Works everywhere** | Windows, macOS and Linux; every change is tested on all three. | ✅ |

## Quick start

1. Install the plugin (the two commands above). Claude Code puts the `teamrig` command on the path of each session's Bash tool.
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

`teamrig config validate` reports a broken config; `teamrig config migrate` moves an older one to the current
format. The full command list is `teamrig help`.

## Works with

teamrig runs with Claude Code in a terminal today; other AI tools and task trackers come after its first release.

| | Today | Planned |
| --- | --- | --- |
| AI coding tools | Claude Code ✅ | Codex 🗺 T204 |
| Editors | Any terminal ✅ | VS Code family, JetBrains 🗺 |
| Task tools | Its own task list ✅ | Jira, Linear, GitHub Issues, Asana 🗺 T206 |

## How it works

Every session runs the same small `teamrig` program, from three Claude Code hooks and from its Bash tool, and that
program reads and writes plain files in your team's folder. Nothing runs between sessions.

```mermaid
flowchart LR
  hooks["Claude Code hooks: session start, each prompt, each Bash command"] --> cli["teamrig"]
  bash["Claude's Bash tool: teamrig add, set, inbox ..."] --> cli
  cli <--> files["~/.teamrig/teams/your-team/: plain files"]
```

[How it works](docs/how-it-works.md) draws each part: the team, a task's life, notes between sessions, safe pushes
and room for other tools.

## Development

```sh
npm ci
npm run setup         # points git at .githooks (scrub + DCO sign-off checks)
npm run check         # CI's gates on your tree: typecheck, tests with the coverage gate, build, dist checks, pictures, doc links, scrub
npm run docs:images   # redraws the README's pictures from the CLI's real output
npm run docs:check    # checks every link, anchor and Mermaid diagram in the Markdown
```

The pictures in this README are drawn by running the real CLI for a made-up team, so they cannot drift from what
the CLI prints: CI fails until they are redrawn. See [CONTRIBUTING.md](CONTRIBUTING.md) for the test and sign-off
rules.

## Licence

[Apache License 2.0](LICENSE).
