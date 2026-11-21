import { autoRestartOf } from '../config/refresh.ts';
import type { KitConfig } from '../config/types.ts';
import type { Files } from '../core/files.ts';
import type { TeamPaths } from '../core/home.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import type { TimeZone } from '../core/zone.ts';
import type { TranscriptReader } from '../ports/host/index.ts';
import { RestartLog, type RestartRow } from '../refresh/restart-log.ts';
import { RefreshStore } from '../refresh/store.ts';
import { runsClaude, type SessionProcesses } from '../open/session-processes.ts';
import { lastTurnAtOf, tabActivityOf } from '../sessions/idle.ts';
import { REPLY_TAIL_BYTES } from '../turn-log/reply.ts';
import type { UnownedWarning } from './unowned.ts';

/**
 * How long past `refresh.restartDelaySeconds` a ready session may sit quiet with no restart before `check` names it
 * (#705): the delay itself is seconds, and a restart that runs takes about a minute, so 10 minutes past it is a
 * restart that will not come.
 */
export const STALLED_MARGIN_MINUTES = 10;

/** A ready, noticed session the automatic restart left behind: when its handover was ready, since when it is quiet, its last log row. */
interface Stalled {
  readonly session: string;
  readonly readyAt: number;
  readonly quietSince: number;
  readonly row: RestartRow | undefined;
}

/**
 * When the session's tab went quiet: its transcript's last own entry, never before its handover was ready; undefined
 * while a turn runs or waits at a tool call. A transcript it cannot read counts from the ready state, and so does
 * every transcript of a host that gives no `reader`.
 */
async function quietSinceOf(reader: TranscriptReader | undefined, files: Files, transcript: string | null, readyAt: number): Promise<number | undefined> {
  const tail = reader === undefined || transcript === null ? undefined : await files.readTail(transcript, REPLY_TAIL_BYTES);
  if (reader === undefined || tail === undefined) {
    return readyAt;
  }
  const cut = Buffer.byteLength(tail, 'utf8') >= REPLY_TAIL_BYTES;
  const activity = tabActivityOf(reader, tail, cut);
  return activity === 'turn' || activity === 'call' ? undefined : Math.max(readyAt, lastTurnAtOf(reader, tail, cut) ?? readyAt);
}

type ClaudeProcesses = Pick<SessionProcesses, 'alive' | 'describe'>;

/** What the check reads a session's state from: the host's transcript reader (undefined: it keeps none teamrig reads), files and processes. */
interface StalledSources {
  readonly reader: TranscriptReader | undefined;
  readonly files: Files;
  readonly processes: ClaudeProcesses;
}

async function stalledOf({ reader, files, processes }: StalledSources, store: RefreshStore, log: RestartLog, session: string, now: number, waitMs: number): Promise<Stalled | undefined> {
  const state = await store.state(session);
  if (state?.phase !== 'ready' || !state.noticed || (await store.restart(session)) !== undefined || (await store.parked(session)) !== undefined) {
    return undefined;
  }
  const readyAt = Date.parse(state.at);
  const quietSince = Number.isNaN(readyAt) ? undefined : await quietSinceOf(reader, files, state.transcript, readyAt);
  if (quietSince === undefined || now - quietSince <= waitMs) {
    return undefined;
  }
  // A ready state outlives its tab (closed by a person, the idle pass or a reboot); with no Claude Code left, the next
  // start reads the handover, so nothing is stalled. Looked up last: it costs a process read.
  if (state.claudePid !== null && !(await runsClaude(processes, state.claudePid))) {
    return undefined;
  }
  return { session, readyAt, quietSince, row: await log.lastRowOf(session) };
}

function rowText(row: RestartRow | undefined, zone: TimeZone): string {
  if (row === undefined) {
    return 'none';
  }
  const ended = Date.parse(row.endedAt);
  const when = Number.isNaN(ended) ? row.endedAt : zone.clock(new Date(ended));
  return `${row.kind} at ${when}${row.why === null ? '' : ` (${row.why})`}`;
}

/**
 * RESTART-STALLED (#705), for `check`: a session the automatic restart covers (`refresh.autoRestart`) whose handover
 * is ready and noticed, with no restart pending or parked, quiet longer than `refresh.restartDelaySeconds` plus
 * STALLED_MARGIN_MINUTES. Its restart was cancelled by a prompt, or its runner died where no hook re-arms it, so it
 * sits on its old context until a person looks: a warning no session owns, which goes to the lead. Its key names the
 * ready state, so the lead is told once per handover. A session whose recorded Claude Code no longer runs is left out:
 * its tab is gone, and its next start takes the handover.
 */
export async function restartStalledWarnings(
  reader: TranscriptReader | undefined,
  files: Files,
  processes: ClaudeProcesses,
  paths: Pick<TeamPaths, 'refresh' | 'handover' | 'team'>,
  config: Pick<KitConfig, 'refresh' | 'roles' | 'sessions'>,
  zone: TimeZone,
  now: number,
): Promise<UnownedWarning[]> {
  const store = new RefreshStore(files, paths);
  const log = new RestartLog(files, paths);
  const { restartDelaySeconds } = config.refresh;
  const waitMs = restartDelaySeconds * 1000 + STALLED_MARGIN_MINUTES * MS_PER_MINUTE;
  const covered = config.sessions.filter((session) => autoRestartOf(config, session));
  const stalled = await Promise.all(covered.map((session) => stalledOf({ reader, files, processes }, store, log, session, now, waitMs)));
  return stalled.flatMap((each) => {
    if (each === undefined) {
      return [];
    }
    const sat = Math.floor((now - each.quietSince) / MS_PER_MINUTE);
    const text =
      `RESTART-STALLED ${paths.team}/${each.session} has sat ${sat} min with its handover ready since ${zone.clock(new Date(each.readyAt))} ` +
      `and no restart pending or parked, past refresh.restartDelaySeconds (${restartDelaySeconds} s) plus ${STALLED_MARGIN_MINUTES} min; ` +
      `last restart-log row: ${rowText(each.row, zone)}; type /clear in its tab for its fresh start`;
    return [{ key: `restart-stalled ${each.session} ${new Date(each.readyAt).toISOString()}`, source: 'the stalled-restart check [refresh.autoRestart]', text }];
  });
}
