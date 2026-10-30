import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { nodeTreeKill } from '../delivery/tree-kill.ts';
import { isStringArray } from '../core/guards.ts';
import { SecretScanner } from '../core/secrets.ts';
import { MS_PER_MINUTE } from '../core/time.ts';
import { execRequest } from '../testing/exec-request.ts';
import { FakeCheckout, searchOf } from '../testing/fake-checkout.ts';
import { FakeExecSpawner } from '../testing/fake-exec-spawner.ts';
import { FakeClock } from '../testing/fake-clock.ts';
import { InlineMutex } from '../testing/inline-mutex.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { AuditLog, type RequestRecord, type RunOutcome } from './audit.ts';
import { sha256Hex } from './digest.ts';
import type { ExecRequest } from './request.ts';
import { decideReview, RANDOM_NONCES, UnsignedReviews, type ReviewAsk, type ReviewKit, type ReviewVerifier } from './review.ts';
import { baseEnvironment, environmentCredentials, Executor, nodeExecSpawner, type CredentialSource, type ExecResult, type SpawnAsk } from './runner.ts';

const PATH = 'C:/team/exec/audit.jsonl';
const OUT = 'C:/team/exec/out';
const START = '2030-01-07T10:00:00.000Z';
const NODE = 'C:/nodejs/node.exe';
const BASE = { SystemRoot: 'C:\\Windows', PATH: 'C:/nodejs' };
const READ_VALUE = 'db://reader@host-a/app';
const WRITE_VALUE = 'db://writer@host-a/app';
const CREDENTIALS = { DB_READ_URI: READ_VALUE, DB_WRITE_URI: WRITE_VALUE };
/** What libuv's process start on Windows copies from the parent when the given environment lacks it (`required_vars` in src/win/process.c). */
const WINDOWS_ADDED = ['HOMEDRIVE', 'HOMEPATH', 'LOGONSERVER', 'PATH', 'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'USERDOMAIN', 'USERNAME', 'USERPROFILE', 'WINDIR'];
/** What Node's spawn passes on from the parent on every platform when the given environment lacks it: the coverage folder of a coverage run. */
const NODE_ADDED = process.env['NODE_V8_COVERAGE'] === undefined ? [] : ['NODE_V8_COVERAGE'];
const KIT: ReviewKit = { reviewers: { owner: 'owner', security: 'security' }, signer: new UnsignedReviews(), nonces: RANDOM_NONCES };

function credentialsOf(values: Readonly<Record<string, string>>): CredentialSource {
  const held = new Map(Object.entries(values));
  return { get: (name) => held.get(name) };
}

interface WorldOptions {
  readonly request?: ExecRequest;
  readonly credentials?: Readonly<Record<string, string>>;
  readonly verifier?: ReviewVerifier;
}

interface World {
  readonly executor: Executor;
  readonly spawner: FakeExecSpawner;
  readonly checkout: FakeCheckout;
  readonly clock: FakeClock;
  readonly files: MemoryFiles;
  /** Decides on the request, as the security reviewer approving it unless `ask` says otherwise. */
  readonly review: (ask?: Partial<ReviewAsk>) => Promise<void>;
  readonly record: () => Promise<RequestRecord>;
}

/** An executor over a log holding `request` (the fixture R1 by default), on the fixture's bound checkout and exec PATH. */
async function world({ request = execRequest(), credentials = CREDENTIALS, verifier = new UnsignedReviews() }: WorldOptions = {}): Promise<World> {
  const clock = new FakeClock(START);
  const files = new MemoryFiles({}, clock);
  const audit = new AuditLog(PATH, files, new InlineMutex(), clock);
  const logged = await audit.append(() => ({ type: 'request', request }));
  assert.ok(logged.ok, logged.ok ? '' : logged.refusal);
  const spawner = new FakeExecSpawner();
  const checkout = new FakeCheckout();
  const executor = new Executor({
    audit,
    binding: { checkout, search: searchOf('C:/nodejs', NODE) },
    spawner,
    credentials: credentialsOf(credentials),
    verifier,
    scanner: new SecretScanner(),
    files,
    outDir: OUT,
    baseEnv: BASE,
  });
  const base: ReviewAsk = { id: request.id, decision: 'approved', reviewer: 'security', note: 'script read at the bound commit' };
  return {
    executor,
    spawner,
    checkout,
    clock,
    files,
    review: async (ask = {}) => {
      const reviewed = await audit.append((state) => decideReview(state, { ...base, ...ask }, clock.now(), KIT));
      assert.ok(reviewed.ok, reviewed.ok ? '' : reviewed.refusal);
    },
    record: async () => {
      const read = await audit.read();
      assert.ok(read.ok, read.ok ? '' : read.reason);
      const record = read.state.records.get(request.id);
      assert.ok(record !== undefined, `no record of ${request.id}`);
      return record;
    },
  };
}

function outcomeOf(result: ExecResult): RunOutcome {
  assert.ok(result.ok, result.ok ? '' : result.refusal);
  return result.outcome;
}

function refusalOf(result: ExecResult): string {
  assert.ok(!result.ok, 'expected a refusal');
  return result.refusal;
}

/** A world whose request had its dry run and was approved by the security reviewer. */
async function approved(options: WorldOptions = {}): Promise<World> {
  const w = await world(options);
  outcomeOf(await w.executor.dryRun('R1'));
  await w.review();
  return w;
}

describe('Executor.dryRun', () => {
  it('runs the dry run argv on the read variables and the base environment only, and logs it for the reviewer', async () => {
    const w = await world();
    const outcome = outcomeOf(await w.executor.dryRun('R1'));
    assert.deepEqual(w.spawner.asks, [{ program: NODE, args: ['tools/fix-models.ts'], cwd: 'C:/work/app', env: { DB_READ_URI: READ_VALUE, ...BASE }, timeoutMs: 600_000 }]);
    assert.equal(await w.files.read(join(OUT, 'R1-dry.log')), 'inserted 12\n');
    assert.deepEqual(outcome, { exitCode: 0, timedOut: false, outputSha256: sha256Hex('inserted 12\n'), outputFile: join(OUT, 'R1-dry.log'), tail: 'inserted 12' });
    assert.deepEqual((await w.record()).dryRun, { ...outcome, at: START });
  });

  it('keeps its output with the injected values and URL user parts redacted, and hashes what it kept', async () => {
    const w = await world();
    w.spawner.end = { exitCode: 0, timedOut: false, output: `read ${READ_VALUE}\nalso https://bot@host-b/x\ninserted 12\n` };
    const outcome = outcomeOf(await w.executor.dryRun('R1'));
    const kept = 'read [redacted DB_READ_URI]\nalso https://[redacted]@host-b/x\ninserted 12\n';
    assert.equal(await w.files.read(join(OUT, 'R1-dry.log')), kept);
    assert.equal(outcome.outputSha256, sha256Hex(kept));
    assert.equal(outcome.tail, kept.trimEnd());
  });

  it('refuses a checkout that differs from its binding, before anything starts or is logged', async () => {
    const w = await world();
    w.checkout.changed = [' M tools/fix-models.ts'];
    assert.match(refusalOf(await w.executor.dryRun('R1')), /1 uncommitted change/u);
    assert.deepEqual(w.spawner.asks, []);
    assert.equal((await w.record()).dryRun, undefined);
  });

  it('refuses when the executor lacks a variable the dry run reads, and names it', async () => {
    const w = await world({ credentials: { DB_WRITE_URI: WRITE_VALUE } });
    assert.match(refusalOf(await w.executor.dryRun('R1')), /needs DB_READ_URI, which the executor does not have/u);
    assert.deepEqual(w.spawner.asks, []);
  });

  it('refuses a second dry run, a request with none, and an unknown request', async () => {
    const w = await world();
    outcomeOf(await w.executor.dryRun('R1'));
    assert.match(refusalOf(await w.executor.dryRun('R1')), /already has its dry run/u);
    assert.match(refusalOf(await w.executor.dryRun('R9')), /no request R9/u);
    assert.equal(w.spawner.asks.length, 1);
    const none = await world({ request: execRequest({ dryRunArgv: null, dryRunProgram: null, preview: 'rows 1-12 of items' }) });
    assert.match(refusalOf(await none.executor.dryRun('R1')), /has no dry run/u);
    assert.deepEqual(none.spawner.asks, []);
  });
});

describe('Executor.run', () => {
  it('runs the approved argv on its named variables only, and logs its start with the approval nonce, then its end', async () => {
    const w = await approved();
    const outcome = outcomeOf(await w.executor.run('R1'));
    assert.deepEqual(w.spawner.asks[1], { program: NODE, args: ['tools/fix-models.ts', '--apply'], cwd: 'C:/work/app', env: { DB_WRITE_URI: WRITE_VALUE, ...BASE }, timeoutMs: 600_000 });
    assert.equal(outcome.outputFile, join(OUT, 'R1-run.log'));
    const { review, runStart, runEnd } = await w.record();
    assert.ok(typeof review?.nonce === 'string', 'the approval has a nonce');
    assert.deepEqual(runStart, { nonce: review.nonce, at: START });
    assert.deepEqual(runEnd, { ...outcome, at: START });
  });

  it('uses an approval once: a second run is refused and starts nothing', async () => {
    const w = await approved();
    outcomeOf(await w.executor.run('R1'));
    assert.match(refusalOf(await w.executor.run('R1')), /already ran: an approval is used once/u);
    assert.equal(w.spawner.asks.length, 2);
  });

  it('refuses a request that is not reviewed, was refused, or waits for the owner', async () => {
    const unreviewed = await world();
    outcomeOf(await unreviewed.executor.dryRun('R1'));
    assert.equal(refusalOf(await unreviewed.executor.run('R1')), 'R1 is not approved');
    const refusedOne = await world();
    outcomeOf(await refusedOne.executor.dryRun('R1'));
    await refusedOne.review({ decision: 'refused', note: 'no rollback tested' });
    assert.equal(refusalOf(await refusedOne.executor.run('R1')), 'R1 was refused by security: no rollback tested');
    const escalated = await world();
    outcomeOf(await escalated.executor.dryRun('R1'));
    await escalated.review({ decision: 'escalated', note: 'it rewrites history rows' });
    assert.equal(refusalOf(await escalated.executor.run('R1')), 'R1 is not approved: it waits for the owner');
    assert.equal(unreviewed.spawner.asks.length + refusedOne.spawner.asks.length + escalated.spawner.asks.length, 3);
  });

  it('refuses an approval whose signature does not verify', async () => {
    const w = await approved({ verifier: { verify: () => false } });
    assert.match(refusalOf(await w.executor.run('R1')), /signature is not valid/u);
    assert.equal(w.spawner.asks.length, 1);
  });

  it('refuses an expired approval when it logs the start, so nothing starts and the nonce stays unused', async () => {
    const w = await approved();
    w.clock.advance(31 * MS_PER_MINUTE);
    assert.match(refusalOf(await w.executor.run('R1')), /approval expired at/u);
    assert.equal(w.spawner.asks.length, 1);
    assert.equal((await w.record()).runStart, undefined);
  });

  it('refuses a run whose checkout moved after the approval, before it burns the nonce', async () => {
    const w = await approved();
    w.checkout.commit = 'c'.repeat(40);
    assert.match(refusalOf(await w.executor.run('R1')), /is at cccccccccccc, bound to aaaaaaaaaaaa/u);
    assert.equal(w.spawner.asks.length, 1);
    assert.equal((await w.record()).runStart, undefined);
  });

  it('refuses a run when the executor lacks a named variable, before it burns the nonce', async () => {
    const w = await approved({ credentials: { DB_READ_URI: READ_VALUE } });
    assert.match(refusalOf(await w.executor.run('R1')), /needs DB_WRITE_URI/u);
    assert.equal((await w.record()).runStart, undefined);
  });

  it('logs a run that could not start as ended, with no exit code and the reason in its tail', async () => {
    const w = await approved();
    w.spawner.end = new Error('spawn C:/nodejs/node.exe ENOENT');
    const outcome = outcomeOf(await w.executor.run('R1'));
    assert.equal(outcome.exitCode, null);
    assert.equal(outcome.tail, 'the executor could not start C:/nodejs/node.exe: spawn C:/nodejs/node.exe ENOENT');
    assert.deepEqual((await w.record()).runEnd, { ...outcome, at: START });
  });

  it('keeps a run killed at its time limit as timed out', async () => {
    const w = await approved();
    w.spawner.end = { exitCode: null, timedOut: true, output: 'inserted 5\n' };
    const outcome = outcomeOf(await w.executor.run('R1'));
    assert.deepEqual([outcome.exitCode, outcome.timedOut, outcome.tail], [null, true, 'inserted 5']);
  });

  it('never lets a named variable replace the base environment', async () => {
    const w = await approved({ request: execRequest({ envNames: ['DB_WRITE_URI', 'PATH'] }), credentials: { ...CREDENTIALS, PATH: 'C:/evil' } });
    outcomeOf(await w.executor.run('R1'));
    assert.deepEqual(w.spawner.asks[1]?.env, { DB_WRITE_URI: WRITE_VALUE, ...BASE });
  });
});

describe('nodeExecSpawner', () => {
  let dir = '';
  const spawner = nodeExecSpawner(process.platform);
  const env = baseEnvironment(dirname(process.execPath), process.env, process.platform);
  const node = (script: string, ...args: string[]): SpawnAsk => ({ program: process.execPath, args: ['-e', script, ...args], cwd: dir, env, timeoutMs: 30_000 });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'teamrig-exec-'));
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it('passes each argument as it is, with no shell to expand or split it', async () => {
    const end = await spawner.run(node('process.stdout.write(JSON.stringify(process.argv.slice(1)))', 'a "b" c', '%PATH%', '$HOME'));
    const seen: unknown = JSON.parse(end.output);
    assert.deepEqual(seen, ['a "b" c', '%PATH%', '$HOME']);
    assert.deepEqual([end.exitCode, end.timedOut], [0, false]);
  });

  it('gives the process only the environment it is given, besides the names Windows adds', async () => {
    const given = { ...env, ONLY: 'x' };
    const end = await spawner.run({ ...node('process.stdout.write(JSON.stringify(Object.keys(process.env)))'), env: given });
    const seen: unknown = JSON.parse(end.output);
    assert.ok(isStringArray(seen), end.output);
    assert.deepEqual(Object.keys(given).filter((name) => !seen.includes(name)), [], 'a given variable is missing');
    const allowed = new Set([...(process.platform === 'win32' ? WINDOWS_ADDED : []), ...NODE_ADDED]);
    assert.deepEqual(seen.filter((name) => !Object.hasOwn(given, name) && !allowed.has(name.toUpperCase())), [], 'the executor leaked a variable');
  });

  it('returns the exit code and both output streams', async () => {
    const end = await spawner.run(node('process.stdout.write("out;"); process.stderr.write("err"); process.exit(3)'));
    assert.equal(end.exitCode, 3);
    assert.match(end.output, /out;/u);
    assert.match(end.output, /err/u);
  });

  it('kills a process at its time limit and reports it timed out, with no exit code', async () => {
    const end = await spawner.run({ ...node('setInterval(() => undefined, 1000)'), timeoutMs: 500 });
    assert.deepEqual([end.exitCode, end.timedOut], [null, true]);
  });

  it('cuts output past its byte limit and says so', async () => {
    const small = nodeExecSpawner(process.platform, nodeTreeKill(process.platform), 10);
    const end = await small.run(node('process.stdout.write("x".repeat(100))'));
    assert.equal(end.output, `${'x'.repeat(10)}\n[output cut at 10 bytes]`);
  });

  it('rejects when the program cannot start', async () => {
    await assert.rejects(spawner.run({ ...node('0'), program: join(dir, 'missing.exe') }));
  });
});

describe('baseEnvironment', () => {
  it('keeps the exec PATH and, on Windows, the system and temp folders, whatever case the names have', () => {
    const env = { Path: 'C:/Windows/system32', SYSTEMROOT: 'C:\\Windows', Temp: 'C:\\t', TMP: 'C:\\t2', USERPROFILE: 'C:\\u' };
    assert.deepEqual(baseEnvironment('C:/exec', env, 'win32'), { SystemRoot: 'C:\\Windows', TEMP: 'C:\\t', TMP: 'C:\\t2', PATH: 'C:/exec' });
  });

  it('keeps only the exec PATH elsewhere', () => {
    assert.deepEqual(baseEnvironment('/exec', { PATH: '/usr/bin', HOME: '/h', TEMP: '/t' }, 'linux'), { PATH: '/exec' });
  });
});

describe('environmentCredentials', () => {
  it('reads a variable whatever its case on Windows, and only by its exact name elsewhere', () => {
    const env = { db_write_uri: 'v' };
    assert.equal(environmentCredentials(env, 'win32').get('DB_WRITE_URI'), 'v');
    assert.equal(environmentCredentials(env, 'linux').get('DB_WRITE_URI'), undefined);
    assert.equal(environmentCredentials(env, 'linux').get('db_write_uri'), 'v');
  });
});
