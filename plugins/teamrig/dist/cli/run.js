import { errorMessage } from "../core/guards.js";
import { ENV, KIT_NAME } from "../core/home.js";
import { TEAM_POINTER } from "../core/team.js";
import { KIT_VERSION } from "../core/version.js";
import { cutLineMessage, shimArgs } from "./cmd-shim.js";
import { CommandHelp } from "./help.js";
import { parseArgs, UsageError } from "./args.js";
import { RENAMED } from "./renamed.js";
import { EXIT, RefusedError } from "./runtime.js";
const registerCommands = () => import("./commands/register.js");
const statsCommands = () => import("./commands/stats.js");
const reportCommands = () => import("./commands/report.js");
const goalCommands = () => import("./commands/goal.js");
const inboxCommands = () => import("./commands/inbox.js");
const configCommands = () => import("./commands/config.js");
const hookCommands = () => import("./commands/hook.js");
const loopNudgeCommand = () => import("./commands/hook-loop-nudge.js");
const secretRedactCommand = () => import("./commands/hook-secret-redact.js");
const refreshWakeCommand = () => import("./commands/hook-refresh-wake.js");
const droppedEditCommand = () => import("./commands/hook-dropped-edit.js");
const restoreTrackCommand = () => import("./commands/hook-restore-track.js");
const tabStatusCommand = () => import("./commands/hook-tab-status.js");
const toolEndCommand = () => import("./commands/hook-tool-end.js");
const readonlyAllowCommand = () => import("./commands/hook-readonly-allow.js");
const pickerGuardCommand = () => import("./commands/hook-picker-guard.js");
const promptRefuseCommand = () => import("./commands/hook-prompt-refuse.js");
const routeAllowCommand = () => import("./commands/hook-route-allow.js");
const missingCliCommand = () => import("./commands/hook-missing-cli.js");
const helperStartCommand = () => import("./commands/hook-helper-start.js");
const clearCommands = () => import("./commands/hook-clear.js");
const wakeCommands = () => import("./commands/hook-wake.js");
const meetingDueCommand = () => import("./commands/hook-meeting-due.js");
const refreshModCommands = () => import("./commands/hook-refresh-mod.js");
const teamCommands = () => import("./commands/team.js");
const sessionsCommands = () => import("./commands/sessions.js");
const closeCommands = () => import("./commands/close.js");
const commitsCommands = () => import("./commands/commits.js");
const secretsCommands = () => import("./commands/secrets.js");
const doctorCommands = () => import("./commands/doctor.js");
const filesCommands = () => import("./commands/files.js");
const worktreeCommands = () => import("./commands/worktree.js");
const refreshCommands = () => import("./commands/refresh.js");
const setupCommands = () => import("./commands/setup.js");
const teamSplitCommand = () => import("./commands/team-split.js");
const compactCommands = () => import("./commands/compact.js");
const rulesCommands = () => import("./commands/rules.js");
const ruleConflictCommands = () => import("./commands/rule-conflicts.js");
const skillsCommands = () => import("./commands/skills.js");
const openCommands = () => import("./commands/open.js");
const meetCommands = () => import("./commands/meet.js");
const ownerCommands = () => import("./commands/owner.js");
const restartCommands = () => import("./commands/restart.js");
const idleActCommands = () => import("./commands/idle-act.js");
const budgetCommands = () => import("./commands/budget.js");
const budgetSetupCommands = () => import("./commands/budget-setup.js");
const burstCommands = () => import("./commands/burst.js");
const statuslineCommands = () => import("./commands/statusline.js");
const automodeCommands = () => import("./commands/automode.js");
const permissionsCommands = () => import("./commands/permissions.js");
const setupScanCommand = () => import("./commands/setup-scan.js");
const testCommand = () => import("./commands/test.js");
const queueCommand = () => import("./commands/queue.js");
const withdrawCommand = () => import("./commands/withdraw.js");
const mergeCommand = () => import("./commands/merge.js");
const deployCommand = () => import("./commands/deploy.js");
const freezeCommands = () => import("./commands/freeze.js");
const stablePeriodsCommand = () => import("./commands/stable-periods.js");
const jobCommands = () => import("./commands/job.js");
const deployStatusCommand = () => import("./commands/deploy-status.js");
const ghCommands = () => import("./commands/gh.js");
const startCommands = () => import("./commands/start.js");
const meetingCommands = () => import("./commands/meeting.js");
const meetingsCommands = () => import("./commands/meetings.js");
const decisionsCommands = () => import("./commands/decisions.js");
const hireCommands = () => import("./commands/hire.js");
const retireCommands = () => import("./commands/retire.js");
const promoteCommands = () => import("./commands/promote.js");
const slashCommands = () => import("./commands/slash.js");
const restoreCommands = () => import("./commands/restore.js");
const restoreInstallCommands = () => import("./commands/restore-install.js");
const execCommands = () => import("./commands/exec.js");
const refsCommands = () => import("./commands/refs.js");
const sweepCommands = () => import("./commands/sweep.js");
const setupBackupCommands = () => import("./commands/setup-backup.js");
const TASK_FIELDS = ['title', 'description', 'owner', 'ref', 'priority', 'due', 'goals', 'week', 'after', 'size', 'type', 'class'];
/** The parts of a bug's review `set` gives (register/review.ts REVIEW_FLAGS). */
const REVIEW_FLAGS = ['cause', 'how', 'prevent', 'harden', 'missed-test', 'missed-monitor', 'missed-log'];
const COMMANDS = {
    add: { effect: 'write', flags: ['session', 'source', 'team', ...TASK_FIELDS], switches: ['critical'], load: async () => (await registerCommands()).add },
    set: { effect: 'write', flags: ['session', 'status', 'note', 'evidence', 'skill', 'followups', 'waits', 'question', 'options', 'recommend', 'default', 'why-ask', 'gate', 'proof', 'watch', 'met', 'due', 'ask', 'text', ...REVIEW_FLAGS], switches: ['one-commit'], load: async () => (await registerCommands()).set },
    update: { effect: 'write', flags: ['session', 'note', 'later', ...TASK_FIELDS], switches: ['pin', 'unpin', 'critical', 'not-critical', 'decided'], load: async () => (await registerCommands()).update },
    'refs apply': { effect: 'write', flags: ['session'], switches: ['yes'], load: async () => (await refsCommands()).apply },
    // No register changes, but --out writes the path the line names: a line no person typed must not reach that.
    sweep: { effect: 'write', flags: ['session', 'out'], switches: ['tree'], load: async () => (await sweepCommands()).sweep },
    'sweep apply': { effect: 'write', flags: ['session'], switches: ['apply'], load: async () => (await sweepCommands()).apply },
    approve: { effect: 'write', flags: ['session', 'note'], switches: ['decline'], load: async () => (await registerCommands()).approve },
    list: {
        effect: 'read',
        flags: ['session', 'status', 'source', 'priority', 'due-before', 'week', 'goal', 'type'],
        switches: ['tree', 'all'],
        load: async () => (await registerCommands()).list,
    },
    // --session names the caller on every task and inbox command, so a session can always pass it.
    show: { effect: 'read', flags: ['session'], switches: ['tree'], load: async () => (await registerCommands()).show },
    check: { effect: 'read', flags: ['session', 'week'], switches: ['tree', 'all'], load: async () => (await registerCommands()).check },
    plan: { effect: 'read', flags: ['session', 'week'], switches: ['tree'], load: async () => (await registerCommands()).plan },
    verify: { effect: 'read', flags: ['session'], load: async () => (await registerCommands()).verify },
    stats: { effect: 'read', flags: ['session', 'range'], switches: ['tree'], load: async () => (await statsCommands()).stats },
    'report done': { effect: 'read', flags: ['session', 'day'], switches: ['all'], load: async () => (await reportCommands()).reportDone },
    'goal add': { effect: 'write', flags: ['session', 'title', 'start', 'target', 'parent'], load: async () => (await goalCommands()).goalAdd },
    'goal set': { effect: 'write', flags: ['session', 'target', 'title', 'note'], load: async () => (await goalCommands()).goalSet },
    'goal rank': { effect: 'write', flags: ['session'], load: async () => (await goalCommands()).goalRank },
    'goal list': { effect: 'read', flags: ['session'], load: async () => (await goalCommands()).goalList },
    'goal show': { effect: 'read', flags: ['session'], load: async () => (await goalCommands()).goalShow },
    files: { effect: 'write', flags: ['session'], switches: ['notes'], load: async () => (await filesCommands()).files },
    'inbox read': { effect: 'write', flags: ['session'], load: async () => (await inboxCommands()).read },
    'inbox status': { effect: 'read', flags: ['session'], load: async () => (await inboxCommands()).status },
    'inbox add': { effect: 'write', flags: ['session', 'to', 'text', 'wake', 'wake-by'], load: async () => (await inboxCommands()).add },
    'exec request': { effect: 'write', flags: ['session', 'file'], load: async () => (await execCommands()).request },
    'exec dry-run': { effect: 'write', flags: [], load: async () => (await execCommands()).dryRun },
    'exec approve': { effect: 'write', flags: ['session', 'note', 'team'], load: async () => (await execCommands()).approve },
    'exec refuse': { effect: 'write', flags: ['session', 'note', 'team'], load: async () => (await execCommands()).refuse },
    'exec escalate': { effect: 'write', flags: ['session', 'note', 'team'], load: async () => (await execCommands()).escalate },
    'exec run': { effect: 'write', flags: [], load: async () => (await execCommands()).run },
    'exec status': { effect: 'read', flags: ['team'], load: async () => (await execCommands()).status },
    'team create': { effect: 'write', flags: ['sessions', 'lead', 'parent', 'project'], switches: ['dry-run'], load: async () => (await setupCommands()).teamCreate },
    'team split': { effect: 'write', flags: ['session', 'lead', 'sessions'], switches: ['dry-run'], load: async () => (await teamSplitCommand()).teamSplit },
    'team tree': { effect: 'read', flags: [], load: async () => (await teamCommands()).teamTree },
    rules: { effect: 'read', flags: ['session'], load: async () => (await rulesCommands()).rules },
    'rules scan': { effect: 'read', flags: ['kind'], switches: ['all'], load: async () => (await ruleConflictCommands()).scan },
    'rules keep': { effect: 'write', flags: ['session', 'rule', 'wins', 'reason'], switches: ['yes'], load: async () => (await ruleConflictCommands()).keep },
    'rules forget': { effect: 'write', flags: ['session'], switches: ['yes'], load: async () => (await ruleConflictCommands()).forget },
    'rules clear': { effect: 'write', flags: ['session', 'kind', 'seen', 'except'], switches: ['all', 'yes'], load: async () => (await ruleConflictCommands()).clear },
    'skills scorecard': {
        effect: 'read',
        flags: ['from', 'to', 'baseline-from', 'baseline-to'],
        load: async () => (await skillsCommands()).scorecard,
    },
    start: { effect: 'write', flags: ['session'], switches: ['all'], load: async () => (await startCommands()).start },
    'meeting start': { effect: 'write', flags: ['session'], load: async () => (await meetingCommands()).meetingStart },
    'meeting agenda': { effect: 'write', flags: ['session'], load: async () => (await meetingCommands()).meetingAgenda },
    'meeting end': { effect: 'write', flags: ['session', 'note'], load: async () => (await meetingCommands()).meetingEnd },
    'meeting schedule': { effect: 'write', flags: ['session', 'meets', 'at', 'about', 'minutes', 'with', 'tasks', 'brief'], load: async () => (await meetingsCommands()).meetingSchedule },
    'meeting list': { effect: 'read', flags: ['session'], switches: ['all', 'json'], load: async () => (await meetingsCommands()).meetingList },
    'meeting move': { effect: 'write', flags: ['session', 'at', 'note'], load: async () => (await meetingsCommands()).meetingMove },
    'meeting drop': { effect: 'write', flags: ['session', 'note'], load: async () => (await meetingsCommands()).meetingDrop },
    decisions: { effect: 'read', flags: ['session'], load: async () => (await decisionsCommands()).decisions },
    'decisions asked': { effect: 'write', flags: ['session'], load: async () => (await decisionsCommands()).decisionsAsked },
    open: { effect: 'write', flags: ['prompt', 'terminal', 'project'], switches: ['resume'], load: async () => (await openCommands()).open },
    meet: { effect: 'write', flags: ['session', 'terminal', 'project'], switches: ['cards'], load: async () => (await meetCommands()).meet },
    // No --session: the owner's actions are always written as register.ownerSource; a hook refuses them from an agent's
    // tool call (src/hooks/exec-guard.ts), and their writes refuse themselves under CLAUDECODE (commands/owner.ts).
    'owner note': { effect: 'write', flags: ['text'], load: async () => (await ownerCommands()).ownerNote },
    'owner next': { effect: 'write', flags: [], switches: ['preview'], load: async () => (await ownerCommands()).ownerNext },
    launch: { effect: 'internal', flags: ['team', 'project', 'home', 'encoded-prompt', 'resume', 'effort'], switches: ['no-prompt'], load: async () => (await openCommands()).launch },
    restore: { effect: 'read', flags: [], load: async () => (await restoreCommands()).restorePreview },
    'restore run': { effect: 'write', flags: ['since', 'terminal', 'home'], switches: ['tab'], load: async () => (await restoreCommands()).restoreRun },
    'restore check': { effect: 'write', flags: ['terminal', 'home'], load: async () => (await restoreCommands()).restoreCheck },
    'restore install': { effect: 'write', flags: [], switches: ['yes'], load: async () => (await restoreInstallCommands()).restoreInstall },
    'restore uninstall': { effect: 'write', flags: [], switches: ['yes'], load: async () => (await restoreInstallCommands()).restoreUninstall },
    'restore resume': { effect: 'internal', flags: ['project', 'home', 'effort', 'encoded-prompt'], load: async () => (await restoreCommands()).restoreResume },
    restart: { effect: 'internal', flags: ['team', 'at', 'project'], load: async () => (await restartCommands()).restart },
    'idle-close': { effect: 'internal', flags: ['team', 'project'], load: async () => (await idleActCommands()).idleClose },
    'idle-open': { effect: 'internal', flags: ['team', 'project'], load: async () => (await idleActCommands()).idleOpen },
    who: { effect: 'read', flags: [], load: async () => (await teamCommands()).who },
    sessions: { effect: 'read', flags: ['project'], switches: ['pass'], load: async () => (await sessionsCommands()).sessions },
    close: { effect: 'write', flags: ['session', 'project'], switches: ['yes'], load: async () => (await closeCommands()).close },
    rename: { effect: 'write', flags: ['session'], load: async () => (await teamCommands()).rename },
    hire: {
        effect: 'write',
        flags: ['session', 'scope', 'reason', 'name', 'model', 'effort', 'review', 'approved-by'],
        switches: ['yes', 'burst'],
        load: async () => (await hireCommands()).hire,
    },
    retire: { effect: 'write', flags: ['session', 'to', 'no-handover', 'reason'], switches: ['yes'], load: async () => (await retireCommands()).retire },
    promote: { effect: 'write', flags: ['session', 'members'], switches: ['yes'], load: async () => (await promoteCommands()).promote },
    demote: { effect: 'write', flags: ['session'], switches: ['yes'], load: async () => (await promoteCommands()).demote },
    refresh: { effect: 'write', flags: ['session'], switches: ['ready'], load: async () => (await refreshCommands()).refresh },
    doctor: { effect: 'read', flags: [], load: async () => (await doctorCommands()).doctor },
    compact: { effect: 'write', flags: [], switches: ['dry-run', 'from-history'], load: async () => (await compactCommands()).compact },
    'gh sync': { effect: 'write', flags: ['repo'], switches: ['yes', 'auto'], load: async () => (await ghCommands()).ghSync },
    budget: { effect: 'read', flags: ['day', 'task'], switches: ['loops', 'burn', 'misses', 'all'], load: async () => (await budgetCommands()).budget },
    'budget lift': {
        effect: 'write',
        flags: ['session', 'part', 'stop-pct', 'until', 'reason'],
        switches: ['group', 'reserve'],
        load: async () => (await budgetCommands()).lift,
    },
    'budget cut': { effect: 'write', flags: ['session', 'until', 'reason'], load: async () => (await budgetCommands()).cut },
    'budget extra': { effect: 'write', flags: ['session', 'add', 'spent'], load: async () => (await budgetCommands()).extra },
    'budget setup': {
        effect: 'write',
        flags: ['session', 'over', 'escalate', 'quiet', 'quiet-action'],
        switches: ['yes', 'off'],
        load: async () => (await budgetSetupCommands()).setup,
    },
    burst: { effect: 'read', flags: [], load: async () => (await burstCommands()).burst },
    'burst start': {
        effect: 'write',
        flags: ['session', 'reason', 'sessions', 'helpers', 'hires', 'stop-pct', 'by', 'task', 'approved-by'],
        switches: ['yes'],
        load: async () => (await burstCommands()).start,
    },
    'burst end': { effect: 'write', flags: ['session', 'reason'], load: async () => (await burstCommands()).end },
    statusline: { effect: 'internal', flags: [], switches: ['pass'], load: async () => (await budgetCommands()).statusline },
    'statusline install': { effect: 'write', flags: [], switches: ['yes'], load: async () => (await statuslineCommands()).install },
    'statusline uninstall': { effect: 'write', flags: [], switches: ['yes'], load: async () => (await statuslineCommands()).uninstall },
    'automode install': { effect: 'write', flags: [], switches: ['yes'], load: async () => (await automodeCommands()).install },
    'automode uninstall': { effect: 'write', flags: [], switches: ['yes'], load: async () => (await automodeCommands()).uninstall },
    'permissions trim': { effect: 'write', flags: [], switches: ['all', 'yes'], load: async () => (await permissionsCommands()).trim },
    'setup backup': { effect: 'write', flags: ['project'], load: async () => (await setupBackupCommands()).backup },
    'setup restore': { effect: 'write', flags: [], switches: ['yes', 'remove-new'], load: async () => (await setupBackupCommands()).restore },
    'setup scan': { effect: 'read', flags: ['project', 'days', 'max-mb'], switches: [], load: async () => (await setupScanCommand()).scan },
    'config validate': { effect: 'read', flags: [], load: async () => (await configCommands()).validate },
    'config migrate': { effect: 'write', flags: [], switches: ['yes'], load: async () => (await configCommands()).migrate },
    'commits check': { effect: 'read', flags: ['base', 'tip'], load: async () => (await commitsCommands()).check },
    'secrets staged': { effect: 'read', flags: [], load: async () => (await secretsCommands()).staged },
    'secrets message': { effect: 'read', flags: [], load: async () => (await secretsCommands()).message },
    'secrets pushed': { effect: 'read', flags: [], load: async () => (await secretsCommands()).pushed },
    'worktree add': { effect: 'write', flags: ['repo'], load: async () => (await worktreeCommands()).add },
    'worktree remove': { effect: 'write', flags: ['base', 'session'], switches: ['delete-branch', 'dry-run'], load: async () => (await worktreeCommands()).remove },
    test: { effect: 'write', flags: ['session'], rest: true, load: async () => (await testCommand()).test },
    queue: { effect: 'write', flags: ['session', 'what', 'max-minutes'], switches: ['small', 'pre-push'], rest: true, load: async () => (await queueCommand()).queue },
    withdraw: { effect: 'write', flags: ['session', 'what'], switches: ['all'], load: async () => (await withdrawCommand()).withdraw },
    merge: { effect: 'write', flags: ['session'], switches: ['keep-remote', 'no-delete-local'], load: async () => (await mergeCommand()).merge },
    deploy: { effect: 'write', flags: ['session', 'repo', 'targets', 'what'], rest: true, load: async () => (await deployCommand()).deploy },
    freeze: { effect: 'write', flags: ['session', 'targets', 'metric', 'why', 'for'], load: async () => (await freezeCommands()).freeze },
    unfreeze: { effect: 'write', flags: ['session'], load: async () => (await freezeCommands()).unfreeze },
    'stable-periods': { effect: 'read', flags: ['targets', 'since', 'until', 'settle', 'min'], load: async () => (await stablePeriodsCommand()).stablePeriods },
    job: { effect: 'write', flags: ['session', 'what', 'targets', 'at'], load: async () => (await jobCommands()).job },
    'job end': { effect: 'write', flags: ['session', 'id', 'at'], load: async () => (await jobCommands()).jobEnd },
    'deploy-status': { effect: 'read', flags: [], load: async () => (await deployStatusCommand()).deployStatus },
    'hook push-guard': { effect: 'internal', flags: [], load: async () => (await hookCommands()).pushGuard },
    'hook package-guard': { effect: 'internal', flags: [], load: async () => (await hookCommands()).packageGuard },
    'hook secret-guard': { effect: 'internal', flags: [], load: async () => (await hookCommands()).secretGuard },
    'hook exec-guard': { effect: 'internal', flags: [], load: async () => (await hookCommands()).execGuard },
    'hook pass-record-guard': { effect: 'internal', flags: [], load: async () => (await hookCommands()).passRecordGuard },
    'hook cold-send': { effect: 'internal', flags: [], load: async () => (await hookCommands()).coldSend },
    'hook failed-send': { effect: 'internal', flags: [], load: async () => (await hookCommands()).failedSend },
    'hook missing-cli': { effect: 'internal', flags: [], load: async () => (await missingCliCommand()).missingCli },
    'hook route-reminder': { effect: 'internal', flags: [], load: async () => (await hookCommands()).routeReminder },
    'hook loop-nudge': { effect: 'internal', flags: [], load: async () => (await loopNudgeCommand()).loopNudge },
    'hook secret-redact': { effect: 'internal', flags: [], load: async () => (await secretRedactCommand()).secretRedact },
    'hook helper-gate': { effect: 'internal', flags: [], load: async () => (await hookCommands()).helperGateHook },
    'hook inbox-reminder': { effect: 'internal', flags: [], load: async () => (await hookCommands()).inboxReminder },
    'hook session-start': { effect: 'internal', flags: [], load: async () => (await hookCommands()).sessionStart },
    'hook stop': { effect: 'internal', flags: [], load: async () => (await hookCommands()).stop },
    'hook subagent-start': { effect: 'internal', flags: [], load: async () => (await helperStartCommand()).subagentStart },
    'hook subagent-stop': { effect: 'internal', flags: [], load: async () => (await droppedEditCommand()).subagentStop },
    'hook refresh-wake': { effect: 'internal', flags: [], load: async () => (await refreshWakeCommand()).refreshWake },
    'hook restore-track': { effect: 'internal', flags: [], load: async () => (await restoreTrackCommand()).restoreTrack },
    'hook tab-status': { effect: 'internal', flags: [], load: async () => (await tabStatusCommand()).tabStatus },
    'hook tool-end': { effect: 'internal', flags: [], load: async () => (await toolEndCommand()).toolEnd },
    'hook readonly-allow': { effect: 'internal', flags: [], load: async () => (await readonlyAllowCommand()).readonlyAllow },
    'hook picker-guard': { effect: 'internal', flags: [], load: async () => (await pickerGuardCommand()).pickerGuard },
    'hook prompt-refuse': { effect: 'internal', flags: [], load: async () => (await promptRefuseCommand()).promptRefuse({ table: COMMAND_TABLE }) },
    'hook route-allow': { effect: 'internal', flags: [], load: async () => (await routeAllowCommand()).routeAllow({ table: COMMAND_TABLE }) },
    'hook clear-dir': { effect: 'internal', flags: [], load: async () => (await clearCommands()).clearDir },
    'hook clear-claim': { effect: 'internal', flags: ['why'], switches: ['hold'], load: async () => (await clearCommands()).clearClaim },
    'hook wake-check': { effect: 'internal', flags: [], load: async () => (await wakeCommands()).wakeCheck },
    'hook wake-dropped': { effect: 'internal', flags: [], load: async () => (await wakeCommands()).wakeDropped },
    'hook meeting-due': { effect: 'internal', flags: [], load: async () => (await meetingDueCommand()).meetingDue },
    'hook refresh-mid': { effect: 'internal', flags: [], load: async () => (await refreshModCommands()).refreshMid },
    'hook compact-check': { effect: 'internal', flags: [], load: async () => (await refreshModCommands()).compactCheck },
    'hook slash-command': {
        effect: 'internal',
        flags: [],
        load: async () => (await slashCommands()).slashCommand({
            table: COMMAND_TABLE,
            help: COMMAND_HELP,
            run: runCli,
        }),
    },
};
/** Each command's flags that take a value. The LLM guide test (tools/docs/llm-guide.test.ts) checks the guide documents exactly these. */
export const COMMAND_FLAGS = Object.fromEntries(Object.entries(COMMANDS).map(([name, spec]) => [name, spec.flags]));
/** Each command's flags that take no value, checked by the LLM guide test like `COMMAND_FLAGS`. */
export const COMMAND_SWITCHES = Object.fromEntries(Object.entries(COMMANDS).map(([name, spec]) => [name, spec.switches ?? []]));
/** Each command's effect, so `/teamrig` knows what runs at once, what only when the person typed it, and what never. */
export const COMMAND_EFFECTS = Object.fromEntries(Object.entries(COMMANDS).map(([name, spec]) => [name, spec.effect]));
/** The commands that take a command line after `--`. */
export const COMMAND_REST = new Set(Object.entries(COMMANDS).flatMap(([name, spec]) => (spec.rest === true ? [name] : [])));
/** The table a line is read with, and each command's effect: what `/teamrig` plans a line from (src/slash/plan.ts). */
export const COMMAND_TABLE = { flags: COMMAND_FLAGS, switches: COMMAND_SWITCHES, renamed: RENAMED, rest: COMMAND_REST, effects: COMMAND_EFFECTS };
export const USAGE = `${KIT_NAME} <command> ...   (the caller: --session <id|name>, else $${ENV.session})
  team create <team> --sessions <id,id> [--lead <id>] [--project <dir>] [--parent <team>] [--dry-run]
      writes the team config, ties the project folder to the team (the lead defaults to lead) and
      starts a root team's lead on its first task, setting the team up; --parent hangs it under
      that team's lead in a tree of teams
  team split <team> --lead <id> --sessions <id,id> [--dry-run]
      moves sessions of the lead's team, with the tasks they own, into a new child team under it:
      the child's config and register, their files and renames, the parent's config trimmed; refused
      while a moved session's Claude Code runs or a staying task waits on a moved session's decision
      or approval; --dry-run prints the plan, with what crosses the new border, and writes nothing
  team tree                    the tree of teams this team is in, with each team's lead and sessions
  open <id|name|team/id> [--prompt "<first prompt>"] [--terminal <name>] [--project <dir>] [--resume]
      a new terminal tab running Claude Code as that session (team/id: another team of the tree);
      with no terminal it prints the command; a rehired session reads the handover it left first, or,
      with --resume, goes on in its last Claude Code session when that is small and recent enough;
      a session teamrig close ended goes on in its last one by those limits, else opens fresh
  meet <id|name> [--terminal <name>] [--project <dir>]   the owner meets one session on its cards
      waiting on them: a running one gets an inbox line that wakes it, any other opens fresh in a new
      tab; refused when none waits on the owner now (it names those put off with update --later)
  meet --cards [--session <id|name>]   the session's cards due on the owner, as card facts, and how
      to bring them one at a time and record each answer
  owner note <[team/]T<id>> --text "<what the owner tells its session>"   the owner's Note from the pane:
      kept in the task's history as the owner's and sent to the task's session as an inbox line, which
      wakes it while the task is in progress; refused on a done or dropped task, and where Claude Code
      sets $CLAUDECODE (an agent's tool call, a script it runs, a hook)
  owner next <[team/]T<id>> [--preview]   the owner puts a task next from the pane: pins it above every
      other task on its session's list (moving that session's earlier pin), wakes the session to start
      it once the step in hand is done, and tells the lead; refused on a done, dropped or in-progress
      task, and where Claude Code sets $CLAUDECODE; --preview prints what it would do and writes nothing
  restore                      what a restore would do now with each Claude Code session this machine
      recorded: RESTORE (how it comes back, at which effort), CLOSED (kept, reopened only on ask),
      KEEP or DISCARD, and why; it only reads
  restore run [--since <time>] [--terminal <name>] [--home <dir>] [--tab]   reopens the Claude Code
      sessions the last shutdown killed, after a 60 s countdown (Enter: now, i: all with no prompt,
      a: also the tabs closed outside a shutdown in the last 48 h, q: cancel), else those closed
      ones: a team session through launch, any other resumed as it ran, each at its last effort;
      one mid-turn or with work live at the shutdown, and a lead, get a prompt to carry on; exit 1
      when one did not reopen
  restore check [--terminal <name>] [--home <dir>]   at logon: drops what no restore needs and, when
      the shutdown killed sessions, opens a tab running restore run for them
  restore install [--yes]      has the system run restore check at each logon (Windows: a Run key
      value naming a launcher in the kit home) and adds the Start-menu shortcut "Restore Claude
      Sessions" that runs restore run by hand; without --yes it shows the change and writes nothing
  restore uninstall [--yes]    stops both: removes the logon entry and the shortcut, then the launchers
  rules [--session <id|name>]  the team rules and who the session is, as a session start gives them
  rules scan [--kind <kind>] [--all]   every place a local rule can override a core rule (CLAUDE.md files,
      rules files, skills, memory, rules.md, hook scripts, settings autoMode lines), the kept rules, and the
      lines that touch a core rule for the model to judge, but those cleared before while they and the rules
      they touch are unchanged (--all lists them too); it only reads; over 150 lines, one kind at a time
  rules keep <path>:<line> --rule <n|key> --wins local|teamrig [--reason "<why>"] [--yes]
      (the lead only) keeps a local rule that conflicts with a core rule: local wins as a named exception,
      or teamrig wins and the line stays; without --yes it shows the record and writes nothing
  rules forget <n> [--yes]     (the lead only) drops kept rule n, as rules scan numbers them
  rules clear [--kind <kind>] [--all] --seen <digest> [--except <path>:<line>,...] [--yes]
      (the lead only) records the lines that scan listed, but --except's, as not conflicting, so a rescan
      lists only new or changed ones; --seen is the digest the scan printed; without --yes writes nothing
  skills scorecard [--from <day>] [--to <day>] [--baseline-from <day>] [--baseline-to <day>]   per skill:
      loads, missed uses (a call matching its "Signature: \`<regex>\`" line with no load before it), calls
      and errors per run, against a baseline (default: the last 7 UTC days, and the 7 before); each run
      reads only what the transcripts gained since the last one
  start [--session <id|name>] [--all]   the start of a work block in one call: the team's time, today's
      scheduled meetings it is in (the lead: all), the unread inbox lines (marked read), the session's
      tasks, the other sessions' tasks waiting on it, the check flags it acts on (the lead: all) and the
      week's use; --all: the tasks and flags in full, and every task waiting on it
  meeting start | meeting agenda | meeting end [--session <id|name>]   the lead's daily meeting with
      the owner: start holds messages to the lead until its end (one starting CRITICAL goes; the hook
      tells each sender, so no session is told) and prints the agenda: the stats' Health, flow and
      limit lines over the last 7 days, the owner's decisions as card facts, the late tasks, what
      finished since the last meeting, the branches merged with no approval (under pushToProtected
      gated), the lead's inbox and the week's use and fit; agenda prints it again; end tells each
      session the decisions recorded on its tasks (update --note) by one inbox line, and no other
      session; in a tree of teams only the root team's lead holds it, and its stats, decisions and
      end cover every team under it
  meeting schedule --meets <id|name> --at <time> --about "<one line>" [--minutes <n>] [--with a,b]
      [--tasks T1,T2] [--brief <path>]   books the owner's meeting with one session at a set time, apart
      from the daily one: it prints its id (M3) and tells the session met and those joining by one inbox
      line; the lead or the session met books, moves, ends and drops one
  meeting list [--all] [--json]   the scheduled and started meetings by time, one line each, a scheduled
      one past its slot shown as missed; --all: those done or dropped in the last week too; --json: as
      JSON, for the task pane
  meeting move <id> --at <time> [--note "<why>"]   a new time for a scheduled meeting; those it meets
      are told
  meeting start <id>   the owner starts a scheduled meeting, from any session: the session met gets its
      opening prompt (the topic, tasks, brief and those joining), its running tab brought to the front
      and woken once idle or a closed one opened, and those joining are told by one inbox line
  meeting end <id> [--note "<what came of it>"] | meeting drop <id> --note "<why>"   the meeting was
      held, or will not be (those it meets are told why)
  decisions | decisions asked [--session <id|name>]   the owner's decisions the lead asks in batches:
      decisions prints the waits on the owner not yet asked and the asked ones past due, as card facts,
      and whether a batch is due (a wait due before the next batch, decisions.batchAt not yet asked, or a
      decisions.batchTimesUtc time passed) or when the next is; decisions asked (the lead's) records the
      batch asked, as a meeting start does; in a tree of teams the root lead's batch holds every team's
      waits under it, and a child team's decisions prints its own and its teams' waits, naming that lead
  add --title "<one line>" --description "<what and why>" --priority p<n> [--ref <where it was asked>]
      [--owner <session>] [--source <session>|<owner source>] [--due <date>] [--goals a,b|none]
      [--week <date>] [--after T5,T6] [--size <pct>] [--type task|bug] [--critical] [--class <name>]
      --description: what the task is and why, in plain words for a person (newlines kept, at most 2,000
      characters), needed unless register.requireDescription is off; show prints it under the title
      --after: the tasks to finish before this one starts; its line shows "after T5"
      --size: what the task still costs, in percent of the weekly usage limit (1.5 or 1.5%); plan sums
      the week's sizes against what is left of the limit
      --type: what the item is, a task (the default) or a bug: a fix, incident, failure investigation or
      problem design; --critical marks a bug in a critical area; its line shows "bug" or "critical bug";
      a task with no type whose title or description matches register.review.hintPattern prints a hint
      to mark it, here and when it starts
      --class: the work class, one of focus.classes (Roadmap, Maintenance, Improvements by default); a task
      without one counts as focus.defaultClass
  add --team <team> [--owner <s>] --title .. --description .. --priority p<n> [...]   asks a team of your tree for work
  set <id> --status open|in-progress|verifying|waiting|done|dropped [--note "<what/why>"] [--evidence <proof>]
      [--skill <name>|none] [--followups T<id>,...|none] [--waits decision:<who>,approval:<who>,task:T<id>,time:<date>]
      [--question ".." --options "<a> | <b>" --recommend ".." --default ".." --why-ask ".." --gate ".."]
      [--proof "<what proves it>"] [--watch "<what a sighting shows>"] [--met "<what shows it>"] [--due <date>]
      [--ask <session> --text "<the work>"] [--one-commit]
      [--cause ".." --how ".." --prevent ".." --harden ".." --missed-test ".." --missed-monitor ".." --missed-log ".."]
      verifying needs --proof: what will prove the shipped change works; --due sets the date to verify by
      --watch (with done only, and evidence given or kept): a change tests or a dry run proved, whose live
      proof is a sighting to come; verify lists it until you set it done again without --watch, or reopen it
      a start that a verifying task it needs holds goes through with --met: what shows that task's proof
      exists; its owner gets an inbox line to set it done or reopen it
      the WIP rule (focus.wip) holds a start of work outside the Roadmap and Maintenance classes while its
      owner holds Roadmap work that can move, and any start past focus.wip.maxInProgress tasks in progress;
      --one-commit starts a one-commit fix all the same
      verifying and done need --followups: the tasks the work leaves (a finding, a next step), or none
      (register.requireFollowupsOn); show lists them
      waiting needs --waits: the lead's or the owner's decision or approval, a task to finish first
      (only once started) or a time; check flags it READY once its tasks finished and its time passed
      --ask (with waiting only): adds the work as that session's task and waits on it; --due is then the
      asked task's due date
      verifying needs --waits for when its proof runs: a time, or a task in progress or verifying (the
      owner's approval may stand beside one); set verifying again without --waits keeps them
      a wait on the owner's decision or approval needs a card the owner decides from alone
      (register.requireDecisionCard): --question "<what is decided>" --options "<a, its numbers> | <b>"
      --recommend "<which, and why>" --default "<what happens with no answer>"; each part at least 3 words
      besides task ids; a later set changes one part alone
      a task the owner ordered asks the owner only with --why-ask "<how the order must change, what new it
      needs, or why only the owner can see the result>"; check flags it OWNER-ORDERED without one
      a wait on the owner's decision names what makes it the owner's: --gate "<an owner gate (ownerGates)
      or business>"; any other question is yours or your leader's: decide it, or wait on your leader;
      check flags it UNGATED without one
      a bug gives its review (register.review): --cause "<the root cause, at its source>"
      --how "<the change or assumption that let it in>" --prevent "<what stops it coming back>", and
      --missed-test, --missed-monitor and --missed-log "<a follow-up task that adds it, or why none can catch it>";
      a critical one (--critical, or an owner in criticalOwners) --harden "<past the direct guard>" too;
      each part at least 3 words besides task ids, kept across sets; tasks a missed part names join
      --followups; verifying and done need every part (requireOn; mode refuse, warn or off)
  update <id> [--title ..] [--description ..|none] [--owner ..] [--priority ..] [--ref ..|none]
      [--due <date>|none] [--goals a,b|none] [--week <date>|none] [--after T5,T6|none] [--size <pct>|none]
      [--type task|bug] [--class <name>|none] [--critical|--not-critical] [--pin|--unpin] [--note ..]
      the lead may change owner, priority, due, week, after, size, type, class, critical and pin on any task
      --pin: puts the task above every other task on its owner's list, set by the owner's leaders (the lead
      on its own tasks too); it moves the owner's earlier pin, and handing the task on clears it
      a --note from the task's owner also replaces the note show and the waiting text print
  update <id> --later <date>|none --note ..   puts a card waiting on the owner off to that time, out of the
      meeting's DECISIONS and the batches until then (its owner or a leader above it); none brings it back
  update <id> --decided --note "<owner> decided: .."   records the owner's answer to a card: drops its wait on
      the owner, so it leaves the agenda, and marks it decided (READY) for its owner to act on and set its next
      status (its owner or a leader above it)
  update <team>/<id> --note .. [--later <date>|none|--decided]   the lead at a team tree's root, who asks the
      owner the decisions of the teams under it, notes their tasks, puts a card off or records the owner's answer,
      named as its batch prints them: web/T12
  refs apply <file> [--yes]   points the refs of your team's tasks at notes that moved, from a JSON list of
      {team, id, oldRef, newRef} rows: a dry run names each row's fate, --yes writes each task that still
      reads oldRef as update <id> --ref would; rows of another team, moved, changed since or refused are left
  sweep [--tree] [--session <id>] [--out <file>]   proposes each active task's class, objective and size as
      JSONL rows with confirm empty, writing to no register: rows on stdout and counts on stderr, or with --out
      the rows in that file and the counts on stdout; --session narrows it to that owner's tasks, but with
      --tree, for a team's lead, it names the caller
  sweep apply <file> [--apply]   writes the class, goal and size of each row whose confirm is yes, as its task's
      owner or a leader over it, a size only when it differs from the row's proposedSize: a dry run names each
      row's fate, --apply writes; never deletes, never parks
  approve <id> --note "<what you checked, or why not>" [--decline]   a leader above the task's owner (the
      lead or a sub-lead), or roles.securityReviewer on a task not its own: answers a task waiting on
      its approval (approval:<lead>); its owner gets an inbox line to push or merge (or to fix the note's
      point and ask again), and check flags the approved task READY
  approve <team>/<id> --note .. [--decline]   the lead of a team's parent team answers a task of that
      team's lead waiting on its approval (approval:app/lead), named as its inbox line prints it: web/T3
  list [--session <owner>] [--status a,b|all] [--source <s>] [--priority p1,p2] [--due-before <date>]
      [--week <date>|none] [--goal <tag>] [--type task,bug] [--tree] [--all]
      short rows within 3,000 characters; --all: every field of every task. A task takes the earlier due
      of a task that needs it ("due 01-12 (from T9)"), and a row names another session's task needing it
  show <id> [--tree]   every field, the history and the inbox lines naming it; --tree: what it needs and
      what needs it, each with owner, status and due, then the next move (who acts first, on which task)
  check [--week <date>] [--tree] [--all]   tasks and skills that break a team rule and context
      text over budget, in a short form within 3,000 characters; --all: every flag in full
  plan [--week <date>] [--tree]    the week plan (default: the newest week that has started)
      --tree (the lead only): also every team under it, read-only, ids as <team>/T<n>
  verify [--session <id|name>]   the session's verifying tasks, oldest first, each with its proof and
      the date to verify by, then its done tasks still watched for a sighting (--watch)
  stats [--range 7d|30d|90d|180d|1y|all] [--session <id|name>] [--tree]   the register's numbers
      over the team's last days (default 7d): the Health tiles with their levels, then flow, new work,
      speed, delays, waits, bugs and people; --session: one session's tasks; --tree (the lead only):
      every team under it
  report done [--day <YYYY-MM-DD>] [--session <id|name>] [--all]   one day of the team's done work
      (default yesterday) in groups: owner asked, each goal, urgent p1, this week's plan, each row shown;
      other work and dropped as one line, or their rows with --all; --session: one owner's tasks
  goal add <tag> --title "<title>" --target <YYYY-MM-DD> [--start <YYYY-MM-DD>] [--parent <tag>]
      the lead adds one of the team's goals: a tag (A1, A2.1), a title and its planned window from
      --start (default today) to --target; --parent: the goal it is part of (a key result, refused past
      focus.maxActiveKeyResults ones with a target of today or later)
  goal set <tag> [--target <YYYY-MM-DD>] [--title "<title>"] --note "<why>"   the lead moves a goal's
      target (a slip, kept with its note) or renames it
  goal rank <tag> <n>|none   the lead ranks a goal, 1 first, or takes it off the ranking; goal-first
      ranking gives a task the best rank of its goals and the goals they are part of
  goal list   the team's goals, the ranked ones first, then the rest as a tree, each with its window,
      slips, rank and title
  goal show <tag>   one goal: its window, rank, who added it and when, its parts, and each slip with its
      note
  files <id> | files --notes [--session <id|name>]   prints the folder for a task's files (design.md,
      build.md, plan.md, review.md, evidence/, scripts/, out/) in the team that holds it, or for your notes
      that belong to no task; makes it when missing
  inbox read [--session <area>]     prints the unread lines and marks them read
  inbox status [--session <area>]   unread lines per area
  inbox add --to <id|name|team/id|all|leads|group:<leader>|team:<team>|tree:leads|task:T<n>>[,...] --text "<one line>" [--wake now | --wake-by <time>]
      team/id: any session of another team of your tree; all, leads (the
      lead and the sub-leads) and group:<leader> (it and every session under it) are your own team's;
      team:<team> is every session of a team of your tree and tree:leads every team's lead in it;
      task:T<n> is that task's owner and the owner of each active task of your tree whose ref is T<n>; a
      group leaves you out; a comma-separated list posts the line to each receiver once
      --wake now: also wakes each receiver idle at its prompt within about 3 minutes and says what
      that costs; a group only from a leader, another team only from the lead of a team above it
      --wake-by <time>: wakes each receiver at that time instead, only if it has not seen the line by
      then and its tab is idle; the same gate
  exec request --file <request.json>   asks to run a privileged command: the JSON names the command, its
      code binding, variables, dry run or preview, purpose, expected effect and rollback; logged as R<n>
  exec dry-run R<n>    runs the request's read-only dry run, logged for the reviewer
  exec status [R<n>] [--team <child>]   each request's stage; with R<n>, the whole request as the reviewer reads it
  exec approve R<n> [--note "<why>"] [--team <child>]   the security reviewer (roles.securityReviewer) or the
      owner approves one run; an owner-gated request only the owner
  exec refuse R<n> --note "<why>" [--team <child>]     refuses the request; the note names the safe alternative
  exec escalate R<n> --note "<why>" [--team <child>]   the security reviewer hands an owner-gated request to the owner
      --team <child>: a request of a team below yours, whose roles.securityReviewer names you as <team>/<id>
  exec run R<n>        runs an approved request once, before its approval expires
  who [<id|name|role|team/id>] the name to message a session by (no argument: every session of yours)
  sessions [--pass] [--project <dir>]   each session: running (and the MB its Claude Code's processes
      hold), closed or never recorded; then the host's free memory and commit charge. --pass: what an
      idle pass would close and reopen (one reopen a pass, with room on the host) and why it keeps or
      leaves each other session; it changes nothing
  close <id|name> [--project <dir>] [--yes]   (the lead) ends an idle session's Claude Code and its tab
      to free the host, logged, so teamrig open resumes it; it refuses the lead, the delivery owner,
      a session with work it can start or a time wait ending within 30 min, quiet under
      open.headroom.closeIdleMinutes, in a turn, at a tool call or waiting on a decision it put to the
      person, running background work or shells, or too big or old to resume; without --yes it shows
      the close and ends nothing
  rename <id|name> <new-name>  records a session's new name; its old names keep finding it
      (the session itself or the lead)
  hire <id> --scope "<its job>" --reason "<why>" [--name <name>] [--model <model>] [--effort <level>]
      [--review <YYYY-MM-DD>] [--approved-by "<who>"] [--burst] [--yes]
      (a lead: the lead, or a sub-lead into its own group) adds a worker the leader is sure the team needs,
      or hires a retired one back, within hiring.policy, on the lead's model and effort unless given;
      without --yes it shows the hire and writes nothing;
      with no room on the host for one more session it is hired home, left closed until there is room;
      --burst: a hire for the burst in force, within its hires, never a cheaper model or lower effort, due to
      retire when the burst is over (under hiring.policy owner the burst's approver approves it);
      on a hired session already on the team, --review <YYYY-MM-DD> --reason "<why>" keeps it to that new
      review day instead (a lead over it), which clears its REVIEW-DUE
  retire <id|name> [--to <heir>] [--no-handover "<why>"] [--reason "<why>"] [--yes]
      (a lead over it: the lead, or its sub-lead; never the session itself) takes a session the team no longer
      needs off the team; its open tasks go to --to, and it needs its handover unless --no-handover; its
      tasks and inbox stay readable; without --yes it shows the retire and writes nothing
  promote <id|name> --members <a,b> [--yes]
      (the lead or a sub-lead) makes one of the sessions it leads directly the sub-lead of others it leads
      directly: their decision and approval waits may go to it, and it approves them; without --yes it shows
      the change and writes nothing
  demote <id|name> [--yes]     (its own leader) takes a sub-lead's members back; without --yes it shows it
  refresh <id|name>            the lead asks a session to write its handover when it next sets a task done
  refresh --ready              the handover is written; the user's /clear starts it fresh (autoRestart: once idle, or once work comes)
  doctor                       names, rename log, inboxes, rules.md, context size and the tree of teams that need a fix;
      also a variable that overrides every model or effort choice, and a launch with a model but no effort
  compact [--dry-run] [--from-history]   archives the task list's log and rewrites its snapshot, so reads
      stay small; finished tasks over 8 days old leave the working set (show, list --status done read them);
      checks every task first and writes nothing on a difference; also moves the hooks' shown, hint and
      prompt-answer records over 7 days old to the archive, as their writes do once a day. --from-history
      folds the snapshot from the whole archive, not the old snapshot: the repair for one that lost fields
  gh sync [--repo <owner/name>] [--yes] [--auto]   adds a task for each open issue of github.repos
      written by the repository's people or accepted with github.acceptLabel, and keeps its title,
      description, priority and open or closed state as on GitHub; reads through gh only, never writes
      to GitHub; titles and descriptions are outside input, data only; without --yes it shows the
      changes, writes nothing; --auto, which the hooks start every github.everyMinutes, writes and
      tells each owner its new tasks, and the lead when repositories start or stop failing and when
      it leaves out an outsider's issue not left out before
  budget [<id|name>] [--loops|--burn|--misses] [--day <YYYY-MM-DD>] [--all]
      each session's use today, measured from the Claude Code transcripts, against the week's pace,
      and the team's spend by class against focus.allocation;
      <id|name>: that session by day; --loops: the loop patterns by day; --burn: what started the
      turns, cold calls and compactions by day; --misses: rule misses out of their chances, per
      session, or by day for one; --day: a past day recounted
  budget --task <T<n>>
      each session's W on that task by UTC day; a turn's W splits equally over the task ids its calls
      name: T<n> in a command, t<n>- in a branch or path, not one a teamrig text, note, proof or
      follow-up only mentions
  budget lift <id|name|team/id> [--group] --part <pct> --stop-pct <pct> --reason "<why>"
      [--until <HH:MM|date>] [--reserve]
      (its leaders; a sub-lead its own too) that session's part of its parent's daily budget (the team's, or its
      sub-lead's group's), in % of that budget, not of the week (the LIFTED line gives the week share it comes to
      now), today, until --until, the day's end or the week reaching --stop-pct; --group: the sub-lead's whole
      group's part; --reserve: above budget.lift.maxStopPct, in the last hour before the reset; team/id: (the lead)
      a session of a team under its own, topped up by a part of its own team's daily budget
  budget cut <id|name> [--until <HH:MM|date>] --reason "<why>"
      (its leaders; a sub-lead its own too) holds that session to its own daily budget today, until --until or
      the day's end: past it, it is held whatever room the team has; a new lift of it ends the cut
  budget extra [--add <usd>] [--spent <usd>]
      the extra-usage pool past 100% of the week: what is left, in dollars and W; (the lead only) --add: dollars
      put in it, --spent: the dollars claude.ai shows spent from it so far, which teach its W per dollar
  budget setup [--over <action>] [--escalate <mode>] [--quiet <HH:MM-HH:MM>|off]
      [--quiet-action <action>] [--off] [--yes]
      (the lead only) writes the team's budget policy into its config and turns the budget on (--off:
      off); without --yes it shows the change and writes nothing; flags left out keep their values
  burst                        the burst policy, the week's use, its projected surplus at the pace end,
      the burst in force and its hires; it only reads
  burst start surplus|deadline --reason "<why>" [--sessions <ids>] [--helpers <n>] [--hires <n>]
      [--stop-pct <pct>] [--by <HH:MM|date>] [--task <ids>] [--approved-by "<who>"] [--yes]
      (the lead only, under burst.policy owner with the owner's approval) a time-boxed scale-out: each
      session in it gets at least its share of what is left to --stop-pct (at most budget.targetPct) a day
      and runs up to --helpers at once; surplus: the whole team, from burst.surplusHours before the reset
      until the pace end, once the team's part of the week projected unused is burst.minSparePct or more;
      deadline: --task by --by, the tasks' owners unless --sessions, needs --stop-pct; without --yes it
      shows the burst and writes nothing
  burst end --reason "<why>"   (the lead only) ends the burst in force early; its hires are due to retire
  statusline [--pass]          Claude Code's status line (status JSON on stdin): saves the week's use
      for budget and prints the model and its effort, folder, branch, and week's use beside its
      pace line (config statusLine turns parts off); --pass: prints the status JSON again
      instead, for the status line after it in a pipe
  statusline install [--yes]   makes teamrig statusline Claude Code's status line, in front of the one
      already there; without --yes it shows the change and writes nothing
  statusline uninstall [--yes] takes it back out: the status line before it returns
  automode install [--yes]     writes the team's lines (protected branches, the register commands, queue and
      test, who removes a worktree, rebasing one's own branch) into Claude Code's autoMode.environment, the
      facts auto mode trusts; run it again after a config change or an upgrade; without --yes it shows the
      change and writes nothing
  automode uninstall [--yes]   takes the team's lines back out, leaving every other line
  permissions trim [--all] [--yes]   removes the local allow rules off the config's permissions.keepAllow
      that approve a whole tool or program or hold a credential (--all: every rule) from the team's
      Claude Code settings, its worktrees' too; it counts them by class, never printing a rule; without
      --yes it writes nothing
  setup backup [--project <dir>]   copies your Claude Code setup byte for byte (CLAUDE.md files, settings,
      rules, skills, agents, commands, output styles, the project's memory, the team's own skills folder)
      with a manifest of each file's sha256 into a new folder under your state folder; it counts files,
      never printing one
  setup restore [<stamp>] [--yes] [--remove-new]   lists the backups, or previews putting one back:
      changed and deleted files and files made since; --yes backs the setup up first, then writes and
      prints the restore that undoes it; --remove-new also removes the files made since
  setup scan [--project <dir>] [--days <n>] [--max-mb <n>]   what the Claude Code setup costs every turn
      in the project (default: the team's, else the working folder) and what to slim: each file and the
      skill and agent type listings a session loads, with chars and tokens; files over 6,000 chars, skill
      descriptions over 250, repeated lines, rule lines that may override a core rule, wide allow rules,
      no deny rule, bypassed prompts, hooks writing into the context, skills and agent types unused in
      --days (default 30) days of this machine's transcripts, read newest first up to --max-mb (default
      1024) MB (one changed within them is not judged), and by Claude Code's /skill-doctor, which also
      counts plugins' skills, and the user's ones used only in other projects; it names the newest setup
      backup, or NO BACKUP; works before a team exists; it only reads
  config validate | config migrate [--yes]   migrate shows an older config rewritten in this format and
      the first teamrig that reads it, as a tab on an older one refuses every write after; --yes writes it
  commits check --base <ref> [--tip <ref>]   commits in base..tip (default HEAD) over the size rule
      with no reason line; any is REFUSED, for a merge script or CI
  secrets staged | secrets message <file> | secrets pushed <remote>   for git's pre-commit, commit-msg and
      pre-push hooks: a secret the staged change, the message or the pushed commits and tags add is REFUSED,
      named by place and shape, never by value; default shapes and paths outside a team, plus the team's own
      inside one
  worktree add <branch> [--repo <name>]   makes a session's new worktree the same way every time: fetches
      the default branch origin/HEAD names, adds the worktree on the new branch from it, in a folder
      named after the branch (each / as -) in delivery.repos.<name>.worktreeFolder (default
      .claude/worktrees in the main checkout), then runs its worktreeSetup there, without a shell and
      with the main checkout's folder in TEAMRIG_MAIN_CHECKOUT; the repository is --repo's, else the
      one it runs in; REFUSED before any change for a branch or folder already there; FAILED when its
      setup fails, the worktree kept
  worktree remove <path> [--delete-branch [--base <ref>]] [--dry-run] [--session <id|name>]   removes a linked git worktree:
      unlinks each link in it (such as a node_modules junction) and sees it gone, so git cannot follow
      one and empty its target, then runs git worktree remove; REFUSED before any change for the main
      checkout, a dirty tree or a real node_modules folder, and in a team for another session's worktree:
      a session removes its own (its t<id>- branch names a task it owns) and those of the sessions it
      leads, the lead any, and any session one on a detached HEAD whose every commit is on the branch
      origin/HEAD names, as teamrig merge leaves it. --delete-branch: deletes its branch too, once every
      commit of it is on --base (default the branch origin/HEAD names); --dry-run: prints the steps
  queue --what <label> [--session <id|name>] [--max-minutes <n>] [--small] [--pre-push] -- <command ...>   runs one queued step
      (a build, a test run, a database script) under the host lock, so the host runs one at a time, and at
      below-normal CPU priority (nice 10 on POSIX), which every process it starts inherits, so your
      terminal and apps win the CPU: waits in line for the lock, kills the step and every process it started after
      delivery.queue.maxRunMinutes (--max-minutes) and records its start and end in the delivery
      ledger; once the shell that started it ends, it stops waiting for the lock or kills the step (exit
      129); REFUSED from delivery.schedule.queueCutoffUtc to midnight UTC and once its line has not
      moved for delivery.queue.waitMinutes; exit 0 when the command passed, 1 when it failed or was killed. Its
      processes get $TEAMRIG_HOST_LOCK: a queued step started under a live lock (a git hook's checks
      under queue, merge or deploy) runs at once under it. No --session: $TEAMRIG_SESSION, the
      parent step's session, else the session this Claude Code tab is bound to. --small (a spec run, a
      lint): shares the host with other small steps while it keeps delivery.queue.memoryFloorMb free
      besides the MB held for them (its ledger peak and a quarter, else delivery.queue.smallReserveMb)
      and is killed after delivery.queue.smallMaxRunMinutes (--max-minutes up to it); a step without
      --small waits for them to end, and a step waiting behind it is told which. --pre-push (a git
      pre-push hook's checks): on a clean tree
      it reuses their pass of the last 24 hours (DONE at once, even from the cutoff on) and records one
      when they pass; when they waited over a minute for the lock it declines the push (REFUSED), whose
      connection may have closed meanwhile: push again, it reuses the pass
  withdraw (--what <text> | --all) [--session <id|name>]   takes this session's steps waiting for the
      host lock (queue, merge, deploy) out of its line, so a re-ordered or abandoned step leaves it:
      --what picks those whose purpose holds the text. Each stops at its next look and runs nothing;
      RUNNING when it took its turn first, LEFT when it left the line first, KEPT when an older
      teamrig queued it (its step runs anyway). With neither flag: lists them, REFUSED. No --session:
      $TEAMRIG_SESSION, else the session this Claude Code tab is bound to; REFUSED for another
      session's steps from a bound tab. Exit 0 each withdrawn or none waits, 1 any RUNNING, LEFT, KEPT
  merge [--session <id|name>] [--keep-remote] [--no-delete-local]   merges the branch checked out
      here into origin's default branch: REFUSED for a detached HEAD, the default branch, uncommitted
      changes, nothing new, a dependency change delivery.repos.<name>.dependencyGate holds and
      no dependencyCheck may clear or, where decisionRecordGate is on, a branch whose t<n> task has a
      design note and that adds no decision record to docsFolder/decisions/, from
      delivery.schedule.queueCutoffUtc to midnight UTC and in the
      resetBlackoutHours before the weekly token reset; waits up to delivery.wait.maxMinutes for
      deploy freezes on its deploysOnPush targets and for the host lock (longer while its line moves), rebases, runs the
      dependencyCheck on a dependency change (REFUSED unless it exits 0), where reviewGate holds a
      change of a review path until its reviewer approves the branch's t<n> task (REFUSED with the
      set command that asks; reviewCheck clears a check path), under pushGuard.pushToProtected gated
      checks the self-merge gates (a live task of its own, a pass record of the rebased tree, commit
      sizes, a test changed with source, reviewGate on: REFUSED on a miss, held for the session's leader
      with the set command that asks, except a task miss; each merge is a line in merges.jsonl)
      and pushes (each a queued step
      in the ledger; again when origin moved meanwhile), or, where delivery.repos.<name>.merge is
      set, runs its command in place of the push (0 merged, once origin holds it; 75 WAITING, say on a
      pull request's checks: run merge again once it merged), records the merge as a deploy of deploysOnPush, deletes the branch on origin
      and here (--keep-remote, --no-delete-local keep them) and, where updateMainCheckout, fast-forwards
      the main checkout; once the shell that started it ends, it stops waiting, or kills the push
      and frees the lock (exit 129); exit 0 merged, 1 failed or stopped, 2 refused, 75 the merge waits
  deploy [--repo <name>] [--session <id|name>]   brings what was pushed to a repository's default
      branch to the running system: pulls its main checkout fast-forward to origin, runs its
      delivery.repos.<name>.deploy dependencyInstall for a dependency change (after its
      dependencyCheck), its afterPull hooks and command (one queued step in the ledger) and records
      the deploy; --repo defaults to the repository of this folder, else the only one with a deploy
      block. REFUSED for a main checkout off its default branch, dirty or ahead of origin, a
      dependency change dependencyGate holds or a check that refuses, from
      delivery.schedule.queueCutoffUtc to midnight UTC and in the resetBlackoutHours before the
      weekly token reset; waits up to delivery.wait.maxMinutes for deploy freezes on its targets,
      its checks and the host lock (longer while its line moves); nothing pending is DONE with nothing run. A failed dependency
      check or install moves the main checkout back; a failed afterPull hook or deploy command leaves
      nothing pending, so its deploy command is then run by hand; once the shell that started it ends,
      it stops waiting, or kills its hook and frees the lock (exit 129); exit 0 deployed, 1 failed or stopped
  deploy --targets <a,b> --what "<why>" [--repo <name>] [--session <id|name>] -- <command ...>   a
      deploy that pulls nothing, such as a restart onto a rotated secret: runs the command in this folder
      (one queued step in the ledger) and records a deploy of those targets only. REFUSED for a target not
      in the repository's deploy.targets, when a check refuses, from delivery.schedule.queueCutoffUtc
      to midnight UTC and in the resetBlackoutHours before the weekly token reset; waits as a deploy
      does, for deploy freezes on those targets only; its checks and command see TEAMRIG_VERB=redeploy and
      TEAMRIG_DEPLOY_TARGETS; exit 0 deployed, 1 failed or stopped
  freeze --targets <a,b> --metric <m> --why "<why>" --for <span> [--session <id|name>]   a deploy
      freeze: merge and deploy wait while it holds a target they deploy, from now for the span (45m,
      1h30m; at most delivery.freezes.maxMinutes); one per session; REFUSED for a target no
      repository deploys or a secret in the metric or reason
  unfreeze [--session <id|name>]   ends this session's deploy freeze before its time
  stable-periods --targets <a,b> --since <time> [--until <time>] [--settle <span>] [--min <span>]   the
      stable periods of each target from --since to --until (default now): the stretches no deploy of it
      touched (one of its repository, or a deploy --targets naming it; from its start until
      delivery.stablePeriods settle minutes after it deployed; --settle for every target) and no queued
      step, each at least --min (default delivery.stablePeriods.minMinutes) long, each with the declared
      jobs it overlaps. A time is HH:MM (today), YYYY-MM-DD HH:MM or YYYY-MM-DD on the team's clock unless
      marked UTC, or an ISO time with its zone
  job --what "<what>" [--targets <a,b>|host] [--at <time>] [--session <id|name>]   declares a
      background job (a long data script, a backfill) on its targets (default the whole host) in the
      ledger from --at (default now), so stable-periods names it; REFUSED for a start in the future, a
      target no repository deploys or a secret in what it is
  job end --id <id> [--at <time>] [--session <id|name>]   ends this session's job at --at (default
      now); REFUSED for no such open job, another session's, or an end in the future or before its start
  deploy-status                the deploy state now: the host lock's holder, the queue cutoff and the
      reset blackout, the deploy freezes and jobs still open, and what each repository with a deploy block
      has pushed but not deployed (it fetches each main checkout)
  test [--session <id|name>] -- <command ...>   runs a test command in the shell, writes all it printed
      to a log (each session keeps its newest 20) and prints one PASS or FAIL line, then each failing
      test within tests.maxFailureChars; exit 0 when the command passed, 1 otherwise
  hook push-guard | hook package-guard | hook secret-guard | hook exec-guard | hook pass-record-guard | hook cold-send | hook failed-send | hook missing-cli | hook route-reminder | hook loop-nudge | hook secret-redact | hook helper-gate | hook inbox-reminder | hook session-start | hook stop | hook subagent-start | hook subagent-stop | hook refresh-wake | hook restore-track | hook tab-status | hook tool-end | hook readonly-allow | hook picker-guard | hook prompt-refuse | hook route-allow
      (run by Claude Code, hook JSON on stdin)
  hook clear-dir | hook clear-claim [--hold [--why <reason>]]
      (run by the plugin's mod: the automatic restart's /clear in the tab)
  hook wake-check | hook wake-dropped
      (run by the plugin's mod: wakes an idle tab when unblocked urgent work is handed to its session)
  hook meeting-due
      (run by the plugin's mod: the OS notification at a scheduled meeting's time)
  hook refresh-mid | hook compact-check
      (run by the plugin's mod: asks for the handover within a long turn, and holds a compaction while it is due)
  hook slash-command
      (run by the plugin's mod: /teamrig <command> typed in a Claude Code tab; /teamrig alone tells what it runs)
  launch <id> --team <team> --project <dir> [--home <dir>] [--encoded-prompt <text> | --no-prompt] [--resume <session>] [--effort <level>]
      (run by the tab that open starts: sets the session and starts Claude Code)
  restore resume <claude-session> --project <dir> [--home <dir>] [--effort <level>] [--encoded-prompt <text>]
      (run by the tab restore run starts for a session outside any team: resumes it in Claude Code)
  restart <id> --team <team> --at <time> --project <dir>
      (run hidden by the Stop hook: starts the session fresh once its handover is written and it is idle)
  idle-close <id> --team <team> --project <dir>
      (run hidden by the idle pass: closes a session it found idle, once weighed again)
  idle-open <id> --team <team> --project <dir>
      (run hidden by the idle pass: reopens a session it closed that work would wake, once judged again)
Team: $${ENV.team}, else the nearest ${TEAM_POINTER} ({"team": "<id>"}) above the current folder,
else above $CLAUDE_PROJECT_DIR.
Sessions: give an id, a current name or a former one; a session never named is <team>-<id>.
Times: YYYY-MM-DD (a day), "YYYY-MM-DD HH:MM" or HH:MM (today), on the team's clock (timeZone, else the
machine's) unless marked UTC; printed zone-marked (01-08 14:00 IST). Kit home: $${ENV.home}, else ~/.${KIT_NAME}.
Exit: 0 done, 1 failed, 2 refused by a team rule, 3 open printed the command to run itself,
4 /teamrig printed a line to agree to before it runs, 64 a command line it cannot read.
One command's help: ${KIT_NAME} <command> --help.`;
/** Each command's own lines of USAGE, for `<command> --help` and a usage error. */
export const COMMAND_HELP = new CommandHelp(USAGE, Object.keys(COMMANDS));
/** The words that print the usage; the LLM guide documents them as `teamrig help`. */
export const HELP = new Set(['help', '--help', '-h']);
/** The words that print the version; the LLM guide documents them as `teamrig version`. */
export const VERSION = new Set(['version', '--version', '-v']);
export async function runCli(given, runtime) {
    const argv = shimArgs(given, runtime.cmdShimLine);
    if (argv === undefined) {
        runtime.out.stderr(cutLineMessage(runtime.self.script));
        return EXIT.usage;
    }
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
        const args = parseArgs(argv, COMMAND_FLAGS, COMMAND_SWITCHES, RENAMED, COMMAND_REST);
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
