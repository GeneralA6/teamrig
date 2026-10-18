import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '../testing/fake-clock.ts';
import { FakeCountdown, FakeShutdownLog } from '../testing/fake-restore.ts';
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
  areaBySession: new Map(),
};

type Reopen = (tab: ReopenTab, world: World) => Promise<ReopenOutcome>;

interface World {
  readonly deps: RestoreDeps;
  readonly registry: RestoreRegistry;
  readonly clock: FakeClock;
  readonly countdown: FakeCountdown;
  readonly reopened: ReopenTab[];
  readonly printed: string[];
  readonly logged: string[];
}

async function world(choice: RestoreChoice = 'go', reopen: Reopen = async () => ({ kind: 'opened' }), entries: readonly RestoreEntry[] = ENTRIES): Promise<World> {
  const files = new MemoryFiles({
    '/work/app/README.md': '',
    [`/t/${LEAD}.jsonl`]: `${turn('high')}\n`,
    [`/t/${ALPHA}.jsonl`]: `${turn('max')}\n`,
    [`/t/${LONE}.jsonl`]: `${JSON.stringify({ type: 'custom-title', customTitle: 'notes', sessionId: LONE })}\n`,
    [`/t/${SDK}.jsonl`]: '',
    [`/t/${LIVE}.jsonl`]: '',
  });
  const probe = new MemoryPathProbe(files);
  const registry = new RestoreRegistry(files, restoreSessionsDir('/kit'));
  for (const recorded of entries) {
    await registry.write(recorded);
  }
  const clock = new FakeClock('2030-01-08T09:05:00Z');
  const countdown = new FakeCountdown(choice);
  const reopened: ReopenTab[] = [];
  const printed: string[] = [];
  const logged: string[] = [];
  const self: World = {
    registry,
    clock,
    countdown,
    reopened,
    printed,
    logged,
    deps: {
      registry,
      clock,
      sleep: clock.sleep,
      probe,
      shutdowns: new FakeShutdownLog(SHUTDOWN),
      countdown,
      teams: [APP],
      home: '/home/me',
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
        team: { team: 'app', session: 'lead', name: 'app-lead', isLead: true, terminal: 'auto', launched: true },
        effort: 'high',
        prompt: continuePrompt(NOTHING_LOST, 'app-alpha continue (mid-turn)'),
      },
      {
        claudeSession: ALPHA,
        title: 'app-alpha',
        folder: '/work/app',
        team: { team: 'app', session: 'alpha', name: 'app-alpha', isLead: false, terminal: 'auto', launched: true },
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
});
