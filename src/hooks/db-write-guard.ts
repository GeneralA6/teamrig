import { DEFAULT_DB_WRITE_GUARD } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import type { DbWriteGuardConfig, HookAsks } from '../config/types.ts';
import { toolCommandReadings } from '../core/bash-tool-readings.ts';
import type { Files } from '../core/files.ts';
import { isRecord, recordField, stringField } from '../core/guards.ts';
import { dbWritesOf, describeDbWrite, type DbWrite } from '../db-write-guard/writes.ts';
import { holdBackOutput } from './permission.ts';

export interface DbWriteGuardEnv extends DbWriteGuardConfig {
  /** The folder to judge from when the payload names none. */
  readonly cwd: string;
  readonly home: string;
  /** Where the guard reads the scripts and files a line hands a database program or Node. */
  readonly files: Files;
  /** Whether a call the guard would ask about raises the prompt or is refused with what to do instead. */
  readonly hookAsks: HookAsks;
  /** The host's platform: on Windows a Bash line is read as written and as bash receives it (core/bash-tool-readings.ts). */
  readonly platform: NodeJS.Platform;
}

/** What a hand-run write gets. A missing or unreadable config keeps the default, so a broken config never switches the guard off. */
export function dbWriteGuardOf(load: ConfigLoad | undefined): DbWriteGuardConfig {
  return load?.status === 'loaded' ? load.config.dbWriteGuard : DEFAULT_DB_WRITE_GUARD;
}

/** Why the line is refused or asked about: each write it makes, and the read-only step to show the owner first. */
export function dbWriteReason(writes: readonly DbWrite[]): string {
  const named = writes.map(describeDbWrite).join('; ');
  const preview = writes.some((write) => write.entrypoint)
    ? 'run it without its apply flag (its dry run)'
    : 'run a count or find of what it would change';
  return (
    `teamrig db-write guard: this line writes to a database by hand: ${named}. First ${preview}, show the owner the ` +
    "counts or a preview, and run the write only with the owner's OK. [dbWriteGuard.writes]"
  );
}

/**
 * The PreToolUse output for a Bash or PowerShell call: a question (or a refusal, as `dbWriteGuard.writes` says) when
 * the line writes to a database by hand, through a built-in SQL client, a database program the team names, Node code
 * using a client module the team names, or a team entrypoint run with an apply flag; else nothing, so the normal
 * permission flow decides. Under `hookAsks: refuse` the question is a refusal instead, its reason saying what to do.
 * A Bash line on Windows is read in each text bash may run (`toolCommandReadings`), naming each write once.
 */
export async function dbWriteGuardOutput(payload: unknown, env: DbWriteGuardEnv): Promise<string> {
  const decision = env.writes;
  if (decision === 'allow' || !isRecord(payload)) {
    return '';
  }
  const command = stringField(recordField(payload, 'tool_input') ?? {}, 'command');
  if (command === undefined) {
    return '';
  }
  const tool = stringField(payload, 'tool_name');
  const context = {
    cwd: stringField(payload, 'cwd') ?? env.cwd,
    home: env.home,
    dialect: tool === 'PowerShell' ? 'powershell' : 'bash',
    files: env.files,
    rules: { entrypoints: env.entrypoints, programs: env.programs, nodeClients: env.nodeClients, clientReceivers: env.clientReceivers },
  } as const;
  const readings = toolCommandReadings(tool, command, env.platform);
  const writes = uniqueWrites((await Promise.all(readings.map((text) => dbWritesOf(text, context)))).flat());
  return writes.length === 0 ? '' : holdBackOutput(decision, dbWriteReason(writes), env.hookAsks);
}

/** Each write once, in the order first found: a write both readings of a line make is named once. */
function uniqueWrites(writes: readonly DbWrite[]): DbWrite[] {
  const seen = new Set<string>();
  return writes.filter((write) => {
    const phrase = describeDbWrite(write);
    if (seen.has(phrase)) {
      return false;
    }
    seen.add(phrase);
    return true;
  });
}
