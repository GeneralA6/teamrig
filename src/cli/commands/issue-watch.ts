import type { KitConfig } from '../../config/types.ts';
import { ENV } from '../../core/home.ts';
import type { FileLock } from '../../core/lock.ts';
import { SecretScanner } from '../../core/secrets.ts';
import { KIT_VERSION } from '../../core/version.ts';
import {
  formatWatchLease,
  idleDone,
  leaseHeld,
  LIFETIME_MS,
  leaseOutdated,
  lifetimeDone,
  parseWatchLease,
  readDue,
  type LastRead,
  type ProbeRound,
  type WatchLease,
} from '../../sync/watch.ts';
import { GITHUB_REPOS_HOST, type WatchMarks } from '../../issues/host.ts';
import { runsClaude } from '../../open/session-processes.ts';
import { SessionRecordStore } from '../../sessions/record.ts';
import { noPositionals, type ParsedArgs } from '../args.ts';
import { fileLockOf } from '../file-locks.ts';
import { hostsOf } from '../issue-hosts.ts';
import { openTeamKit, requireConfig, type Kit } from '../kit.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { GITHUB_OFF, githubOff } from './issue-sync-auto.ts';
import { issueSync } from './issue-sync.ts';

/**
 * `issue watch`: the team's one watch on its GitHub repositories, started hidden by the hooks (`ensureWatch`). Every
 * `github.probeSeconds` it asks GitHub whether each repository changed (IssueEvents.watch: conditional reads, free when
 * nothing changed) and runs `issue sync --auto` in this process only when one did (sync/watch.ts readDue). It holds
 * a lease file with its pid and a beat, so one runs per team; it stops when the lease is another's, when the config
 * lists no repository or sets 0 seconds, under TEAMRIG_GITHUB=off, once no team session ran for 10 minutes, and once
 * it ran 24 hours. A hook of a newer kit takes over an older watch's lease, so an update reaches the watch at once.
 */

const HOUR_MS = 3_600_000;

/** The sync a change calls for, as the Stop hook used to start it: every repository, written, with its reports. */
const AUTO_SYNC: ParsedArgs = { command: 'issue sync', positionals: [], flags: new Map(), switches: new Set(['auto']), rest: [], help: false, common: new Map() };

/** Why no watch runs for this config and machine, or undefined when one should. */
export function watchOffReason(config: KitConfig, env: CliRuntime['env']): string | undefined {
  if (githubOff(env)) {
    return `${ENV.github}=${GITHUB_OFF} turns the GitHub import off on this machine`;
  }
  if (config.github.repos.length === 0) {
    return 'no repository is listed under github.repos';
  }
  if (config.github.probeSeconds === 0) {
    return 'github.probeSeconds is 0: the sync runs only with issue sync --yes';
  }
  return undefined;
}

function leaseLock(runtime: CliRuntime, kit: Kit, config: KitConfig, waitMs: number): FileLock {
  return fileLockOf(runtime, kit.paths.githubWatchLock, { ...config.lock, waitMs });
}

async function readLease(runtime: CliRuntime, kit: Kit): Promise<WatchLease | undefined> {
  return parseWatchLease((await runtime.files.read(kit.paths.githubWatch)) ?? '');
}

/**
 * Whether a lease holds the watch: fresh, of this kit's version or a newer one, and either a hook's claim on its way or
 * a process still running. An older watch's lease holds nothing, so the old code stops at its next beat.
 */
function holds(runtime: CliRuntime, lease: WatchLease | undefined, now: number, probeSeconds: number): boolean {
  if (lease === undefined || !leaseHeld(lease, now, probeSeconds) || leaseOutdated(lease, KIT_VERSION)) {
    return false;
  }
  return lease.pid === undefined || runtime.sessionProcesses.alive(lease.pid);
}

/**
 * The hooks' part (Stop and SessionStart): when no watch holds the team's lease, claims it for one on its way and
 * starts `issue watch` hidden for the team the hook runs for, so the hook neither prints nor waits. A hook that finds
 * the lease held reads one small file; the claim is checked again under the lock, which a hook never waits for
 * (another session's hook holding it is claiming the same watch, and its LockBusyError is the caller's to drop).
 */
export async function ensureWatch(runtime: CliRuntime, kit: Kit, config: KitConfig): Promise<void> {
  if (watchOffReason(config, runtime.env) !== undefined) {
    return;
  }
  const now = runtime.clock.now();
  const { probeSeconds } = config.github;
  if (holds(runtime, await readLease(runtime, kit), now, probeSeconds)) {
    return;
  }
  const claimed = await leaseLock(runtime, kit, config, 0).run(async () => {
    if (holds(runtime, await readLease(runtime, kit), now, probeSeconds)) {
      return false;
    }
    await runtime.files.write(kit.paths.githubWatch, formatWatchLease({ pid: undefined, kitVersion: KIT_VERSION, startedAt: now, beatAt: now }));
    return true;
  });
  if (claimed) {
    await runtime.processes.startHidden({
      command: runtime.self.node,
      args: [runtime.self.script, 'issue', 'watch'],
      cwd: kit.paths.home,
      env: { ...runtime.env, [ENV.team]: kit.paths.team },
    });
  }
}

export async function issueWatch(args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> {
  noPositionals(args);
  const say = (line: string): void => runtime.out.stdout(line);
  const kit = await openTeamKit(runtime);
  const config = requireConfig(kit, runtime, 'write');
  const off = watchOffReason(config, runtime.env);
  if (off !== undefined) {
    say(`OFF ${off}; no watch runs`);
    return EXIT.ok;
  }
  const now = runtime.clock.now();
  const claimed = await leaseLock(runtime, kit, config, config.lock.waitMs).run(async () => {
    const lease = await readLease(runtime, kit);
    if (lease?.pid !== undefined && lease.pid !== runtime.pid && holds(runtime, lease, now, config.github.probeSeconds)) {
      return false;
    }
    await runtime.files.write(kit.paths.githubWatch, formatWatchLease({ pid: runtime.pid, kitVersion: KIT_VERSION, startedAt: now, beatAt: now }));
    return true;
  });
  if (!claimed) {
    say('HELD another watch runs for this team; this one stops');
    return EXIT.ok;
  }
  try {
    say(`STOP ${await watchLoop(runtime, now)}`);
  } finally {
    await leaseLock(runtime, kit, config, config.lock.waitMs).run(async () => {
      if ((await readLease(runtime, kit))?.pid === runtime.pid) {
        await runtime.files.remove(kit.paths.githubWatch);
      }
    });
  }
  return EXIT.ok;
}

/**
 * The watch's rounds until one ends it; it gives why it stopped. Each round reads the config afresh, so an edit to
 * the repositories or the interval counts from the next round, and keeps the marks of a repository only once a sync
 * that read it went well, so a change a failed sync missed reads as changed again.
 */
async function watchLoop(runtime: CliRuntime, startedAt: number): Promise<string> {
  const marks = new Map<string, WatchMarks>();
  let last: LastRead | undefined;
  let idleSince: number | undefined;
  for (;;) {
    const kit = await openTeamKit(runtime);
    const config = requireConfig(kit, runtime, 'write');
    const off = watchOffReason(config, runtime.env);
    if (off !== undefined) {
      return off;
    }
    if (!(await beat(runtime, kit, config))) {
      return 'another watch holds the lease';
    }
    const now = runtime.clock.now();
    if (lifetimeDone(startedAt, now)) {
      return `the watch ran ${LIFETIME_MS / HOUR_MS} hours; the next hook starts a fresh one`;
    }
    idleSince = (await anySessionRuns(runtime, kit, config)) ? undefined : (idleSince ?? now);
    if (idleDone(idleSince, now)) {
      return 'no session of the team ran for 10 minutes; the next one starts the watch again';
    }
    const { round, pending } = await probeRound(runtime, config, marks);
    if (readDue(last, round, now)) {
      const code = await issueSync(AUTO_SYNC, runtime);
      last = { at: now, ok: code !== EXIT.failed };
      if (last.ok) {
        pending.forEach((seen, repo) => marks.set(repo, seen));
      }
      if (!(await beat(runtime, kit, config))) {
        return 'another watch holds the lease';
      }
    }
    await runtime.sleep(config.github.probeSeconds * 1000);
  }
}

/** Renews the lease's beat while it is still this process's; false once another watch took it. */
async function beat(runtime: CliRuntime, kit: Kit, config: KitConfig): Promise<boolean> {
  return leaseLock(runtime, kit, config, config.lock.waitMs).run(async () => {
    const lease = await readLease(runtime, kit);
    if (lease?.pid !== runtime.pid) {
      return false;
    }
    await runtime.files.write(kit.paths.githubWatch, formatWatchLease({ ...lease, beatAt: runtime.clock.now() }));
    return true;
  });
}

/** Whether any session of the team has a Claude Code process running. */
async function anySessionRuns(runtime: CliRuntime, kit: Kit, config: KitConfig): Promise<boolean> {
  const records = await new SessionRecordStore(runtime.files, kit.paths).readEach(config.sessions);
  for (const record of records.values()) {
    if (record !== undefined && (await runsClaude(runtime.sessionProcesses, record.claudePid))) {
      return true;
    }
  }
  return false;
}

/** Probes every repository: changed when any did (with the marks to keep once synced), else failed when one failed. */
async function probeRound(
  runtime: CliRuntime,
  config: KitConfig,
  marks: ReadonlyMap<string, WatchMarks>,
): Promise<{ readonly round: ProbeRound; readonly pending: ReadonlyMap<string, WatchMarks> }> {
  // The probe goes over github.repos, GitHub's list, and asks its tracker.
  const host = (await hostsOf(GITHUB_REPOS_HOST, runtime, new SecretScanner(config.register.secretPatterns), config.github.stamp)).tracker;
  const pending = new Map<string, WatchMarks>();
  let failed = false;
  for (const repo of config.github.repos) {
    const seen = await host.watch(repo, marks.get(repo) ?? new Map());
    if (seen.kind === 'changed') {
      pending.set(repo, seen.marks);
    } else if (seen.kind === 'failed') {
      failed = true;
      runtime.out.stdout(`FAILED ${seen.reason}`);
    }
  }
  return { round: pending.size > 0 ? 'changed' : failed ? 'failed' : 'unchanged', pending };
}
