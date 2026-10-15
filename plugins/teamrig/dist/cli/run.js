import { errorMessage } from "../core/guards.js";
import { ENV, KIT_NAME } from "../core/home.js";
import { TEAM_POINTER } from "../core/team.js";
import { KIT_VERSION } from "../core/version.js";
import { CommandHelp } from "./help.js";
import { parseArgs, UsageError } from "./args.js";
import { EXIT, RefusedError } from "./runtime.js";
const registerCommands = () => import("./commands/register.js");
const inboxCommands = () => import("./commands/inbox.js");
const configCommands = () => import("./commands/config.js");
const hookCommands = () => import("./commands/hook.js");
const loopNudgeCommand = () => import("./commands/hook-loop-nudge.js");
const teamCommands = () => import("./commands/team.js");
const commitsCommands = () => import("./commands/commits.js");
const doctorCommands = () => import("./commands/doctor.js");
const refreshCommands = () => import("./commands/refresh.js");
const setupCommands = () => import("./commands/setup.js");
const compactCommands = () => import("./commands/compact.js");
const rulesCommands = () => import("./commands/rules.js");
const openCommands = () => import("./commands/open.js");
const budgetCommands = () => import("./commands/budget.js");
const budgetSetupCommands = () => import("./commands/budget-setup.js");
const statuslineCommands = () => import("./commands/statusline.js");
const testCommand = () => import("./commands/test.js");
const TASK_FIELDS = ['title', 'owner', 'ref', 'priority', 'due', 'goals', 'week', 'after'];
const COMMANDS = {
    add: { flags: ['session', 'source', 'team', ...TASK_FIELDS], load: async () => (await registerCommands()).add },
    set: { flags: ['session', 'status', 'note', 'evidence', 'skill', 'waits'], load: async () => (await registerCommands()).set },
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
    budget: { flags: ['day'], switches: ['loops', 'all'], load: async () => (await budgetCommands()).budget },
    'budget lift': {
        flags: ['session', 'to', 'stop-pct', 'until', 'reason'],
        switches: ['reserve'],
        load: async () => (await budgetCommands()).lift,
    },
    'budget setup': {
        flags: ['session', 'daily', 'max-daily', 'over', 'escalate', 'quiet', 'quiet-action'],
        switches: ['yes', 'off'],
        load: async () => (await budgetSetupCommands()).setup,
    },
    statusline: { flags: [], switches: ['pass'], load: async () => (await budgetCommands()).statusline },
    'statusline install': { flags: [], switches: ['yes'], load: async () => (await statuslineCommands()).install },
    'statusline uninstall': { flags: [], switches: ['yes'], load: async () => (await statuslineCommands()).uninstall },
    'config validate': { flags: [], load: async () => (await configCommands()).validate },
    'config migrate': { flags: [], load: async () => (await configCommands()).migrate },
    'commits check': { flags: ['base', 'tip'], load: async () => (await commitsCommands()).check },
    test: { flags: ['session'], rest: true, load: async () => (await testCommand()).test },
    'hook push-guard': { flags: [], load: async () => (await hookCommands()).pushGuard },
    'hook cold-send': { flags: [], load: async () => (await hookCommands()).coldSend },
    'hook loop-nudge': { flags: [], load: async () => (await loopNudgeCommand()).loopNudge },
    'hook helper-gate': { flags: [], load: async () => (await hookCommands()).helperGateHook },
    'hook inbox-reminder': { flags: [], load: async () => (await hookCommands()).inboxReminder },
    'hook session-start': { flags: [], load: async () => (await hookCommands()).sessionStart },
    'hook stop': { flags: [], load: async () => (await hookCommands()).stop },
};
/** Each command's flags that take a value. The LLM guide test (tools/docs/llm-guide.test.ts) checks the guide documents exactly these. */
export const COMMAND_FLAGS = Object.fromEntries(Object.entries(COMMANDS).map(([name, spec]) => [name, spec.flags]));
/** Each command's flags that take no value, checked by the LLM guide test like `COMMAND_FLAGS`. */
export const COMMAND_SWITCHES = Object.fromEntries(Object.entries(COMMANDS).map(([name, spec]) => [name, spec.switches ?? []]));
/** The commands that take a command line after `--`. */
export const COMMAND_REST = new Set(Object.entries(COMMANDS).flatMap(([name, spec]) => (spec.rest === true ? [name] : [])));
/** `--tier` became `--priority` (levels p1, p2, ...): refused everywhere with the new name, never an alias. */
const RENAMED_FLAGS = { tier: 'priority' };
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
      [--source <session>|<owner source>] [--due <date>] [--goals a,b] [--week <date>] [--after T5,T6]
      --after: the tasks to finish before this one starts; its line shows "after T5"
  add --team <child team> --title .. --priority p<n> [...]   the parent lead hands that team's lead a task
  set <id> --status open|in-progress|verifying|waiting|done|dropped [--note "<what/why>"] [--evidence <proof>]
      [--skill <name>|none] [--waits decision:<who>,approval:<who>,task:T<id>,time:<date>]
      waiting needs --waits: who decides or approves (a session or the owner), a task to finish first
      (only once started) or a time; check flags it READY once its tasks finished and its time passed
  update <id> [--title ..] [--owner ..] [--priority ..] [--ref ..|none] [--due <date>|none]
      [--goals a,b|none] [--week <date>|none] [--after T5,T6|none] [--note ..]
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
  budget [<id|name>] [--loops] [--day <YYYY-MM-DD>] [--all]
      each session's use today, measured from the Claude Code transcripts, against the week's pace;
      <id|name>: that session by day; --loops: the loop patterns by day; --day: a past day recounted
  budget lift <id|name> --to <pct> --stop-pct <pct> --reason "<why>" [--until <HH:MM|date>] [--reserve]
      (the lead only) that session's daily budget for today, until --until, the day's end or the week
      reaching --stop-pct; --reserve: above budget.lift.maxStopPct, in the last hour before the reset
  budget setup [--daily pace|<pct>] [--max-daily none|<pct>] [--over <action>] [--escalate <mode>]
      [--quiet <HH:MM-HH:MM>|off] [--quiet-action <action>] [--off] [--yes]
      (the lead only) writes the team's budget policy into its config and turns the budget on (--off:
      off); without --yes it shows the change and writes nothing; flags left out keep their values
  statusline [--pass]          Claude Code's status line (status JSON on stdin): saves the week's use
      for budget and prints a short status; --pass: prints the status JSON again instead, for the
      status line after it in a pipe
  statusline install [--yes]   makes teamrig statusline Claude Code's status line, in front of the one
      already there; without --yes it shows the change and writes nothing
  statusline uninstall [--yes] takes it back out: the status line before it returns
  config validate | config migrate
  commits check --base <ref> [--tip <ref>]   commits in base..tip (default HEAD) over the size rule
      with no reason line; any is REFUSED, for an integrate script or CI
  test [--session <id|name>] -- <command ...>   runs a test command in the shell, writes all it printed
      to a log (each session keeps its newest 20) and prints one PASS or FAIL line, then each failing
      test within tests.maxFailureChars; exit 0 when the command passed, 1 otherwise
  hook push-guard | hook cold-send | hook loop-nudge | hook helper-gate | hook inbox-reminder | hook session-start | hook stop
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
export const HELP = new Set(['help', '--help', '-h']);
/** The words that print the version; the LLM guide documents them as `teamrig version`. */
export const VERSION = new Set(['version', '--version', '-v']);
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
    let named;
    try {
        const args = parseArgs(argv, COMMAND_FLAGS, COMMAND_SWITCHES, RENAMED_FLAGS, COMMAND_REST);
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
    }
    catch (error) {
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
