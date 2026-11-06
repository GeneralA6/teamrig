import { join } from 'node:path';
import type { Files } from '../core/files.ts';
import { errorMessage, stringField } from '../core/guards.ts';
import { parseObject, recordVersion, VERSION_FIELD } from '../core/jsonl.ts';
import { LockBusyError, type LockTimings, type Mutex } from '../core/lock.ts';
import { compareVersions, parseVersion, type Version } from '../core/release-version.ts';
import { launcherStep, restorePlan, type Launcher, type MachineStep, type RestoreMachine } from './install-plan.ts';
import { EMPTY_SURVEY, sameSurvey, surveyFields, surveyOf, type LauncherSurvey } from './launcher-survey.ts';
import { restoreLogPath } from './registry.ts';

/**
 * The launcher refresh at each session start: once per plugin version, it brings up to date what an install left on
 * the machine (install-plan.ts in refresh mode, plus the kit home's other launchers), so a plugin update never leaves
 * an old launcher, a logon entry or a pinned shortcut behind. The record `<kit home>/bin/launchers.json` names the
 * newest version that refreshed: a start reads it once, without the lock, and goes on only when it runs a newer
 * version, so every later start of that version costs that one read, and an older teamrig still running beside a newer
 * one writes nothing, so the two never take turns rewriting the launchers. The start that goes on takes the lock
 * without waiting, so the tabs of a restore starting together leave the refresh to one of them, reads the record again
 * under it, and takes the steps in order. Each step taken goes to the restore log; a failed one is logged and leaves
 * the record as it was, so the next session start tries again. The record also holds what starts the restore
 * (launcher-survey.ts), as the last refresh, install or uninstall left it, which `teamrig check` reads to flag a part
 * that starts a file gone or something install did not set up; a refresh reads the logon entry and the shortcuts for it
 * even where it changes nothing, so a machine with no install costs those reads once per version too.
 */

/** The record's format; a field added to it raises this. Format 2 added the survey's `registered` and `found` lists. */
export const LAUNCHER_RECORD_FORMAT = 2;

/**
 * The record's lock: a refresh spawns a few system commands (the logon entry and the shortcut scan), and a waiter
 * never waits, since the start that holds it does the same work.
 */
export const LAUNCHER_REFRESH_LOCK: LockTimings = { ttlMs: 120_000, pollMs: 50, waitMs: 0 };

/**
 * The record's lock as `restore install` and `restore uninstall` take it while they write: they wait out a refresh
 * another session start is taking, which ends or turns stale within the lock's TTL, so the two never interleave.
 */
export const LAUNCHER_INSTALL_LOCK: LockTimings = { ...LAUNCHER_REFRESH_LOCK, waitMs: LAUNCHER_REFRESH_LOCK.ttlMs };

/** The record of the newest version that refreshed the launchers: `<kit home>/bin/launchers.json`. */
export function launcherRecordPath(kitHome: string): string {
  return join(kitHome, 'bin', 'launchers.json');
}

/** The record as read. */
export interface LauncherRecord {
  readonly format: number;
  /** The newest version that refreshed; absent until a refresh writes one, as an install or uninstall writes none. */
  readonly version?: string;
  /** What starts the restore; absent in a record of another format, or one whose lists are damaged. */
  readonly survey?: LauncherSurvey;
}

/** The record's text as `LauncherRecord`; undefined for no text, or one that is no record. */
function recordOf(text: string | undefined): LauncherRecord | undefined {
  const record = text === undefined ? undefined : parseObject(text.trim());
  const format = record === undefined ? undefined : recordVersion(record);
  if (record === undefined || format === undefined) {
    return undefined;
  }
  const version = stringField(record, 'version');
  const survey = format === LAUNCHER_RECORD_FORMAT ? surveyOf(record) : undefined;
  return { format, ...(version === undefined ? {} : { version }), ...(survey === undefined ? {} : { survey }) };
}

/** The launcher record of the kit home; undefined when there is none, or it is damaged. */
export async function readLauncherRecord(files: Files, kitHome: string): Promise<LauncherRecord | undefined> {
  return recordOf(await files.read(launcherRecordPath(kitHome)));
}

/** What the record says: no refresh known (none, or a damaged record), one by a newer format, or the version that wrote it. */
type Recorded = { readonly kind: 'none' } | { readonly kind: 'newer-format' } | { readonly kind: 'version'; readonly text: string; readonly version: Version };

/** The record as `Recorded`. */
function recordedOf(record: LauncherRecord | undefined): Recorded {
  if (record === undefined) {
    return { kind: 'none' };
  }
  if (record.format > LAUNCHER_RECORD_FORMAT) {
    return { kind: 'newer-format' };
  }
  const version = record.version === undefined ? undefined : parseVersion(record.version);
  return record.version === undefined || version === undefined ? { kind: 'none' } : { kind: 'version', text: record.version, version };
}

/** Whether `running` is newer than the version the record names: a record of no version is older, one of a newer format newer. */
function isDue(recorded: Recorded, running: Version): boolean {
  switch (recorded.kind) {
    case 'none':
      return true;
    case 'newer-format':
      return false;
    case 'version':
      return compareVersions(running, recorded.version) > 0;
  }
}

/** Whether the record names a version newer than `running`: one of a newer format does, none does not. */
function namesNewer(recorded: Recorded, running: Version): boolean {
  switch (recorded.kind) {
    case 'none':
      return false;
    case 'newer-format':
      return true;
    case 'version':
      return compareVersions(recorded.version, running) > 0;
  }
}

/**
 * The step that lowers the record to `version` before an install of that version writes the launchers: an older
 * teamrig on the PATH writes its older texts, and a record still naming a newer version would keep every later start
 * of that version from writing them back; lowered, the next start of a newer teamrig is due and refreshes. None when
 * the record names this version or an older one, when it names none (every start is due then), or when `version` is
 * no release version, which the refresh never records either. It keeps the survey the record holds, which the survey
 * step after the install's steps brings up to date (surveyRecordSteps).
 */
export async function lowerRecordSteps(files: Files, kitHome: string, version: string, now: number): Promise<MachineStep[]> {
  const running = parseVersion(version);
  const path = launcherRecordPath(kitHome);
  const record = recordOf(await files.read(path));
  const recorded = recordedOf(record);
  if (running === undefined || !namesNewer(recorded, running)) {
    return [];
  }
  const from = recorded.kind === 'version' ? recorded.text : 'a newer format';
  const survey = record?.survey;
  return [
    {
      line: `SET ${path}: ${from} -> ${version}, so the next start of a newer teamrig refreshes what this writes`,
      act: () => files.write(path, formatRecord({ version, at: now, ...(survey === undefined ? {} : { survey }) })),
    },
  ];
}

/**
 * The step that records `survey`, what starts the restore once `restore install` or `restore uninstall` took its steps,
 * which it takes last. None when the record holds that survey already, or when there is no record and nothing starts
 * the restore. A record of another format holds no survey this teamrig reads, so it is written in this one: one of a
 * newer format left as it was would keep naming parts an uninstall removed, which its check then flags as dead, and
 * a newer teamrig reads this format's record as an older one's, which flags nothing. Taken, it reads the record again
 * and keeps the version it names; with none named, the next session start refreshes and records the survey it reads
 * itself.
 */
export async function surveyRecordSteps(files: Files, kitHome: string, survey: LauncherSurvey, now: number): Promise<MachineStep[]> {
  const path = launcherRecordPath(kitHome);
  const record = recordOf(await files.read(path));
  const held = record === undefined ? EMPTY_SURVEY : record.format === LAUNCHER_RECORD_FORMAT ? record.survey : undefined;
  if (held !== undefined && sameSurvey(held, survey)) {
    return [];
  }
  return [
    {
      line: `WRITE ${path}: what starts the restore now, which teamrig check reads`,
      act: async () => {
        const version = recordOf(await files.read(path))?.version;
        await files.write(path, formatRecord({ ...(version === undefined ? {} : { version }), at: now, survey }));
      },
    },
  ];
}

/** The record's text: its format, the version that refreshed (when one did), when it was written, and the survey. */
function formatRecord(fields: { readonly version?: string; readonly at: number; readonly survey?: LauncherSurvey }): string {
  const { version, at, survey } = fields;
  const record = {
    [VERSION_FIELD]: LAUNCHER_RECORD_FORMAT,
    ...(version === undefined ? {} : { version }),
    at: new Date(at).toISOString(),
    ...(survey === undefined ? {} : surveyFields(survey)),
  };
  return `${JSON.stringify(record, null, 2)}\n`;
}

/** A refresh at a session start. */
export interface LauncherRefresh {
  /** The machine's restore parts, the logon entry and the shortcuts run by the Node this start runs on. */
  readonly machine: RestoreMachine;
  /** The kit home's other launchers a plugin update can leave old, such as the status line's; each rewritten only when there. */
  readonly others: readonly Launcher[];
  /** The lock on `<record>.lock`, with `LAUNCHER_REFRESH_LOCK`'s timings. */
  readonly lock: Mutex;
  /** The running plugin's version (KIT_VERSION); one that is no release version refreshes nothing. */
  readonly version: string;
  readonly now: number;
}

/** What a refresh did: nothing to do, left to another start holding the lock, the steps it took, or the line it failed on. */
export type LauncherRefreshOutcome =
  | { readonly kind: 'current' }
  | { readonly kind: 'busy' }
  | { readonly kind: 'refreshed'; readonly steps: readonly string[] }
  | { readonly kind: 'failed'; readonly line: string };

const CURRENT: LauncherRefreshOutcome = { kind: 'current' };

/** Refreshes the launchers when this version is newer than the record's, the record read once outside the lock. */
export async function refreshLaunchers(refresh: LauncherRefresh): Promise<LauncherRefreshOutcome> {
  const { machine, lock } = refresh;
  const running = parseVersion(refresh.version);
  const path = launcherRecordPath(machine.kitHome);
  if (running === undefined || !isDue(recordedOf(recordOf(await machine.files.read(path))), running)) {
    return CURRENT;
  }
  try {
    return await lock.run(async () => {
      const recorded = recordedOf(recordOf(await machine.files.read(path)));
      return isDue(recorded, running) ? await refreshUnderLock(refresh, recorded) : CURRENT;
    });
  } catch (error) {
    if (error instanceof LockBusyError) {
      return { kind: 'busy' };
    }
    throw error;
  }
}

/** Reads what is out of date and takes each step in order, logging each; writes the record once all are done. */
async function refreshUnderLock(refresh: LauncherRefresh, recorded: Recorded): Promise<LauncherRefreshOutcome> {
  const { machine, others, version, now } = refresh;
  const { files, kitHome } = machine;
  const from = recorded.kind === 'version' ? recorded.text : 'none';
  const log = async (line: string): Promise<void> => {
    await files.append(restoreLogPath(kitHome), `${new Date(now).toISOString()} launchers: ${from} -> ${version}: ${line}\n`);
  };
  const failed = async (what: string, error: unknown): Promise<LauncherRefreshOutcome> => {
    const line = `FAILED ${what}: ${errorMessage(error)}; the next session start tries again`;
    await log(line);
    return { kind: 'failed', line };
  };
  let steps: MachineStep[];
  let after: LauncherSurvey;
  try {
    const otherSteps = await Promise.all(others.map((launcher) => launcherStep(files, launcher, 'refresh')));
    const plan = await restorePlan(machine, 'refresh');
    steps = [...otherSteps.flat(), ...plan.steps];
    after = plan.after;
  } catch (error) {
    return failed('reading what is out of date', error);
  }
  for (const step of steps) {
    try {
      await step.act();
    } catch (error) {
      return failed(step.line, error);
    }
    await log(step.line);
  }
  await files.write(launcherRecordPath(kitHome), formatRecord({ version, at: now, survey: after }));
  return { kind: 'refreshed', steps: steps.map((step) => step.line) };
}
