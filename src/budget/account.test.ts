import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Roster } from '../config/roster.ts';
import { TeamTree, teamNodeOf, type TeamNode } from '../config/tree.ts';
import type { JsonRecord } from '../core/guards.ts';
import { TimeZone } from '../core/zone.ts';
import { OWN_NUMBERS } from '../register/numbering.ts';
import { RegisterPolicy } from '../register/policy.ts';
import { NOTHING_ELSEWHERE, Register, type SkillCatalog } from '../register/register.ts';
import { JsonlEventLog } from '../register/store.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles, normalisePath } from '../testing/memory-files.ts';
import { accountHolderOf, accountOf, accountTeamsOf, accountWeekOf, workCacheFileOf, type AccountScope, type AccountTeamSource, type SnapshotDirSource } from './account.ts';
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
    elsewhere: NOTHING_ELSEWHERE,
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

describe('accountHolderOf', () => {
  /** A team led by `lead`, under `parent` when given. */
  function node(team: string, parent?: string): TeamNode {
    const config = testConfig({ sessions: ['lead'], team: parent === undefined ? { id: team } : { id: team, parent } });
    return teamNodeOf(team, config, new Roster(config, team));
  }

  /** `app` at the root, `web` under it, `ui` under `web`; `lab` a root of its own. */
  const TREE = new TeamTree([node('app'), node('web', 'app'), node('ui', 'web'), node('lab')]);
  const onOne = (): string => CONFIG_DIR;

  it('is the highest team above it on its account, through every level', () => {
    assert.equal(accountHolderOf(TREE, 'ui', CONFIG_DIR, onOne), 'app');
    assert.equal(accountHolderOf(TREE, 'web', CONFIG_DIR, onOne), 'app');
  });

  it('is the team itself at a root, and for a separate tree on the same account', () => {
    assert.equal(accountHolderOf(TREE, 'app', CONFIG_DIR, onOne), 'app');
    assert.equal(accountHolderOf(TREE, 'lab', CONFIG_DIR, onOne), 'lab');
  });

  it('stops below the first team above on another account, or with no config', () => {
    const appElsewhere = (team: string): string | undefined => (team === 'app' ? 'home' : CONFIG_DIR);
    assert.equal(accountHolderOf(TREE, 'ui', CONFIG_DIR, appElsewhere), 'web');
    assert.equal(accountHolderOf(TREE, 'web', CONFIG_DIR, appElsewhere), 'web');
    const webElsewhere = (team: string): string | undefined => (team === 'web' ? 'home' : CONFIG_DIR);
    assert.equal(accountHolderOf(TREE, 'ui', CONFIG_DIR, webElsewhere), 'ui', "app is on ui's account, but the chain to it leaves it at web");
    assert.equal(accountHolderOf(TREE, 'ui', CONFIG_DIR, (team) => (team === 'web' ? undefined : CONFIG_DIR)), 'ui');
  });

  it('is the team itself when its parents go round a loop', () => {
    const loop = new TeamTree([node('a', 'b'), node('b', 'a')]);
    assert.equal(accountHolderOf(loop, 'a', CONFIG_DIR, () => CONFIG_DIR), 'a');
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
        ['web', ['lead', 'front', 'back'], { front: { share: 2 } }, [['front', new Map([[1, 5]])]], [['back', 40]]],
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

    assert.deepEqual([[...(only?.work ?? [])], [...(only?.lifted ?? [])]], [[['front', new Map([[1, 5]])]], []]);
  });

  it("lets a short day pause another team's sessions by its own config, never its lead or delivery owner", async () => {
    const teams = new Map([
      ['ui', sourceOf('ui')],
      ['web', sourceOf('web', { budget: { pauseByPriority: true }, roles: { lead: 'lead', deliveryOwner: 'back' } })],
    ]);

    const others = await accountTeamsOf(new MemoryFiles(), teams, SCOPE);

    assert.deepEqual(others.map((split) => [split.team, [...split.pausable]]), [['ui', []], ['web', ['front']]]);
  });

  it('finds no other team when the kit home holds only the asking one', async () => {
    assert.deepEqual(await accountTeamsOf(new MemoryFiles(), new Map([['app', sourceOf('app')]]), SCOPE), []);
  });
});

describe('accountWeekOf', () => {
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

    const fold = await accountWeekOf(files, teams, OWN, SCOPE);

    assert.equal(fold.best?.usedPct, 46, "ops's 80 is on another account; ui and web share the kit's folder");
  });

  it("skips another team's folder that cannot be read, and fails on its own", async () => {
    const memory = new MemoryFiles();
    await save(memory, OWN, ALPHA, 40);
    const qa = join('/', 'qa-live');
    const teams = new Map([['qa', dirSourceOf('qa', { statusSnapshotDir: qa })]]);

    const others = new FaultyFiles(memory).fail('list', qa, systemError('EACCES'));
    assert.equal((await accountWeekOf(others, teams, OWN, SCOPE)).best?.usedPct, 40);

    const own = new FaultyFiles(memory).fail('list', OWN, systemError('EACCES'));
    await assert.rejects(accountWeekOf(own, teams, OWN, SCOPE), /EACCES/);
  });
});
