import { planBudgetSetup } from "../../budget/setup.js";
import { readSnapshots } from "../../budget/snapshot.js";
import { DEFAULT_BUDGET } from "../../config/defaults.js";
import { formatConfig, writeConfigWithBackup } from "../../config/load.js";
import { parseConfigText } from "../../config/text.js";
import { ESCALATIONS, isEscalation, isOverAction, OVER_ACTIONS } from "../../config/types.js";
import { isRecord } from "../../core/guards.js";
import { noPositionals, UsageError } from "../args.js";
import { callerOf } from "../inputs.js";
import { issueText, openTeamKit, requireConfig, rosterOf, sessionIdOf } from "../kit.js";
import { EXIT, RefusedError } from "../runtime.js";
import { pctFlag, snapshotDirOf } from "./budget.js";
/**
 * `budget setup`: the lead writes the team's budget policy into the team config. Without --yes it only
 * shows what would change; with it, the old file is kept in the backups folder first. Flags left out
 * keep the config's values, so a second run changes one thing at a time.
 */
/** The backup name of a config before `budget setup` changed it. */
export const BUDGET_BACKUP_NAME = 'config.budget';
const QUIET_WINDOW = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/;
/** A percent flag that also takes one word: `--daily pace`, `--max-daily none`. */
function pctOrWord(flags, name, word) {
    return flags.get(name)?.trim() === word ? word : pctFlag(flags, name);
}
function overActionFlag(flags, name) {
    const text = flags.get(name);
    if (text !== undefined && !isOverAction(text)) {
        throw new UsageError(`--${name} "${text}" is not one of ${OVER_ACTIONS.join(', ')}`);
    }
    return text;
}
function escalateFlag(flags) {
    const text = flags.get('escalate');
    if (text !== undefined && !isEscalation(text)) {
        throw new UsageError(`--escalate "${text}" is not one of ${ESCALATIONS.join(', ')}`);
    }
    return text;
}
/** `--quiet HH:MM-HH:MM` (UTC) or `--quiet off`; the config parser checks the times. */
function quietFlag(flags) {
    const text = flags.get('quiet')?.trim();
    if (text === undefined || text === 'off') {
        return text;
    }
    const window = QUIET_WINDOW.exec(text);
    if (window === null) {
        throw new UsageError(`--quiet "${text}" is not HH:MM-HH:MM (UTC) or off`);
    }
    return { startUtc: window[1] ?? '', endUtc: window[2] ?? '' };
}
function choicesOf(args) {
    return {
        enabled: !args.switches.has('off'),
        daily: pctOrWord(args.flags, 'daily', 'pace'),
        maxDaily: pctOrWord(args.flags, 'max-daily', 'none'),
        overAction: overActionFlag(args.flags, 'over'),
        escalate: escalateFlag(args.flags),
        quiet: quietFlag(args.flags),
        quietAction: overActionFlag(args.flags, 'quiet-action'),
    };
}
/** A policy value in words; an unset key names what applies instead. */
function valueText(key, value) {
    if (value === undefined) {
        switch (key) {
            case 'enabled':
                return 'off (not set)';
            case 'dailyPct':
                return 'pace (not set)';
            case 'maxDailyPct':
                return 'no cap (not set)';
            case 'quietHours':
                return 'none (not set)';
            case 'overAction':
                return `${DEFAULT_BUDGET.overAction} (not set)`;
            case 'escalate':
                return `${DEFAULT_BUDGET.escalate} (not set)`;
        }
    }
    if (typeof value === 'boolean') {
        return value ? 'on' : 'off';
    }
    if (typeof value === 'number') {
        return `${value}%`;
    }
    if (isRecord(value)) {
        return `${String(value['startUtc'])}-${String(value['endUtc'])} UTC, ${String(value['action'])}`;
    }
    return String(value);
}
function keyLine(key) {
    const from = valueText(key.key, key.from);
    return key.changed ? `  CHANGE budget.${key.key}: ${from} -> ${valueText(key.key, key.to)}` : `  KEEP budget.${key.key}: ${from}`;
}
/** The config file's own JSON, not the copy migrated in memory, so nothing else in it changes, its version included. */
async function fileJson(runtime, path) {
    const text = await runtime.files.read(path);
    let raw;
    try {
        raw = text === undefined ? undefined : JSON.parse(text);
    }
    catch {
        raw = undefined;
    }
    if (!isRecord(raw)) {
        throw new RefusedError(`${path} changed while it was read; run the command again`);
    }
    return raw;
}
/** `budget setup [--daily ...] [--max-daily ...] [--over ...] [--escalate ...] [--quiet ...] [--quiet-action ...] [--off] [--yes]`. */
export async function setup(args, runtime) {
    noPositionals(args);
    const caller = callerOf(args.flags, runtime.env);
    const choices = choicesOf(args);
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'write');
    const { load } = kit;
    const roster = await rosterOf(runtime, kit, config);
    const lead = roster.holderOf('lead');
    if (sessionIdOf(roster, caller) !== lead) {
        throw new RefusedError(`only the lead${lead === undefined ? '' : ` (${roster.nameOf(lead) ?? lead})`} sets the team's budget`);
    }
    const plan = planBudgetSetup(await fileJson(runtime, load.path), choices);
    if (!plan.ok) {
        throw new UsageError(plan.problem);
    }
    const next = parseConfigText(formatConfig(plan.value.config));
    if (next.status !== 'loaded') {
        throw new RefusedError(`the new config cannot be read: ${issueText(next.issue)}`);
    }
    const [problem] = next.issues;
    if (problem !== undefined) {
        throw new RefusedError(`nothing written: ${issueText(problem)}`);
    }
    const { keys } = plan.value;
    const changed = keys.filter((key) => key.changed).length;
    const counts = `${changed} to change, ${keys.length - changed} unchanged`;
    if (!args.switches.has('yes')) {
        runtime.out.stdout(`PREVIEW ${load.path}: ${counts}; nothing written (add --yes to write)`);
    }
    else if (changed === 0) {
        runtime.out.stdout(`UNCHANGED ${load.path}: the budget already reads this way`);
    }
    else {
        const backup = await writeConfigWithBackup(runtime.files, { configPath: load.path, backupsDir: kit.paths.backups, backupName: BUDGET_BACKUP_NAME }, plan.value.config, runtime.clock);
        runtime.out.stdout(`WROTE ${load.path}: ${counts}; the old file is at ${backup}`);
    }
    keys.forEach((key) => runtime.out.stdout(keyLine(key)));
    const budget = next.config.budget;
    if (budget.enabled && budget.weeklyLimitW === undefined && (await readSnapshots(runtime.files, snapshotDirOf(budget, kit.paths))).length === 0) {
        runtime.out.stdout("NOTE no status line reading yet, so the budget stays silent: make `teamrig statusline` Claude Code's status line, or set budget.weeklyLimitW");
    }
    return EXIT.ok;
}
