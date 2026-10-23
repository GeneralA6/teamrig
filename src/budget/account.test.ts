import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { JsonRecord } from '../core/guards.ts';
import { TimeZone } from '../core/zone.ts';
import { RegisterPolicy } from '../register/policy.ts';
import { Register, type SkillCatalog } from '../register/register.ts';
import { JsonlEventLog } from '../register/store.ts';
import { testConfig } from '../testing/config.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles, normalisePath } from '../testing/memory-files.ts';
import { accountOf, accountTeamsOf, workCacheFileOf, type AccountScope, type AccountTeamSource } from './account.ts';
import { LiftLog, type Lift } from './lift.ts';

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
  return { session, partPct, stopPct: 99, endsAt, reserve: false, quietHoursExempt: false, reason: 'ship the release', by: 'lead', at: NOW - HOUR };
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
