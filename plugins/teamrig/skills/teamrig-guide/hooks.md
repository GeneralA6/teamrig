# Hooks and permissions

The plugin's `hooks/hooks.json` registers four Claude Code hooks. Each runs
`node <plugin>/dist/cli/main.js hook <name>` with a 15 second timeout. Outside a project tied to a team (no `$TEAMRIG_TEAM` and no `.teamrig.json`)
they all stay silent.

| Claude Code event | teamrig hook | What it does |
| --- | --- | --- |
| `SessionStart` (startup, resume, `/clear`, compact) | `hook session-start` | Injects the team rules and who you are |
| `UserPromptSubmit` (each prompt) | `hook inbox-reminder` | Shows new inbox lines; binds a tab started by hand by its title; records a Claude Code rename |
| `PreToolUse` on `Bash` and `PowerShell` | `hook push-guard` | Asks before a push to a protected branch; refuses a force-push or delete of one |
| `Stop` (end of each turn) | `hook stop` | Asks for a handover when a context refresh is due; tells the user of another effort than `launch` asks, or of a model Claude Code switched to |

## Session start

The injected context holds:

1. **The core rules**: numbered rules starting `# Team rules (teamrig core)`, with the team's own values in
   them and the config key behind each value in `[brackets]`. `teamrig rules --session <id>` prints the same
   text.
2. **Who you are**. A known session, found from its last `inbox read` or its tab title rather than
   `$TEAMRIG_SESSION`:

   ```text
   You are the `web` session of team `shop` (name `shop-web`). $TEAMRIG_SESSION is not set here, so pass --session web to every `teamrig` task and inbox command. Message the lead as `shop-lead`.
   `teamrig who` prints the name to message any session by; message only those names.
   ```

   An unknown session:

   ```text
   No session is set ($TEAMRIG_SESSION): ask the user which session you are (`teamrig who` lists them) and pass --session <id> to every `teamrig` task and inbox command. Message the lead as `shop-lead`.
   ```
3. **The tree of teams**, when the team has a parent or children: whom to escalate to, and for a lead with
   sub-teams, how to read and hand them tasks.
4. **Notes**: a config with problems or from a newer teamrig; a recorded rename; a tab bound by its title:
   ``This tab was bound to the `web` session from its Claude Code title; nothing was marked read.``
5. **The team's own `rules.md`**, when it exists. Where it or the project's CLAUDE.md conflicts with the core
   rules, they win.
6. **After a refresh**: `You were refreshed after T2; read your handover first: <path>`, once, at the first
   `/clear` or new start after the handover was written. A compact or resume keeps the old context, so the
   note waits.
7. **A model check**: when the session runs on another model than its `launch` entry in the team config, a line
   such as `MODEL shop-web runs model claude-sonnet-5; the team config asks for model opus at xhigh effort: type
   /model opus`. It is also shown to the user, who alone can change it. It never blocks. Claude Code gives a hook
   the effort only at the end of a turn, so the effort is checked there ([model notices](#end-of-a-turn-model-notices)).

The session is found from `$TEAMRIG_SESSION`, else from the area this Claude Code session last ran
`teamrig inbox read --session <area>` as, else from the tab's Claude Code title (see [Each prompt](#each-prompt)). A
brand-new tab teamrig did not open, with no title naming a session, has none of these, so it is told to ask.

## Each prompt

When your inbox has lines this Claude Code session has not been shown, they are added to your prompt, at most 5
lines and 1,500 characters at a time:

```text
INBOX web, new in /home/you/.teamrig/teams/shop/state/inbox/web.md (each line is shown once; reading marks them read):
- 2026-10-15 08:58 lead: api error codes are in docs/errors.md
+2 more at your next prompt, or all now with: teamrig inbox read --session web
```

Read them there: each line is shown once per Claude Code session (recorded in `state/inbox-shown.jsonl`), and being
shown does not mark it read. `teamrig inbox read --session web` then marks them read without printing them again. A
first line over 1,500 characters is cut, and a note names the command that prints it whole.

A tab started by hand, with no `$TEAMRIG_SESSION` and no `inbox read` yet, binds itself when its Claude Code title
(`claude --name` or `/rename`) is a session's id or current name on this team and on no other team of the tree.
The hook then knows it as `inbox read` would, marks nothing read, and says so once:

```text
teamrig: this tab is now the `web` session of team shop (name `shop-web`), from its Claude Code title; nothing was marked read.
```

A tab it cannot bind gets one line per Claude Code session saying how:

```text
teamrig: this tab is not bound to a session of team shop. To bind it, /rename the tab to its session's id or name, or run `teamrig inbox read --session <id>` (ids: lead, api, web).
```

A title that names no session says so in the same line. A title such as `lead` that names a session on two teams
of the tree binds neither, and the line asks for the session's name instead (`teamrig who` lists them).
`$TEAMRIG_SESSION` and an earlier binding always win over the title.

The same hook notices when the user renamed this Claude Code session (`/rename` or `--name`) and records the new
name as the session's team name, as `teamrig rename` would; a title equal to the session's id only binds the tab and
renames nothing. If the `.teamrig.json` pointer is broken it says so in one line.

## Before a shell command: the push guard

Before Claude runs a Bash or PowerShell command, the guard reads it and decides:

- **Runs as usual**: no `git push` in it, a `--dry-run`, or a push that updates no protected branch
  (`main` and `master` by default [pushGuard.protectedBranches]).
- **Asks the human**: a push that updates a protected branch, `--force-with-lease` included. The reason:
  "This push updates a protected branch (main, master) while other sessions may be working. Confirm, or push your
  own branch and rebase it onto the current one." Commits over the size rule (400 changed non-test lines or 15
  files without a `Large-commit:` line) are listed with it; with `commits.gate: refuse` they turn the ask into a
  refusal.
- **Refuses**: a force-push (`--force`, a `+` refspec), a delete or `--mirror` of a protected branch:
  "Force-pushing, mirroring or deleting a protected branch (main, master) is refused: it can overwrite other
  sessions' commits. Push your own branch, or use --force-with-lease if you truly mean it."
- **Asks, in doubt**: when it cannot read part of the line (an unclosed quote, a branch or alias only known when
  the line runs): "The guard cannot tell whether this command pushes to a protected branch (...): <why>. Confirm,
  or write the push out plainly."

What to do: push your own branch and merge through a pull request, or write the push out plainly so the guard
can read it. Never route around a refusal; report it to the lead. The guard reads chains, subshells, nested shells,
wrappers and git aliases, but it does not see a push inside a script or program the command runs, `gh pr merge`,
git extensions, or pushes run outside Claude Code. It is a guard against mistakes, not a sandbox: protect the
branch on your git host too.

## End of a turn: context refresh

After a turn in which you set a task done, the Stop hook measures your context from the transcript. At or over
`refresh.contextTokens` (250,000 by default; about 150,000 suits a 200k window), or when the lead asked with
`teamrig refresh <id>`, it keeps you going with one instruction: write your handover to
`<home>/teams/<team>/handover/<id>.md`, then run `teamrig refresh --ready --session <id>`, and start nothing new.
After `--ready`, the next turn's end tells the user `teamrig: shop-web finished T2 and wrote its handover; type
/clear for a fresh start` and sets the tab title to `shop-web: type /clear`. Each finished task is judged once, so
it never loops. Steps: [workflows.md](workflows.md#handover-at-high-context). `refresh.enabled: false` turns it
off.

## End of a turn: model notices

The Stop hook also tells the user, in a MODEL line shown once per Claude Code session (a `/clear` starts over):

- when the session runs at another effort than its `launch` entry asks: `MODEL shop-web runs at high effort; the
  team config asks for model opus at xhigh effort: type /effort xhigh`;
- when Claude Code switched the session to another model after its safeguards stopped a reply, a switch it keeps
  for the rest of the session: `MODEL shop-web now runs model claude-opus-4-8, not claude-fable-5-1: Claude Code
  switched after its safeguards stopped a reply (cyber) and keeps it for this session; type /model claude-fable-5-1
  to switch back` (the `/model` names the `launch` model when there is one). This line comes for any session,
  with a `launch` entry or not, and not once the user has switched back.

The lines go to the user only, so they cost the session no context, and they come with `refresh.enabled` on or
off. Which lines a session was shown is kept in `state/model-notices/<id>.json`.

## Permissions

teamrig never edits Claude Code's permission or auto-mode settings, and it adds no allow rules.

- **Auto mode**: no settings entry is needed. In a hand test on Claude Code 2.1.300 with no user settings at all,
  the auto-mode classifier allowed every teamrig command it was given (43 calls: creating a team, adding and
  setting tasks, inbox lines, reads and lists, from Bash and from PowerShell, whether the user named the command or
  the session chose it from the team rules): none was denied or asked.
- **Default mode**: not tested. Claude Code asks before a shell command it has no allow rule for; any allow rule
  is yours to add.
- **The push guard** asks or refuses on its own, whatever the mode: a push to a protected branch always asks the
  human.
