import { DEFAULT_DB_WRITE_GUARD } from '../config/defaults.ts';
import type { ConfigLoad } from '../config/load.ts';
import type { DbWriteGuardConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import { dbWritesOf, describeDbWrite, type DbWrite } from '../db-write-guard/writes.ts';
import type { HookEvent, HookReply } from '../ports/host/index.ts';
import { heldBack } from './permission.ts';

export interface DbWriteGuardEnv extends DbWriteGuardConfig {
  /** The folder to judge from when the payload names none. */
  readonly cwd: string;
  readonly home: string;
  /** Where the guard reads the scripts and files a line hands a database program or Node. */
  readonly files: Files;
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
 * The reply to a shell call about to run: a question (or a refusal, as `dbWriteGuard.writes` says) when the line
 * writes to a database by hand, through a built-in SQL client, a database program the team names, Node code using a
 * client module the team names, or a team entrypoint run with an apply flag; else none, so the normal permission
 * flow decides. Under `hookAsks: refuse` the question is a refusal instead, its reason saying what to do. The line is
 * read in each text its shell may run (the call's `readings`), naming each write once.
 */
export async function dbWriteGuardReply(event: HookEvent, env: DbWriteGuardEnv): Promise<HookReply | undefined> {
  const decision = env.writes;
  const { call } = event;
  if (decision === 'allow' || call?.kind !== 'shell' || call.command === undefined) {
    return undefined;
  }
  const context = {
    cwd: event.cwd ?? env.cwd,
    home: env.home,
    dialect: call.dialect,
    files: env.files,
    rules: { entrypoints: env.entrypoints, programs: env.programs, nodeClients: env.nodeClients, clientReceivers: env.clientReceivers },
  } as const;
  const writes = uniqueWrites((await Promise.all(call.readings.map((text) => dbWritesOf(text, context)))).flat());
  return writes.length === 0 ? undefined : heldBack(decision, dbWriteReason(writes));
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
