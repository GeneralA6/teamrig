import { errorMessage } from '../core/guards.ts';
import { ENV, KIT_NAME } from '../core/home.ts';
import { KIT_VERSION } from '../core/version.ts';
import { parseArgs, UsageError, type CommandFlags, type ParsedArgs } from './args.ts';
import { EXIT, RefusedError, type CliRuntime, type ExitCode } from './runtime.ts';

type Command = (args: ParsedArgs, runtime: CliRuntime) => Promise<ExitCode>;

interface CommandSpec {
  readonly flags: readonly string[];
  /** Commands load on first use, so a hook that runs on every tool call loads only its own code. */
  readonly load: () => Promise<Command>;
}

const registerCommands = () => import('./commands/register.ts');
const inboxCommands = () => import('./commands/inbox.ts');
const configCommands = () => import('./commands/config.ts');
const hookCommands = () => import('./commands/hook.ts');

const TASK_FIELDS = ['title', 'owner', 'ref', 'tier', 'due', 'goals', 'week'];

const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  add: { flags: ['session', 'source', ...TASK_FIELDS], load: async () => (await registerCommands()).add },
  set: { flags: ['session', 'status', 'note', 'evidence', 'skill'], load: async () => (await registerCommands()).set },
  update: { flags: ['session', 'note', ...TASK_FIELDS], load: async () => (await registerCommands()).update },
  list: {
    flags: ['session', 'status', 'source', 'tier', 'due-before', 'week', 'goal'],
    load: async () => (await registerCommands()).list,
  },
  // --session names the caller on every task and inbox command, so a session can always pass it.
  show: { flags: ['session'], load: async () => (await registerCommands()).show },
  check: { flags: ['session', 'week'], load: async () => (await registerCommands()).check },
  plan: { flags: ['session', 'week'], load: async () => (await registerCommands()).plan },
  'inbox read': { flags: ['session'], load: async () => (await inboxCommands()).read },
  'inbox status': { flags: ['session'], load: async () => (await inboxCommands()).status },
  'inbox add': { flags: ['session', 'to', 'text'], load: async () => (await inboxCommands()).add },
  'config validate': { flags: [], load: async () => (await configCommands()).validate },
  'config migrate': { flags: [], load: async () => (await configCommands()).migrate },
  'hook push-guard': { flags: [], load: async () => (await hookCommands()).pushGuard },
  'hook inbox-reminder': { flags: [], load: async () => (await hookCommands()).inboxReminder },
};

const COMMAND_FLAGS: CommandFlags = Object.fromEntries(Object.entries(COMMANDS).map(([name, spec]) => [name, spec.flags]));

export const USAGE = `${KIT_NAME} <command> ...   (the caller: --session <name>, else $${ENV.session})
  add --title "<one line>" --tier <n> [--ref <where it was asked>] [--owner <session>]
      [--source <session>|<owner source>] [--due <date>] [--goals a,b] [--week <date>]
  set <id> --status open|in-progress|blocked|done|dropped [--note "<what/why>"] [--evidence <proof>]
      [--skill <name>|none]
  update <id> [--title ..] [--owner ..] [--tier ..] [--ref ..|none] [--due <date>|none]
      [--goals a,b|none] [--week <date>|none] [--note ..]
  list [--session <owner>] [--status a,b|all] [--source <s>] [--tier 1,2] [--due-before <date>]
      [--week <date>|none] [--goal <tag>]
  show <id>
  check [--week <date>]        tasks and skills that break a team rule
  plan [--week <date>]         the week plan (default: the newest week that has started)
  inbox read [--session <area>]     prints the unread lines and marks them read
  inbox status [--session <area>]   unread lines per area
  inbox add --to <session> --text "<one line>"
  config validate | config migrate
  hook push-guard | hook inbox-reminder    (run by Claude Code with the hook JSON on stdin)
Dates: YYYY-MM-DD or "YYYY-MM-DD HH:MM", UTC. Kit home: $${ENV.home}, else ~/.${KIT_NAME}.
Exit: 0 done, 1 failed, 2 refused by a team rule, 64 a command line it cannot read.`;

const HELP = new Set(['help', '--help', '-h']);
const VERSION = new Set(['version', '--version', '-v']);

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

  try {
    const args = parseArgs(argv, COMMAND_FLAGS);
    const spec = COMMANDS[args.command];
    if (spec === undefined) {
      throw new UsageError(`unknown command "${args.command}"`);
    }
    const command = await spec.load();
    return await command(args, runtime);
  } catch (error) {
    if (error instanceof UsageError) {
      runtime.out.stderr(`${error.message}\n\n${USAGE}`);
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
