import { TimeZone } from '../../core/zone.ts';
import { launcherCensus, launchOf, type Launcher } from '../../open/launcher-census.ts';
import { lineageOf, type EndOutcome } from '../../open/session-processes.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';

const REASON_TEXT = { 'starter-gone': 'its terminal has ended', 'starter-reused': 'its terminal has ended and a later process holds its id' } as const;

/** One census line: whether the launcher lost its tab, its session, when it started, and what started it. */
export function launcherLine(launcher: Launcher, zone: TimeZone): string {
  const started = launcher.startedMs === undefined ? 'start unknown' : `started ${zone.minute(new Date(launcher.startedMs))}`;
  const starter = `starter ${launcher.parentPid} ${launcher.parentName ?? '(gone)'}`;
  const who = `${launcher.team ?? '?'}/${launcher.session}`;
  return launcher.orphaned === undefined
    ? `LIVE pid ${launcher.pid} ${who}, ${started}, ${starter}`
    : `ORPHANED pid ${launcher.pid} ${who}, ${started}, ${starter}: ${REASON_TEXT[launcher.orphaned]}`;
}

function endLine(launcher: Launcher, outcome: EndOutcome): string {
  switch (outcome.kind) {
    case 'ended':
      return `ENDED pid ${launcher.pid} ${launcher.session} and the processes it started`;
    case 'gone':
      return `GONE pid ${launcher.pid} ${launcher.session}: it had ended already`;
    case 'failed':
      return `FAILED pid ${launcher.pid} ${launcher.session}: ${outcome.error}`;
  }
}

/**
 * Ends one orphaned launcher, after checking that its id still runs the same session's launch: between the census
 * and the end, the id may have gone to another process, which is then left alone (`gone`).
 */
async function endOrphan(runtime: CliRuntime, launcher: Launcher): Promise<EndOutcome> {
  const now = await runtime.sessionProcesses.describe(launcher.pid);
  if (now === undefined || launchOf(now.name, now.commandLine)?.session !== launcher.session) {
    return { kind: 'gone' };
  }
  return runtime.sessionProcesses.end(launcher.pid, 'force');
}

/**
 * `cleanup launchers [--yes]`: lists every `teamrig launch` process on this host (each tab's root, which runs and
 * restarts its Claude Code), and which lost their tab: the terminal that started them has ended. Without --yes it
 * only prints the census and ends nothing; with --yes it ends each orphaned one and what it started. Its own tab's
 * launcher is never offered. Exit 0, or 1 when the processes cannot be listed or an end failed.
 */
export async function cleanupLaunchers(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const listed = await runtime.sessionProcesses.list();
  if (listed === undefined) {
    runtime.out.stderr("FAILED the host's processes could not be listed, so nothing was read or ended");
    return EXIT.failed;
  }
  const own = new Set(lineageOf(runtime.pid, listed).map((info) => info.pid));
  const census = launcherCensus(listed, own);
  const zone = TimeZone.of(runtime.timeZone) ?? TimeZone.UTC;
  for (const launcher of census.launchers) {
    runtime.out.stdout(launcherLine(launcher, zone));
  }
  runtime.out.stdout(`${census.launchers.length} launcher(s), ${census.orphaned} orphaned`);
  const orphans = census.launchers.filter((launcher) => launcher.orphaned !== undefined);
  if (!args.switches.has('yes')) {
    if (orphans.length > 0) {
      runtime.out.stdout(`DRY RUN ended nothing; run it again with --yes to end the ${orphans.length} orphaned`);
    }
    return EXIT.ok;
  }
  let failed = false;
  for (const launcher of orphans) {
    const outcome = await endOrphan(runtime, launcher);
    failed ||= outcome.kind === 'failed';
    runtime.out.stdout(endLine(launcher, outcome));
  }
  return failed ? EXIT.failed : EXIT.ok;
}
