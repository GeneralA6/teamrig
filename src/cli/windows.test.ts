import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { CliHarness, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { MAIN_CHECKOUT } from '../testing/fake-merge-git.ts';
import { EXIT } from './runtime.ts';

const LEDGER = join(TEAM_HOME, 'state', 'deploys', 'ledger.jsonl');
const LEDGER_MD = join(TEAM_HOME, 'state', 'deploys', 'ledger.md');
const DEPLOYING = {
  ...TEAM,
  delivery: {
    stablePeriods: { targetSettleMinutes: { 'cloud-web': 10 } },
    repos: { app: { mainCheckout: MAIN_CHECKOUT, deploysOnPush: ['cloud-api', 'cloud-web'] } },
  },
};

/** A deploy of app at 07:00 by alpha, with no record of its start; a queued step 08:00 to 08:20. The clock is at 10:00. */
async function ledgered(kit: CliHarness): Promise<void> {
  await kit.files.append(LEDGER_MD, '- 2030-01-08 07:00 | alpha | app | 1a2b3c4d | app | deploy | pushed\n');
  const heavy = { type: 'heavy', id: 'h1', session: 'alpha', what: 'tests', startedAt: '2030-01-08T08:00:00.000Z', endedAt: null, exitCode: null };
  await kit.files.append(LEDGER, `${JSON.stringify(heavy)}\n${JSON.stringify({ ...heavy, endedAt: '2030-01-08T08:20:00.000Z', exitCode: 0 })}\n`);
}

describe('teamrig stable-periods', () => {
  it('lists each target’s stable periods, with its settle time and the loads each overlaps', async () => {
    const kit = new CliHarness(DEPLOYING);
    await ledgered(kit);
    assert.equal((await kit.run(['load', '--session', 'bravo', '--what', 'db trim', '--at', '08:30'])).code, 0);
    assert.deepEqual(await kit.run(['stable-periods', '--targets', 'cloud-api,cloud-web', '--since', '06:00']), {
      code: 0,
      stdout: [
        'cloud-api (settle 30m): 3 stable periods of at least 15m',
        '  2030-01-08 06:00 UTC to 2030-01-08 06:40 UTC (40m)',
        '  2030-01-08 07:30 UTC to 2030-01-08 08:00 UTC (30m)',
        '  2030-01-08 08:20 UTC to 2030-01-08 10:00 UTC (1h40m)',
        '    under load id-1 by bravo: db trim (from 2030-01-08 08:30 UTC, still running)',
        'cloud-web (settle 10m): 3 stable periods of at least 15m',
        '  2030-01-08 06:00 UTC to 2030-01-08 06:40 UTC (40m)',
        '  2030-01-08 07:10 UTC to 2030-01-08 08:00 UTC (50m)',
        '  2030-01-08 08:20 UTC to 2030-01-08 10:00 UTC (1h40m)',
        '    under load id-1 by bravo: db trim (from 2030-01-08 08:30 UTC, still running)',
      ],
      stderr: [],
    });
  });

  it('takes --settle for every target, --min and an --until cut to now', async () => {
    const kit = new CliHarness(DEPLOYING);
    await ledgered(kit);
    assert.deepEqual(await kit.run(['stable-periods', '--targets', 'cloud-web', '--since', '2030-01-08', '--until', '2030-01-09', '--settle', '1h', '--min', '1h']), {
      code: 0,
      stdout: ['cloud-web (settle 1h00m): 2 stable periods of at least 1h00m', '  2030-01-08 00:00 UTC to 2030-01-08 06:40 UTC (6h40m)', '  2030-01-08 08:20 UTC to 2030-01-08 10:00 UTC (1h40m)'],
      stderr: [],
    });
    assert.deepEqual((await kit.run(['stable-periods', '--targets', 'cloud-web', '--since', '07:00', '--until', '07:30', '--settle', '1h'])).stdout, [
      'cloud-web (settle 1h00m): no stable period of at least 15m',
    ]);
  });

  it('is a usage error for a target no repository deploys, a time it cannot read and an empty span', async () => {
    const kit = new CliHarness(DEPLOYING);
    for (const [flags, expected] of [
      [['--targets', 'db', '--since', '06:00'], '--targets: db is not a deploy target of this team (known: cloud-api, cloud-web)'],
      [['--targets', 'cloud-api', '--since', 'morning'], '--since "morning" is not a time'],
      [['--targets', 'cloud-api', '--since', '09:00', '--until', '08:00'], '--since 2030-01-08 09:00 UTC is not before --until (2030-01-08 08:00 UTC)'],
      [['--targets', 'cloud-api', '--since', '06:00', '--min', '5s'], '--min "5s" is not a span'],
    ] as const) {
      const result = await kit.run(['stable-periods', ...flags]);
      assert.equal(result.code, 64, JSON.stringify(result));
      assert.ok([...result.stdout, ...result.stderr].some((line) => line.includes(expected)), JSON.stringify(result));
    }
  });

  it('refuses teamrig windows, its old name, with the new one and exit 64', async () => {
    const kit = new CliHarness(DEPLOYING);
    await ledgered(kit);
    const result = await kit.run(['windows', '--targets', 'cloud-api', '--since', '06:00']);
    assert.deepEqual([result.code, result.stdout, result.stderr[0]?.split('\n')[0]], [EXIT.usage, [], 'windows was renamed: use stable-periods']);
  });
});

describe('teamrig load', () => {
  it('declares a load on the whole host or on its targets, and ends it', async () => {
    const kit = new CliHarness(DEPLOYING);
    assert.deepEqual(await kit.run(['load', '--session', 'alpha', '--what', 'backfill', '--at', '09:00']), {
      code: 0,
      stdout: ['LOAD id-1 on the whole host from 2030-01-08 09:00 UTC (end it: teamrig load end --id id-1)'],
      stderr: [],
    });
    assert.deepEqual((await kit.run(['load', '--session', 'bravo', '--what', 'reindex', '--targets', 'cloud-api'])).stdout, [
      'LOAD id-2 on cloud-api from 2030-01-08 10:00 UTC (end it: teamrig load end --id id-2)',
    ]);
    assert.deepEqual(await kit.run(['load', 'end', '--session', 'alpha', '--id', 'id-1', '--at', '09:45']), { code: 0, stdout: ['ENDED id-1 at 2030-01-08 09:45 UTC'], stderr: [] });
    const records = (kit.files.get(LEDGER) ?? '').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(records, [
      { type: 'load', id: 'id-1', session: 'alpha', what: 'backfill', targets: 'host', startedAt: '2030-01-08T09:00:00.000Z', endedAt: null },
      { type: 'load', id: 'id-2', session: 'bravo', what: 'reindex', targets: ['cloud-api'], startedAt: '2030-01-08T10:00:00.000Z', endedAt: null },
      { type: 'load', id: 'id-1', session: 'alpha', what: 'backfill', targets: 'host', startedAt: '2030-01-08T09:00:00.000Z', endedAt: '2030-01-08T09:45:00.000Z' },
    ]);
  });

  it('refuses a target no repository deploys, a future start, another session’s load and an ended one', async () => {
    const kit = new CliHarness(DEPLOYING);
    assert.deepEqual(await kit.run(['load', '--session', 'alpha', '--what', 'trim', '--targets', 'db']), {
      code: 2,
      stdout: ['REFUSED db is not a deploy target of this team (known: cloud-api, cloud-web, host)'],
      stderr: [],
    });
    assert.deepEqual((await kit.run(['load', '--session', 'alpha', '--what', 'trim', '--at', '11:00'])).stdout, ['REFUSED a load cannot start in the future (2030-01-08 11:00 UTC)']);
    assert.equal(kit.files.get(LEDGER), undefined, 'nothing is written');
    assert.equal((await kit.run(['load', '--session', 'alpha', '--what', 'trim'])).code, 0);
    assert.deepEqual((await kit.run(['load', 'end', '--session', 'bravo', '--id', 'id-1'])).stdout, ['REFUSED load "id-1" belongs to alpha']);
    assert.equal((await kit.run(['load', 'end', '--session', 'alpha', '--id', 'id-1'])).code, 0);
    assert.deepEqual(await kit.run(['load', 'end', '--session', 'alpha', '--id', 'id-1']), { code: 2, stdout: ['REFUSED no open load "id-1"'], stderr: [] });
  });
});
