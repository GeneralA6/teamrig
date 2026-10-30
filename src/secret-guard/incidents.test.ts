import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { NewerDataError } from '../core/jsonl.ts';
import { TimeZone } from '../core/zone.ts';
import { fieldPaths } from '../testing/field-paths.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { filedToday, SECRET_INCIDENTS_FORMAT, SecretIncidentLog, type SecretIncident } from './incidents.ts';

const PATH = '/team/state/secret-incidents.jsonl';
const FILED: SecretIncident = {
  at: '2030-01-08T10:00:00.000Z',
  session: 'alpha',
  tool: 'Bash',
  toolUseId: 'toolu_01',
  transcript: join('/', 'projects', 'app', 'session.jsonl'),
  agent: 'a1b2',
  kind: 'GitHub token',
  accounts: ['login app at github.com'],
  task: 'T12',
};
const UNKNOWN: SecretIncident = { at: '2030-01-08T10:05:00.000Z', tool: 'Read', kind: 'GitHub token' };

function zoneOf(name: string): TimeZone {
  const zone = TimeZone.of(name);
  assert.ok(zone, `${name} is a known zone`);
  return zone;
}

describe('the secret incident log', () => {
  it('reads back what it wrote, oldest first, with and without a session and a task', async () => {
    const files = new MemoryFiles();
    const log = new SecretIncidentLog(files, PATH);
    await log.append(FILED);
    await log.append(UNKNOWN);
    assert.deepEqual(await log.read(), { incidents: [FILED, UNKNOWN], skipped: 0 });
    assert.equal(files.get(PATH)?.split('\n')[0], JSON.stringify({ v: SECRET_INCIDENTS_FORMAT, ...FILED }));
  });

  it('writes the pinned fields of its format, and never a value: a field added raises SECRET_INCIDENTS_FORMAT', async () => {
    const written: Readonly<Record<number, readonly string[]>> = {
      1: ['at', 'kind', 'session', 'task', 'tool', 'v'],
      2: ['agent', 'at', 'kind', 'session', 'task', 'tool', 'toolUseId', 'transcript', 'v'],
      3: ['accounts[]', 'agent', 'at', 'kind', 'session', 'task', 'tool', 'toolUseId', 'transcript', 'v'],
    };
    const files = new MemoryFiles();
    await new SecretIncidentLog(files, PATH).append(FILED);
    const line: unknown = JSON.parse(files.get(PATH) ?? '');
    assert.deepEqual(fieldPaths(line), written[SECRET_INCIDENTS_FORMAT]);
  });

  it("reads format 1 and 2 lines, from before the call's fields and the accounts, and appends the current format beside them", async () => {
    const files = new MemoryFiles();
    const old: SecretIncident = { at: '2030-01-08T09:00:00.000Z', session: 'alpha', tool: 'Read', kind: 'GitHub token', task: 'T11' };
    const { accounts, ...noAccounts } = FILED;
    assert.ok(accounts !== undefined);
    await files.write(PATH, `${JSON.stringify({ v: 1, ...old })}\n${JSON.stringify({ v: 2, ...noAccounts })}\n`);
    const log = new SecretIncidentLog(files, PATH);
    await log.append(FILED);
    assert.deepEqual(await log.read(), { incidents: [old, noAccounts, FILED], skipped: 0 });
    assert.equal(files.get(PATH)?.split('\n')[2], JSON.stringify({ v: SECRET_INCIDENTS_FORMAT, ...FILED }));
  });

  it('reads accounts that are not a list of strings as none', async () => {
    const files = new MemoryFiles();
    await files.write(PATH, `${JSON.stringify({ v: SECRET_INCIDENTS_FORMAT, ...UNKNOWN, accounts: 'login app at github.com' })}\n`);
    assert.deepEqual(await new SecretIncidentLog(files, PATH).read(), { incidents: [UNKNOWN], skipped: 0 });
  });

  it('skips damaged lines and lines from a newer teamrig, and starts a line after a torn last one', async () => {
    const files = new MemoryFiles();
    const damaged = JSON.stringify({ v: SECRET_INCIDENTS_FORMAT, ...FILED, at: 'yesterday' });
    const noKind = JSON.stringify({ v: SECRET_INCIDENTS_FORMAT, at: FILED.at, tool: 'Bash' });
    await files.write(PATH, `${damaged}\nnot json\n${noKind}\n${JSON.stringify({ v: SECRET_INCIDENTS_FORMAT, ...UNKNOWN })}`);
    const log = new SecretIncidentLog(files, PATH);
    assert.deepEqual(await log.read(), { incidents: [UNKNOWN], skipped: 3 });
    await log.append(FILED);
    assert.deepEqual((await log.read()).incidents, [UNKNOWN, FILED]);
  });

  it('refuses a write beside a newer format, which it skips on read', async () => {
    const files = new MemoryFiles();
    await files.write(PATH, `${JSON.stringify({ v: SECRET_INCIDENTS_FORMAT + 1, ...FILED })}\n`);
    const log = new SecretIncidentLog(files, PATH);
    assert.deepEqual(await log.read(), { incidents: [], skipped: 1 });
    await assert.rejects(log.append(UNKNOWN), NewerDataError);
  });

  it('reads a missing log as empty', async () => {
    assert.deepEqual(await new SecretIncidentLog(new MemoryFiles(), PATH).read(), { incidents: [], skipped: 0 });
  });
});

describe('filedToday', () => {
  const utc = TimeZone.UTC;

  it("finds the newest task of the session's same kind that day", () => {
    const later: SecretIncident = { ...FILED, at: '2030-01-08T11:00:00.000Z', task: 'web/T40' };
    assert.equal(filedToday([FILED, later], 'GitHub token', 'alpha', new Date('2030-01-08T23:59:00Z'), utc), 'web/T40');
  });

  it('finds none for another kind, another session, an incident with no task, or another day', () => {
    const noTask: SecretIncident = { at: '2030-01-09T09:00:00.000Z', session: 'alpha', tool: 'Bash', kind: 'GitHub token' };
    const now = new Date('2030-01-09T10:00:00Z');
    assert.equal(filedToday([FILED, noTask], 'GitHub token', 'alpha', now, utc), undefined);
    assert.equal(filedToday([FILED], 'Slack token', 'alpha', new Date(FILED.at), utc), undefined);
    assert.equal(filedToday([FILED], 'GitHub token', 'bravo', new Date(FILED.at), utc), undefined);
    assert.equal(filedToday([UNKNOWN], 'GitHub token', 'alpha', new Date(UNKNOWN.at), utc), undefined);
  });

  it("counts the day on the team's clock, not UTC's", () => {
    const lateUtc: SecretIncident = { ...FILED, at: '2030-01-08T22:30:00.000Z' };
    const nextMorningUtc = new Date('2030-01-09T01:00:00Z');
    assert.equal(filedToday([lateUtc], 'GitHub token', 'alpha', nextMorningUtc, zoneOf('Asia/Jerusalem')), 'T12');
    assert.equal(filedToday([lateUtc], 'GitHub token', 'alpha', nextMorningUtc, utc), undefined);
  });
});
