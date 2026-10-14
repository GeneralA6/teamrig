import { errorMessage } from "../core/guards.js";
import { ENV, KIT_NAME } from "../core/home.js";
import { TEAM_POINTER } from "../core/team.js";
import { KIT_VERSION } from "../core/version.js";
import { parseArgs, UsageError } from "./args.js";
import { EXIT, RefusedError } from "./runtime.js";
const registerCommands = () => import("./commands/register.js");
const inboxCommands = () => import("./commands/inbox.js");
const configCommands = () => import("./commands/config.js");
const hookCommands = () => import("./commands/hook.js");
const teamCommands = () => import("./commands/team.js");
const commitsCommands = () => import("./commands/commits.js");
const doctorCommands = () => import("./commands/doctor.js");
const refreshCommands = () => import("./commands/refresh.js");
const setupCommands = () => import("./commands/setup.js");
const rulesCommands = () => import("./commands/rules.js");
const openCommands = () => import("./commands/open.js");
const TASK_FIELDS = ['title', 'owner', 'ref', 'tier', 'due', 'goals', 'week'];
const COMMANDS = {
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
    'team create': { flags: ['sessions', 'lead', 'project'], switches: ['dry-run'], load: async () => (await setupCommands()).teamCreate },
    rules: { flags: ['session'], load: async () => (await rulesCommands()).rules },
    open: { flags: ['prompt', 'terminal', 'project'], load: async () => (await openCommands()).open },
    launch: { flags: ['team', 'project', 'home', 'encoded-prompt'], load: async () => (await openCommands()).launch },
    who: { flags: [], load: async () => (await teamCommands()).who },
    rename: { flags: ['session'], load: async () => (await teamCommands()).rename },
    refresh: { flags: ['session'], switches: ['ready'], load: async () => (await refreshCommands()).refresh },
    doctor: { flags: [], load: async () => (await doctorCommands()).doctor },
    'config validate': { flags: [], load: async () => (await configCommands()).validate },
    'config migrate': { flags: [], load: async () => (await configCommands()).migrate },
    'commits check': { flags: ['base', 'tip'], load: async () => (await commitsCommands()).check },
    'hook push-guard': { flags: [], load: async () => (await hookCommands()).pushGuard },
    'hook inbox-reminder': { flags: [], load: async () => (await hookCommands()).inboxReminder },
    'hook session-start': { flags: [], load: async () => (await hookCommands()).sessionStart },
    'hook stop': { flags: [], load: async () => (await hookCommands()).stop },
};
const COMMAND_FLAGS = Object.fromEntries(Object.entries(COMMANDS).map(([name, spec]) => [name, spec.flags]));
const COMMAND_SWITCHES = Object.fromEntries(Object.entries(COMMANDS).map(([name, spec]) => [name, spec.switches ?? []]));
export const USAGE = `${KIT_NAME} <command> ...   (the caller: --session <id|name>, else ${ENV.session})
  team create <team> --sessions <id,id> [--lead <id>] [--project <dir>] [--dry-run]
      writes the team config and ties the project folder to the team (the lead defaults to lead)
  open <id|name> [--prompt "<first prompt>"] [--terminal <name>] [--project <dir>]
      a new terminal tab running Claude Code as that session; with no terminal it prints the command
  rules [--session <id|name>]  the team rules and who the session is, as a session start gives them
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
  inbox add --to <id|name> --text "<one line>"
  who [<id|name|role>]         the name to message a session by (no argument: every session)
  rename <id|name> <new-name>  records a session's new name; its old names keep finding it
      (the session itself or the lead)
  refresh <id|name>            the lead asks a session to write its handover when it next sets a task done
  refresh --ready              the handover is written; the user types /clear for a fresh start
  doctor                       names, rename log, inboxes and rules.md that need a fix
  config validate | config migrate
  commits check --base <ref> [--tip <ref>]   commits in base..tip (default HEAD) over the size rule
      with no reason line; any is REFUSED, for an integrate script or CI
  hook push-guard | hook inbox-reminder | hook session-start | hook stop
      (run by Claude Code, hook JSON on stdin)
  launch <id> --team <team> --project <dir> [--home <dir>] [--encoded-prompt <text>]
      (run by the tab that open starts: sets the session and starts Claude Code)
Team: ${ENV.team}, else the nearest ${TEAM_POINTER} ({"team": "<id>"}) above the current folder.
Sessions: give an id, a current name or a former one; a session never named is <team>-<id>.
Dates: YYYY-MM-DD or "YYYY-MM-DD HH:MM", UTC. Kit home: $${ENV.home}, else ~/.${KIT_NAME}.
Exit: 0 done, 1 failed, 2 refused by a team rule, 3 open printed the command to run itself,
64 a command line it cannot read.`;
const HELP = new Set(['help', '--help', '-h']);
const VERSION = new Set(['version', '--version', '-v']);
export async function runCli(argv, runtime) {
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
        const args = parseArgs(argv, COMMAND_FLAGS, COMMAND_SWITCHES);
        const spec = COMMANDS[args.command];
        if (spec === undefined) {
            throw new UsageError(`unknown command "${args.command}"`);
        }
        const command = await spec.load();
        return await command(args, runtime);
    }
    catch (error) {
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
