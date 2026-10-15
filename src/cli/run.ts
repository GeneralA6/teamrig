import { errorMessage } from '../core/guards.ts';
import { ENV, KIT_NAME } from '../core/home.ts';
import { TEAM_POINTER } from '../core/team.ts';
import { KIT_VERSION } from '../core/version.ts';
import { CommandHelp } from './help.ts';
import { parseArgs, UsageError, type CommandFlags, type CommandSwitches, type ParsedArgs, type RenamedFlags } from './args.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from './runtime.ts';

type Command = (args: ParsedArgs, runtime: CliRuntime) => Promise<ExitCode>;

interface CommandSpec {
  readonly flags: readonly string[];
  /** Flags that take no value, such as `--ready`. */
  readonly switches?: readonly string[];
  /** Commands load on first use, so a hook that runs on every tool call loads only its own code. */
  readonly load: () => Promise<Command>;
}

const registerCommands = () => import('./commands/register.ts');
const inboxCommands = () => import('./commands/inbox.ts');
const configCommands = () => import('./commands/config.ts');
const hookCommands = () => import('./commands/hook.ts');
const teamCommands = () => import('./commands/team.ts');
const commitsCommands = () => import('./commands/commits.ts');
const doctorCommands = () => import('./commands/doctor.ts');
const refreshCommands = () => import('./commands/refresh.ts');
const setupCommands = () => import('./commands/setup.ts');
const compactCommands = () => import('./commands/compact.ts');
const rulesCommands = () => import('./commands/rules.ts');
const openCommands = () => import('./commands/open.ts');

const TASK_FIELDS = ['title', 'owner', 'ref', 'priority', 'due', 'goals', 'week'];

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  add: { flags: ['session', 'source', 'team', ...TASK_FIELDS], load: async () => (await registerCommands()).add },
  set: { flags: ['session', 'status', 'note', 'evidence', 'skill'], load: async () => (await registerCommands()).set },
  update: { flags: ['session', 'note', ...TASK_FIELDS], load: async () => (await registerCommands()).update },
  list: {
    flags: ['session', 'status', 'source', 'priority', 'due-before', 'week', 'goal'],
    switches: ['tree', 'all'],
    load: async () => (await registerCommands()).list,
  },
  // --session names the caller on every task and inbox command, so a session can always pass it.
  show: { flags: ['session'], load: async () => (await registerCommands()).show },
  check: { flags: ['session', 'week'], switches: ['tree', 'all'], load: async () => (await registerCommands()).check },
  plan: { flags: ['session', 'week'], switches: ['tree'], load: async () => (await registerCommands()).plan },
  'inbox read': { flags: ['session'], load: async () => (await inboxCommands()).read },
  'inbox status': { flags: ['session'], load: async () => (await inboxCommands()).status },
  'inbox add': { flags: ['session', 'to', 'text'], load: async () => (await inboxCommands()).add },
  'team create': { flags: ['sessions', 'lead', 'parent', 'project'], switches: ['dry-run'], load: async () => (await setupCommands()).teamCreate },
  'team tree': { flags: [], load: async () => (await teamCommands()).teamTree },
  rules: { flags: ['session'], load: async () => (await rulesCommands()).rules },
  open: { flags: ['prompt', 'terminal', 'project'], load: async () => (await openCommands()).open },
  launch: { flags: ['team', 'project', 'home', 'encoded-prompt'], load: async () => (await openCommands()).launch },
  who: { flags: [], load: async () => (await teamCommands()).who },
  rename: { flags: ['session'], load: async () => (await teamCommands()).rename },
  refresh: { flags: ['session'], switches: ['ready'], load: async () => (await refreshCommands()).refresh },
  doctor: { flags: [], load: async () => (await doctorCommands()).doctor },
  compact: { flags: [], switches: ['dry-run'], load: async () => (await compactCommands()).compact },
  'config validate': { flags: [], load: async () => (await configCommands()).validate },
  'config migrate': { flags: [], load: async () => (await configCommands()).migrate },
  'commits check': { flags: ['base', 'tip'], load: async () => (await commitsCommands()).check },
  'hook push-guard': { flags: [], load: async () => (await hookCommands()).pushGuard },
  'hook inbox-reminder': { flags: [], load: async () => (await hookCommands()).inboxReminder },
  'hook session-start': { flags: [], load: async () => (await hookCommands()).sessionStart },
  'hook stop': { flags: [], load: async () => (await hookCommands()).stop },
};

/** Each command's flags that take a value. The LLM guide test (tools/docs/llm-guide.test.ts) checks the guide documents exactly these. */
export const COMMAND_FLAGS: CommandFlags = Object.fromEntries(Object.entries(COMMANDS).map(([name, spec]) => [name, spec.flags]));
/** Each command's flags that take no value, checked by the LLM guide test like `COMMAND_FLAGS`. */
export const COMMAND_SWITCHES: CommandSwitches = Object.fromEntries(Object.entries(COMMANDS).map(([name, spec]) => [name, spec.switches ?? []]));
/** `--tier` became `--priority` (levels p1, p2, ...): refused everywhere with the new name, never an alias. */
const RENAMED_FLAGS: RenamedFlags = { tier: 'priority' };

export const USAGE = `${KIT_NAME} <command> ...   (the caller: --session <id|name>, else $${ENV.session})
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
  config validate | config migrate
  commits check --base <ref> [--tip <ref>]   commits in base..tip (default HEAD) over the size rule
      with no reason line; any is REFUSED, for an integrate script or CI
  hook push-guard | hook inbox-reminder | hook session-start | hook stop
      (run by Claude Code, hook JSON on stdin)
  launch <id> --team <team> --project <dir> [--home <dir>] [--encoded-prompt <text>]
      (run by the tab that open starts: sets the session and starts Claude Code)
Team: $${ENV.team}, else the nearest ${TEAM_POINTER} ({"team": "<id>"}) above the current folder,
else above $CLAUDE_PROJECT_DIR.
Sessions: give an id, a current name or a former one; a session never named is <team>-<id>.
Dates: YYYY-MM-DD or "YYYY-MM-DD HH:MM", UTC. Kit home: $${ENV.home}, else ~/.${KIT_NAME}.
Exit: 0 done, 1 failed, 2 refused by a team rule, 3 open printed the command to run itself,
64 a command line it cannot read.
One command's help: ${KIT_NAME} <command> --help.`;

/** Each command's own lines of USAGE, for `<command> --help` and a usage error. */
export const COMMAND_HELP = new CommandHelp(USAGE, Object.keys(COMMANDS));

/** The words that print the usage; the LLM guide documents them as `teamrig help`. */
export const HELP: ReadonlySet<string> = new Set(['help', '--help', '-h']);
/** The words that print the version; the LLM guide documents them as `teamrig version`. */
export const VERSION: ReadonlySet<string> = new Set(['version', '--version', '-v']);

export async function runCli(argv: readonly string[], runtime: CliRuntime): Promise<ExitCode> {
  const [first] = argv;
  if (first === undefined || HELP.has(first)) {
    runtime.out.stdout(USAGE);
    return first === undefined ? EXIT.usage : EXIT.ok;
  }
  if (VERSION.has(first)) {
    runtime.out.stdout(`${KIT_NAME} ${KIT_VERSION}`);
    return EXIT.ok;
  }

  let named: string | undefined;
  try {
    const args = parseArgs(argv, COMMAND_FLAGS, COMMAND_SWITCHES, RENAMED_FLAGS);
    named = args.command;
    if (args.help) {
      runtime.out.stdout(COMMAND_HELP.forCommand(args.command));
      return EXIT.ok;
    }
    const spec = COMMANDS[args.command];
    if (spec === undefined) {
      throw new UsageError(`unknown command "${args.command}"`);
    }
    const command = await spec.load();
    return await command(args, runtime);
  } catch (error) {
    if (error instanceof UsageError) {
      runtime.out.stderr(COMMAND_HELP.usageError(error.message, error.command ?? named));
      return EXIT.usage;
    }
    if (error instanceof RefusedError) {
      runtime.out.stdout(`REFUSED ${error.message}`);
      return EXIT.refused;
    }
    runtime.out.stderr(`FAILED ${errorMessage(error)}`);
    return EXIT.failed;
  }
}
