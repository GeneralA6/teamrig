import { planBudgetSetup, type BudgetChoices, type KeyChange, type QuietWindow } from '../../budget/setup.ts';
import { readSnapshots, snapshotDirOf } from '../../budget/snapshot.ts';
import { DEFAULT_BUDGET } from '../../config/defaults.ts';
import { writeConfigWithBackup } from '../../config/load.ts';
import { ESCALATIONS, isEscalation, isOverAction, OVER_ACTIONS, type Escalation, type OverAction } from '../../config/types.ts';
import { isRecord } from '../../core/guards.ts';
import { noPositionals, UsageError, type Flags, type ParsedArgs } from '../args.ts';
import { callerOf } from '../inputs.ts';
import { checkedNextConfig, configFileJson, leadOnly, openTeamKit, requireConfig, rosterOf } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';

/**
 * `budget setup`: the lead writes the team's budget policy into the team config. Without --yes it only
 * shows what would change; with it, the old file is kept in the backups folder first. Flags left out
 * keep the config's values, so a second run changes one thing at a time.
 */

/** The backup name of a config before `budget setup` changed it. */
export const BUDGET_BACKUP_NAME = 'config.budget';

const QUIET_WINDOW = /^(\d{2}:\d{2})-(\d{2}:\d{2})$/;

function overActionFlag(flags: Flags, name: string): OverAction | undefined {
  const text = flags.get(name);
  if (text !== undefined && !isOverAction(text)) {
    throw new UsageError(`--${name} "${text}" is not one of ${OVER_ACTIONS.join(', ')}`);
  }
  return text;
}

function escalateFlag(flags: Flags): Escalation | undefined {
  const text = flags.get('escalate');
  if (text !== undefined && !isEscalation(text)) {
    throw new UsageError(`--escalate "${text}" is not one of ${ESCALATIONS.join(', ')}`);
  }
  return text;
}

/** `--quiet HH:MM-HH:MM` (UTC) or `--quiet off`; the config parser checks the times. */
function quietFlag(flags: Flags): QuietWindow | 'off' | undefined {
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

function choicesOf(args: ParsedArgs): BudgetChoices {
  return {
    enabled: !args.switches.has('off'),
    overAction: overActionFlag(args.flags, 'over'),
    escalate: escalateFlag(args.flags),
    quiet: quietFlag(args.flags),
    quietAction: overActionFlag(args.flags, 'quiet-action'),
  };
}

/** A policy value in words; an unset key names what applies instead. */
function valueText(key: KeyChange['key'], value: unknown): string {
  if (value === undefined) {
    switch (key) {
      case 'enabled':
        return 'off (not set)';
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
  if (isRecord(value)) {
    return `${String(value['startUtc'])}-${String(value['endUtc'])} UTC, ${String(value['action'])}`;
  }
  return String(value);
}

function keyLine(key: KeyChange): string {
  const from = valueText(key.key, key.from);
  return key.changed ? `  CHANGE budget.${key.key}: ${from} -> ${valueText(key.key, key.to)}` : `  KEEP budget.${key.key}: ${from}`;
}

/** `budget setup [--over ...] [--escalate ...] [--quiet ...] [--quiet-action ...] [--off] [--yes]`. */
export async function setup(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const caller = callerOf(args.flags, runtime.env);
  const choices = choicesOf(args);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'write');
  const { load } = kit;
  const roster = await rosterOf(runtime, kit, config);
  leadOnly(roster, caller, "sets the team's budget");
  const plan = planBudgetSetup(await configFileJson(runtime, load.path), choices);
  if (!plan.ok) {
    throw new UsageError(plan.problem);
  }
  const next = checkedNextConfig(plan.value.config);
  const { keys } = plan.value;
  const changed = keys.filter((key) => key.changed).length;
  const counts = `${changed} to change, ${keys.length - changed} unchanged`;
  if (!args.switches.has('yes')) {
    runtime.out.stdout(`PREVIEW ${load.path}: ${counts}; nothing written (add --yes to write)`);
  } else if (changed === 0) {
    runtime.out.stdout(`UNCHANGED ${load.path}: the budget already reads this way`);
  } else {
    const backup = await writeConfigWithBackup(
      runtime.files,
      { configPath: load.path, backupsDir: kit.paths.backups, backupName: BUDGET_BACKUP_NAME },
      plan.value.config,
      runtime.clock,
    );
    runtime.out.stdout(`WROTE ${load.path}: ${counts}; the old file is at ${backup}`);
  }
  keys.forEach((key) => runtime.out.stdout(keyLine(key)));
  const budget = next.budget;
  if (budget.enabled && budget.weeklyLimitW === undefined && (await readSnapshots(runtime.files, snapshotDirOf(budget, kit.paths))).length === 0) {
    runtime.out.stdout(
      "NOTE no status line reading yet, so the budget stays silent: run `teamrig statusline install`, or set budget.weeklyLimitW",
    );
  }
  return EXIT.ok;
}
