import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { TimeZone } from '../core/zone.ts';
import { OWN_NUMBERS } from '../register/numbering.ts';
import { RegisterPolicy } from '../register/policy.ts';
import { Register, type SkillCatalog } from '../register/register.ts';
import { JsonlEventLog } from '../register/store.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles, normalisePath } from '../testing/memory-files.ts';
import { accountOf, accountSnapshotsOf, accountTeamsOf, workCacheFileOf, type AccountScope, type AccountTeamSource, type SnapshotDirSource } from './account.ts';
import { LiftLog, type Lift } from './lift.ts';
import { formatSnapshot, snapshotOfStatus } from './snapshot.ts';

const CONFIG_DIR = join('/', 'u', '.claude');
const NOW = Date.parse('2030-01-07T10:00:00Z');
const HOUR = 3_600_000;

function stateOf(team: string): string {
  return join('/', 'kit', 'teams', team, 'state');
}

function sourceOf(team: string, extra: JsonRecord = {}): AccountTeamSource {
  const config = testConfig({ team: { id: team }, sessions: ['lead', 'front', 'back'], ...extra });
  return {
    kit: { paths: { events: join(stateOf(team), 'events.jsonl'), lifts: join(stateOf(team), 'usage', 'lifts.jsonl') } },
    config,
    roster: { ids: config.sessions },
  };
}

const SCOPE: AccountScope = { team: 'app', account: CONFIG_DIR, configDir: CONFIG_DIR, usageDir: join(stateOf('app'), 'usage'), now: NOW, usedPct: 40 };

class NoSkills implements SkillCatalog {
  async exists(): Promise<boolean> {
    return false;
  }
}

/** An open task for `owner` in the register at `eventsPath`. */
async function addTask(files: MemoryFiles, eventsPath: string, owner: string, priority: number): Promise<void> {
  const register = new Register({
    log: new JsonlEventLog(files, eventsPath),
    mutex: new InlineMutex(),
    numbering: OWN_NUMBERS,
    clock: new FakeClock('2030-01-07T09:00:00.000Z'),
    policy: new RegisterPolicy(testConfig({ sessions: ['lead', 'front', 'back'] })),
    skills: new NoSkills(),
    zone: TimeZone.UTC,
    autoArchive: false,
  });
  const verdict = await register.add('lead', { title: `Ship ${owner}`, description: 'what and why', owner, source: 'lead', priority });
  assert.ok(verdict.ok, verdict.ok ? '' : verdict.error);
}

function liftFor(session: string, partPct: number, endsAt: number): Lift {
  return { session, group: false, partPct, stopPct: 99, endsAt, reserve: false, quietHoursExempt: false, reason: 'ship the release', by: 'lead', at: NOW - HOUR };
}

describe('accountOf', () => {
  it("takes the team's account, else the Claude config dir", () => {
    assert.equal(accountOf({ account: 'work' }, CONFIG_DIR), 'work');
    assert.equal(accountOf({}, CONFIG_DIR), CONFIG_DIR);
  });
});

describe('accountTeamsOf', () => {
  it('reads the other teams on the account with their shares, lifts in force and queued work', async () => {
    const files = new MemoryFiles();
    const web = sourceOf('web', { budget: { sessions: { front: { share: 2 } } } });
    await addTask(files, web.kit.paths.events, 'front', 1);
    const lifts = new LiftLog(files, web.kit.paths.lifts);
    await lifts.append(liftFor('back', 40, NOW + HOUR));
    await lifts.append(liftFor('front', 30, NOW - 1));
    const teams = new Map([
      ['app', sourceOf('app')],
      ['ops', sourceOf('ops', { budget: { account: 'home' } })],
      ['ui', sourceOf('ui', { budget: { account: CONFIG_DIR } })],
      ['web', web],
    ]);

    const others = await accountTeamsOf(files, teams, SCOPE);

    assert.deepEqual(
      others.map((split) => [split.team, split.ids, split.sessions, [...split.work], [...split.lifted]]),
      [
        ['ui', ['lead', 'front', 'back'], {}, [], []],
        ['web', ['lead', 'front', 'back'], { front: { share: 2 } }, [['front', 5]], [['back', 40]]],
      ],
    );
  });

  it("keeps the other teams' work caches in its own usage folder and writes nothing in theirs", async () => {
    const files = new MemoryFiles();
    const web = sourceOf('web');
    await addTask(files, web.kit.paths.events, 'back', 2);
    const before = new Set(files.paths());

    await accountTeamsOf(files, new Map([['web', web]]), SCOPE);

    const written = files.paths().filter((path) => !before.has(path));
    assert.deepEqual(written, [normalisePath(join(SCOPE.usageDir, workCacheFileOf('web')))]);
  });

  it('holds no lift for a team whose lift log cannot be read, and still weighs its work', async () => {
    const memory = new MemoryFiles();
    const web = sourceOf('web');
    await addTask(memory, web.kit.paths.events, 'front', 1);
    await new LiftLog(memory, web.kit.paths.lifts).append(liftFor('back', 40, NOW + HOUR));
    const files = new FaultyFiles(memory).fail('read', web.kit.paths.lifts, systemError('EACCES'));

    const [only] = await accountTeamsOf(files, new Map([['web', web]]), SCOPE);

    assert.deepEqual([[...(only?.work ?? [])], [...(only?.lifted ?? [])]], [[['front', 5]], []]);
  });

  it('finds no other team when the kit home holds only the asking one', async () => {
    assert.deepEqual(await accountTeamsOf(new MemoryFiles(), new Map([['app', sourceOf('app')]]), SCOPE), []);
  });
});

describe('accountSnapshotsOf', () => {
  const KIT_HOME = join('/', 'kit');
  const OWN = join(KIT_HOME, 'teams', 'app', 'live');
  const ALPHA = '0000000a-0000-4000-8000-000000000001';
  const BRAVO = '0000000b-0000-4000-8000-000000000002';
  const CHARLIE = '0000000c-0000-4000-8000-000000000003';
  const DELTA = '0000000d-0000-4000-8000-000000000004';

  function dirSourceOf(team: string, budget: SnapshotDirSource['config']['budget'] = {}): SnapshotDirSource {
    return { kit: { paths: { home: join(KIT_HOME, 'teams', team), kitHome: KIT_HOME } }, config: { budget } };
  }

  /** A snapshot a tab saved in `dir`: the week `usedPct` used. */
  async function save(files: MemoryFiles, dir: string, session: string, usedPct: number): Promise<void> {
    const input = JSON.stringify({ session_id: session, rate_limits: { seven_day: { used_percentage: usedPct, resets_at: NOW / 1000 + 86_400 } } });
    const snapshot = snapshotOfStatus(input, NOW);
    assert.ok(snapshot, input);
    await files.write(join(dir, `${session}.json`), formatSnapshot(snapshot));
  }

  it("reads its own folder first, then each other team's on its account once, and no team's on another account", async () => {
    const files = new MemoryFiles();
    await save(files, OWN, ALPHA, 40);
    await save(files, join('/', 'ops-live'), BRAVO, 80);
    await save(files, join('/', 'qa-live'), CHARLIE, 45);
    await save(files, join(KIT_HOME, 'usage', 'live'), DELTA, 46);
    const teams = new Map([
      ['app', dirSourceOf('app', { statusSnapshotDir: 'live' })],
      ['ops', dirSourceOf('ops', { account: 'home', statusSnapshotDir: join('/', 'ops-live') })],
      ['qa', dirSourceOf('qa', { account: CONFIG_DIR, statusSnapshotDir: join('/', 'qa-live') })],
      ['ui', dirSourceOf('ui')],
      ['web', dirSourceOf('web')],
    ]);

    const snapshots = await accountSnapshotsOf(files, teams, OWN, SCOPE);

    assert.deepEqual(
      snapshots.map((snapshot) => snapshot.sessionId),
      [ALPHA, CHARLIE, DELTA],
    );
  });

  it("skips another team's folder that cannot be read, and fails on its own", async () => {
    const memory = new MemoryFiles();
    await save(memory, OWN, ALPHA, 40);
    const qa = join('/', 'qa-live');
    const teams = new Map([['qa', dirSourceOf('qa', { statusSnapshotDir: qa })]]);

    const others = new FaultyFiles(memory).fail('list', qa, systemError('EACCES'));
    assert.deepEqual(
      (await accountSnapshotsOf(others, teams, OWN, SCOPE)).map((snapshot) => snapshot.sessionId),
      [ALPHA],
    );

    const own = new FaultyFiles(memory).fail('list', OWN, systemError('EACCES'));
    await assert.rejects(accountSnapshotsOf(own, teams, OWN, SCOPE), /EACCES/);
  });
});
