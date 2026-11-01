import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { claudeProjectSlug } from '../budget/discover.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeCountdown, FakeShutdownLog, FakeStopWatch } from '../testing/fake-restore.ts';
import { MemoryFiles, MemoryPathProbe } from '../testing/memory-files.ts';
import type { RestoreChoice } from './countdown.ts';
import type { RestoreEntry } from './entry.ts';
import { continuePrompt, type LostWork } from './plan.ts';
import { RestoreRegistry, restoreSessionsDir } from './registry.ts';
import { checkRestore, previewRestore, runRestore, TAB_STAGGER_MS, type ReopenOutcome, type ReopenTab, type RestoreDeps } from './run.ts';
import type { RestoreTeam } from './teams.ts';

const LOGON = Date.parse('2030-01-08T09:00:00Z');
const SHUTDOWN = Date.parse('2030-01-08T08:50:00Z');
const LEAD = '10000000-2222-4333-8444-555555555555';
const ALPHA = '20000000-2222-4333-8444-555555555555';
const LONE = '30000000-2222-4333-8444-555555555555';
const SDK = '40000000-2222-4333-8444-555555555555';
const LIVE = '50000000-2222-4333-8444-555555555555';
const JOB = '60000000-2222-4333-8444-555555555555';
const MOVED = '70000000-2222-4333-8444-555555555555';
const WENT_IN = '80000000-2222-4333-8444-555555555555';
const PROJECTS = '/p';
const WORKTREE = '/work/app/.claude/worktrees/fix';
const NOTHING_LOST: LostWork = { background: 0, crons: 0, wake: false };

const turn = (effort: string): string => JSON.stringify({ type: 'assistant', effort, message: { model: 'claude-opus-5-5' } });

function entry(claudeSession: string, createdAt: number, overrides: Partial<RestoreEntry> = {}): RestoreEntry {
  return {
    claudeSession,
    projectDir: '/work/app',
    transcriptPath: `/t/${claudeSession}.jsonl`,
    entrypoint: 'cli',
    sessionKind: undefined,
    pid: undefined,
    team: undefined,
    session: undefined,
    state: 'ready',
    createdAt,
    updatedAt: SHUTDOWN - 60_000,
    restoreAttempts: 0,
    restoredAt: undefined,
    endedAt: undefined,
    endReason: undefined,
    ...overrides,
  };
}

const LEAD_ENTRY = entry(LEAD, 1, { team: 'app', session: 'lead' });
const ALPHA_ENTRY = entry(ALPHA, 2, { team: 'app', session: 'alpha', state: 'working' });
const LIVE_ENTRY = entry(LIVE, 5);
const ENTRIES: readonly RestoreEntry[] = [LEAD_ENTRY, ALPHA_ENTRY, entry(LONE, 3, { projectDir: '/work/removed/wt' }), entry(SDK, 4, { entrypoint: 'sdk-cli' }), LIVE_ENTRY];

const APP: RestoreTeam = {
  team: 'app',
  lead: 'lead',
  names: new Map([
    ['lead', 'app-lead'],
    ['alpha', 'app-alpha'],
  ]),
  terminal: 'auto',
  teamWindow: false,
  areaBySession: new Map(),
};

type Reopen = (tab: ReopenTab, world: World) => Promise<ReopenOutcome>;

interface World {
  readonly deps: RestoreDeps;
  readonly registry: RestoreRegistry;
  readonly clock: FakeClock;
  readonly countdown: FakeCountdown;
  readonly stops: FakeStopWatch;
  readonly reopened: ReopenTab[];
  readonly printed: string[];
  readonly logged: string[];
}

async function world(
  choice: RestoreChoice = 'go',
  reopen: Reopen = async () => ({ kind: 'opened' }),
  entries: readonly RestoreEntry[] = ENTRIES,
  more: Readonly<Record<string, string>> = {},
): Promise<World> {
  const files = new MemoryFiles({
    ...more,
    '/work/app/README.md': '',
    [`/t/${LEAD}.jsonl`]: `${turn('high')}\n`,
    [`/t/${ALPHA}.jsonl`]: `${turn('max')}\n`,
    [`/t/${LONE}.jsonl`]: `${JSON.stringify({ type: 'custom-title', customTitle: 'notes', sessionId: LONE })}\n`,
    [`/t/${SDK}.jsonl`]: '',
    [`/t/${LIVE}.jsonl`]: '',
    [`/t/${JOB}.jsonl`]: `${JSON.stringify({ type: 'user', entrypoint: 'cli', sessionKind: 'bg', sessionId: JOB })}\n`,
    [`/t/${MOVED}.jsonl`]: [
      JSON.stringify({ type: 'assistant', entrypoint: 'cli', sessionId: MOVED }),
      JSON.stringify({ type: 'continued-in', sessionId: MOVED, continuedInSessionId: JOB }),
      '',
    ].join('\n'),
  });
  const probe = new MemoryPathProbe(files);
  const registry = new RestoreRegistry(files, restoreSessionsDir('/kit'));
  for (const recorded of entries) {
    await registry.write(recorded);
  }
  const clock = new FakeClock('2030-01-08T09:05:00Z');
  const countdown = new FakeCountdown(choice);
  const stops = new FakeStopWatch();
  const reopened: ReopenTab[] = [];
  const printed: string[] = [];
  const logged: string[] = [];
  const self: World = {
    registry,
    clock,
    countdown,
    stops,
    reopened,
    printed,
    logged,
    deps: {
      registry,
      clock,
      sleep: clock.sleep,
      probe,
      shutdowns: new FakeShutdownLog({ start: SHUTDOWN, end: SHUTDOWN + 60_000 }),
      countdown,
      stops,
      teams: [APP],
      home: '/home/me',
      projectsDir: PROJECTS,
      platform: 'linux',
      stillRunning: async (recorded) => recorded.claudeSession === LIVE,
      transcriptOf: async ({ transcriptPath }) => (transcriptPath !== undefined && (await probe.kind(transcriptPath)) === 'file' ? transcriptPath : undefined),
      readTail: (path, maxBytes) => files.readTail(path, maxBytes),
      reopen: async (tab) => {
        reopened.push(tab);
        return reopen(tab, self);
      },
      print: (line) => printed.push(line),
      log: async (line) => {
        logged.push(line);
      },
    },
  };
  return self;
}

async function attemptsOf(registry: RestoreRegistry, id: string): Promise<number | undefined> {
  return (await registry.read(id))?.restoreAttempts;
}

describe('previewRestore', () => {
  it('shows what a restore would do with each session and changes nothing', async () => {
    const { deps, printed, registry } = await world();
    await previewRestore(deps);
    assert.deepEqual(printed, [
      `RESTORE  ${LEAD}  app-lead  killed without exiting; continue: lead; effort high  /work/app`,
      `RESTORE  ${ALPHA}  app-alpha  killed without exiting; continue: mid-turn; effort max  /work/app`,
      `RESTORE  ${LONE}  notes  killed without exiting; idle; effort default  /work/removed/wt`,
      `KEEP     ${LIVE}  still running  /work/app`,
      `DISCARD  ${SDK}  not a terminal session (sdk-cli)  /work/app`,
      'Lead app-lead hears: app-alpha continue (mid-turn)',
    ]);
    assert.equal((await registry.list()).length, 5);
  });

  it('says so when nothing is recorded', async () => {
    const { deps, printed } = await world('go', undefined, []);
    await previewRestore(deps);
    assert.deepEqual(printed, ['No Claude Code session is recorded.']);
  });
});

describe('checkRestore', () => {
  it('drops the entries no restore needs and counts the rest', async () => {
    const { deps, registry, logged, clock } = await world();
    assert.deepEqual(await checkRestore(deps), { since: clock.now(), count: 3 });
    assert.equal(await registry.read(SDK), undefined);
    assert.deepEqual(logged, [`discarded ${SDK} (not a terminal session (sdk-cli))`, 'check: 3 to restore, 1 kept']);
  });

  it('drops a background job and a tab continued in it, which the tracker recorded as tabs with no end', async () => {
    const { deps, registry, logged, clock } = await world('go', undefined, [LEAD_ENTRY, entry(JOB, 6), entry(MOVED, 7)]);
    assert.deepEqual(await checkRestore(deps), { since: clock.now(), count: 1 });
    assert.deepEqual((await registry.list()).map(({ claudeSession }) => claudeSession), [LEAD]);
    assert.deepEqual(logged, [`discarded ${JOB} (background session)`, `discarded ${MOVED} (continued in 60000000)`, 'check: 1 to restore, 0 kept']);
  });
});

describe('runRestore', () => {
  it('reopens each killed session after the countdown, oldest first, the lead told how the others came back', async () => {
    const { deps, reopened, registry, clock, countdown, printed } = await world();
    const start = clock.now();
    assert.deepEqual(await runRestore(deps, LOGON), { opened: 3, failed: 0 });
    assert.deepEqual(countdown.counted, [60]);
    assert.deepEqual(reopened, [
      {
        claudeSession: LEAD,
        title: 'app-lead',
        folder: '/work/app',
        team: { team: 'app', session: 'lead', name: 'app-lead', isLead: true, terminal: 'auto', teamWindow: false, launched: true },
        effort: 'high',
        prompt: continuePrompt(NOTHING_LOST, 'app-alpha continue (mid-turn)'),
      },
      {
        claudeSession: ALPHA,
        title: 'app-alpha',
        folder: '/work/app',
        team: { team: 'app', session: 'alpha', name: 'app-alpha', isLead: false, terminal: 'auto', teamWindow: false, launched: true },
        effort: 'max',
        prompt: continuePrompt(NOTHING_LOST, undefined),
      },
      { claudeSession: LONE, title: 'notes', folder: '/work', team: undefined, effort: undefined, prompt: undefined },
    ]);
    assert.deepEqual(clock.sleeps, [TAB_STAGGER_MS, TAB_STAGGER_MS]);
    assert.deepEqual(await registry.read(LEAD), { ...LEAD_ENTRY, restoreAttempts: 1, restoredAt: start });
    assert.equal((await registry.read(LONE))?.restoredAt, start + 2 * TAB_STAGGER_MS);
    assert.equal(await registry.read(SDK), undefined);
    assert.ok(printed.includes('Opened app-lead (continue: lead)'));
    assert.ok(printed.includes('  (/work/removed/wt is gone; opened in /work)'));
  });

  it('resumes a session that went into a worktree there, where Claude Code filed its transcript, not where it started (T1426)', async () => {
    const transcript = `${PROJECTS}/${claudeProjectSlug(WORKTREE)}/${WENT_IN}.jsonl`;
    const { deps, reopened, printed } = await world('go', undefined, [entry(WENT_IN, 3, { transcriptPath: transcript })], {
      [`${WORKTREE}/README.md`]: '',
      [transcript]: `${JSON.stringify({ type: 'assistant', cwd: WORKTREE, sessionId: WENT_IN })}\n`,
    });
    assert.deepEqual(await runRestore(deps, LOGON), { opened: 1, failed: 0 });
    assert.deepEqual(
      reopened.map(({ folder }) => folder),
      [WORKTREE],
    );
    assert.ok(printed.includes(`  (resumed in ${WORKTREE}, the folder its transcript is filed under)`), printed.join('\n'));
  });

  it('opens a session whose worktree is gone in the folder it started in', async () => {
    const transcript = `${PROJECTS}/${claudeProjectSlug(WORKTREE)}/${WENT_IN}.jsonl`;
    const { deps, reopened } = await world('go', undefined, [entry(WENT_IN, 3, { transcriptPath: transcript })], {
      [transcript]: `${JSON.stringify({ type: 'assistant', cwd: WORKTREE, sessionId: WENT_IN })}\n`,
    });
    assert.deepEqual(await runRestore(deps, LOGON), { opened: 1, failed: 0 });
    assert.deepEqual(
      reopened.map(({ folder }) => folder),
      ['/work/app'],
    );
  });

  it('reopens every session with no prompt when the person picks idle', async () => {
    const { deps, reopened, printed } = await world('idle');
    await runRestore(deps, LOGON);
    assert.deepEqual(
      reopened.map(({ prompt }) => prompt),
      [undefined, undefined, undefined],
    );
    assert.ok(printed.includes('Opened app-lead (idle)'));
  });

  it('reopens nothing when cancelled', async () => {
    const { deps, reopened, registry, logged } = await world('cancel');
    assert.deepEqual(await runRestore(deps, LOGON), { opened: 0, failed: 0 });
    assert.deepEqual(reopened, []);
    assert.equal(await attemptsOf(registry, LEAD), 0);
    assert.equal(logged.at(-1), 'run: cancelled');
  });

  it('takes the attempt back when a tab does not open or opening it throws', async () => {
    const outcomes: ReopenOutcome[] = [{ kind: 'failed', why: 'no terminal' }];
    const { deps, registry, clock, printed } = await world('go', async (tab) => {
      if (tab.claudeSession === ALPHA) {
        throw new Error('spawn EACCES');
      }
      return outcomes.shift() ?? { kind: 'opened' };
    });
    assert.deepEqual(await runRestore(deps, LOGON), { opened: 1, failed: 2 });
    assert.deepEqual(await registry.read(LEAD), LEAD_ENTRY);
    assert.deepEqual(await registry.read(ALPHA), ALPHA_ENTRY);
    assert.equal(await attemptsOf(registry, LONE), 1);
    assert.deepEqual(clock.sleeps, []);
    assert.ok(printed.includes('FAILED to reopen app-lead: no terminal'));
    assert.ok(printed.includes('FAILED to reopen app-alpha: spawn EACCES'));
  });

  it('skips a session reopened or forgotten since the plan', async () => {
    const { deps, reopened, printed } = await world('go', async (tab, self) => {
      if (tab.claudeSession === LEAD) {
        await self.registry.write({ ...ALPHA_ENTRY, updatedAt: self.clock.now() });
        await self.registry.remove(LONE);
      }
      return { kind: 'opened' };
    });
    assert.deepEqual(await runRestore(deps, LOGON), { opened: 1, failed: 0 });
    assert.deepEqual(
      reopened.map(({ claudeSession }) => claudeSession),
      [LEAD],
    );
    assert.ok(printed.includes('Skipped app-alpha (active since logon)'));
    assert.ok(printed.includes('Skipped notes (its entry is gone)'));
  });

  it('starts no countdown when nothing is to restore', async () => {
    const { deps, countdown, printed } = await world('go', undefined, [LIVE_ENTRY]);
    assert.deepEqual(await runRestore(deps, LOGON), { opened: 0, failed: 0 });
    assert.deepEqual(countdown.counted, []);
    assert.deepEqual(printed, ['No Claude Code sessions to restore.']);
  });

  it('logs when the reopening starts and ends, so a run that stopped short shows (T1439)', async () => {
    const { deps, logged, stops } = await world();
    await runRestore(deps, LOGON);
    assert.deepEqual(logged, [
      `discarded ${SDK} (not a terminal session (sdk-cli))`,
      'run: started, 3 to reopen',
      `run: opened ${LEAD} (continue: lead) at effort high`,
      `run: opened ${ALPHA} (continue: mid-turn) at effort max`,
      `run: opened ${LONE} (idle) at effort default`,
      'run: done, 3 opened, 0 skipped, 0 failed of 3',
    ]);
    assert.equal(stops.watching, 0);
  });

  it('counts the skipped and failed sessions in its last line, and says when all reopen idle', async () => {
    const { deps, logged } = await world('idle', async (tab, self) => {
      if (tab.claudeSession === LEAD) {
        await self.registry.remove(LONE);
        return { kind: 'failed', why: 'no terminal' };
      }
      return { kind: 'opened' };
    });
    await runRestore(deps, LOGON);
    assert.equal(logged[1], 'run: started, 3 to reopen, all idle');
    assert.equal(logged.at(-1), 'run: done, 1 opened, 1 skipped, 1 failed of 3');
  });

  it('logs how far it got when its tab is closed while it reopens', async () => {
    const { deps, logged, stops } = await world('go', async (tab) => {
      if (tab.claudeSession === ALPHA) {
        await stops.stop('SIGHUP');
      }
      return { kind: 'opened' };
    });
    await runRestore(deps, LOGON);
    assert.ok(logged.includes('run: interrupted by SIGHUP after 1 opened, 0 skipped, 0 failed of 3'), logged.join('\n'));
    assert.equal(stops.watching, 0);
  });

  it('logs a stop at the countdown, before anything opened', async () => {
    const { deps, logged, stops } = await world();
    const countdown = {
      choose: async (): Promise<RestoreChoice> => {
        await stops.stop('SIGINT');
        return 'cancel';
      },
    };
    await runRestore({ ...deps, countdown }, LOGON);
    assert.deepEqual(logged.slice(-2), ['run: interrupted by SIGINT at the countdown', 'run: cancelled']);
    assert.equal(stops.watching, 0);
  });

  it('stops watching when a reopen throws past it', async () => {
    const { deps, stops } = await world();
    await assert.rejects(runRestore({ ...deps, sleep: async () => Promise.reject(new Error('sleep broke')) }, LOGON), /sleep broke/);
    assert.equal(stops.watching, 0);
  });
});
