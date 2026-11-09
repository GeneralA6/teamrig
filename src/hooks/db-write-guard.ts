import { DEFAULT_DB_WRITE_GUARD } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import type { DbWriteGuardConfig, HookAsks } from '../config/types.ts';
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
  const writes = await dbWritesOf(command, {
    cwd: stringField(payload, 'cwd') ?? env.cwd,
    home: env.home,
    dialect: stringField(payload, 'tool_name') === 'PowerShell' ? 'powershell' : 'bash',
    files: env.files,
    rules: { entrypoints: env.entrypoints, programs: env.programs, nodeClients: env.nodeClients, clientReceivers: env.clientReceivers },
  });
  return writes.length === 0 ? '' : holdBackOutput(decision, dbWriteReason(writes), env.hookAsks);
}
