import type { Files } from '../core/files.ts';
import type { TeamPaths } from '../core/home.ts';
import type { LimitSpan } from '../register/stats.ts';
import { calibrationOf, crossingOf, fitRate, MeterLog, readingsOfTeam, type LoggedReading, type LogScale, type MeterReading } from './calibration.ts';
import { ExtraLog, limitSpansOf, wAtFullOf } from './extra.ts';
import { PeriodStore } from './period.ts';
import type { UsageState } from './store.ts';
import { coversFrom, meteredOf, rateOf, readWeek, wSince, type WeekInput, type WeekReading } from './week.ts';

/** The team paths the week now reads and writes. */
export type TeamWeekPaths = Pick<TeamPaths, 'period' | 'meterLog' | 'extraLog'>;

/** Another team keeping its week in the account's files, with its usage stores as last stored. */
export interface PeerStores {
  readonly team: string;
  readonly states: readonly UsageState[];
}

/** Whose lines a team reads in the account's meter log (`readingsOfTeam`), and the other teams it logs a crossing for. */
export interface MeterScale extends LogScale {
  /** The other teams keeping their week in the account's files; read only when a crossing is logged. */
  readonly peers: () => Promise<readonly PeerStores[]>;
}

/** The week as `teamWeekOf` reads it, with what the account's whole meter log, every team's lines, says beside it. */
export interface TeamWeekReading extends WeekReading {
  /** The stretches the account's week sat at its usage limit (`limitSpansOf`). */
  readonly limits: readonly LimitSpan[];
}

/**
 * The crossing's line for each peer whose stores reach back to its period's start: the W its own stores metered since
 * then and the use its own fit forecast for it, so each team's lines stay on its scale whichever team saw the crossing.
 */
function peerLinesOf(peers: readonly PeerStores[], crossing: MeterReading, logged: readonly LoggedReading[], keeper: string, now: number): LoggedReading[] {
  return peers
    .filter((peer) => coversFrom(peer.states, crossing.start))
    .map((peer) => {
      const w = wSince(peer.states, crossing.start, now);
      const fit = fitRate(readingsOfTeam(logged, { team: peer.team, keeper }));
      return { ...crossing, w, forecastPct: fit === undefined ? undefined : w / fit.wPerPct, team: peer.team };
    });
}

/**
 * The week now, read the one way every reader of it takes (the budget hooks, `teamrig budget`, a hire's price): the
 * team's own lines of the meter log (`readingsOfTeam`) and their fit (budget/calibration.ts), the account's period
 * moved on from the status line's use and the W metered at the fit's rate (budget/period.ts) and written when it
 * changed, then the week read in it with the extra-usage log (budget/extra.ts). A percent the status line passed
 * since the period's previous reading is logged once for each team keeping its week in these files, each with the W
 * its own stores metered (T1669), for the next fit: the period moved on, so no other team logs that percent. The
 * stretches at the usage limit come from those lines too, so a hook reads the log once, and count the lines just
 * logged: the account stops at 100%, so the hook that saw that crossing may be the last before the reset.
 */
export async function teamWeekOf(
  files: Files,
  paths: TeamWeekPaths,
  scale: MeterScale,
  input: Omit<WeekInput, 'period' | 'calibration' | 'readings' | 'extra'>,
): Promise<TeamWeekReading> {
  const { budget, statusUse, states, now } = input;
  const log = new MeterLog(files, paths.meterLog);
  const logged = await log.read(now);
  const readings = readingsOfTeam(logged, scale);
  const calibration = calibrationOf(readings);
  const metered = meteredOf(rateOf(calibration, budget, undefined)?.wPerPct, states, now);
  const move = await new PeriodStore(files, paths.period).moveAt(budget, statusUse, now, metered);
  const period = move?.period;
  const entries = await new ExtraLog(files, paths.extraLog).read();
  const wAtFull = period === undefined ? undefined : wAtFullOf(readings, period.start);
  const week = readWeek({ ...input, period, calibration, readings, extra: { entries, wAtFull } });
  const w = period === undefined ? 0 : wSince(states, period.start, now);
  const crossing = crossingOf({ before: move?.before, period, use: statusUse, covered: week.covered, w, now }, calibration.fit);
  const lines: readonly LoggedReading[] = crossing === undefined ? [] : [{ ...crossing, team: scale.team }, ...peerLinesOf(await scale.peers(), crossing, logged, scale.keeper, now)];
  await log.appendAll(lines, now);
  return { ...week, limits: limitSpansOf([...logged, ...lines]) };
}
