import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { park, PARKED_FORMAT, parkedDirOf, parkedPathOf, type ParkedStep } from '../../delivery/parked.ts';
import { CliHarness, CLI_PID } from '../../testing/cli-harness.ts';
import { FakeProcesses } from '../../testing/fake-processes.ts';
import { FakeSessionProcesses } from '../../testing/fake-session-processes.ts';
import { MemoryFiles } from '../../testing/memory-files.ts';
import type { ParsedArgs } from '../args.ts';
import { EXIT, type CliRuntime, type ExitCode } from '../runtime.ts';
import { DISPATCH_POLL_MS, DISPATCHER_LOG, DISPATCHER_RECORD, dispatch, ensureDispatcher, parkStep, type StepRun } from './queue-dispatch.ts';

const DETACHED = resolve('/', 'deploys', 'detached');
const PARKED = parkedDirOf(DETACHED);
const RECORD = join(DETACHED, DISPATCHER_RECORD);

function stepOf(id: string, what: string, cwd: string, parkedAt: string): ParkedStep {
  return {
    v: PARKED_FORMAT,
    id,
    team: 'app',
    session: 'alpha',
    what,
    log: join(DETACHED, `${id}.log`),
    argv: ['queue', '--detached-run', id, '--session', 'alpha', '--what', what, '--', 'npm', 'run', what],
    cwd,
    env: { PATH: '/usr/bin', STEP: id },
    parkedAt,
  };
}

const BUILD = stepOf('20300108-100000-1', 'build', resolve('/', 'work', 'api'), '2030-01-08T10:00:00.000Z');
const TEST = stepOf('20300108-100001-2', 'test', resolve('/', 'work', 'web'), '2030-01-08T10:00:01.000Z');

/** What one run of a parked step saw: its arguments and the runtime it was given. */
interface Seen {
  readonly id: string | undefined;
  readonly cwd: string;
  readonly env: CliRuntime['env'];
}

/** A step run that records what it saw, prints a line and, when given, waits for `gate` before it ends. */
function recording(seen: Seen[], gate?: () => Promise<void>): StepRun {
  return async (args: ParsedArgs, runtime: CliRuntime): Promise<ExitCode> => {
    seen.push({ id: args.flags.get('detached-run'), cwd: runtime.cwd, env: runtime.env });
    runtime.out.stdout(`ran ${args.flags.get('what') ?? ''}`);
    await gate?.();
    return EXIT.ok;
  };
}

/** A dispatcher's lines and its end, over `files` and `sessionProcesses`. */
async function runDispatcher(kit: CliHarness, run: StepRun, options: { readonly files?: MemoryFiles; readonly sessionProcesses?: FakeSessionProcesses; readonly env?: Record<string, string> } = {}): Promise<{ code: ExitCode; lines: string[] }> {
  const lines: string[] = [];
  const runtime = kit.runtime({ ...options, env: { GH_TOKEN: 'dispatcher-token', ...options.env } }, { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });
  const code = await dispatch(runtime, DETACHED, run);
  return { code, lines };
}

describe('queue --dispatch (T4093)', () => {
  it('runs every parked step side by side, each in its own folder, environment and log, then ends with nothing parked', async () => {
    const kit = new CliHarness();
    await park(kit.files, PARKED, TEST);
    await park(kit.files, PARKED, BUILD);
    const seen: Seen[] = [];
    let release: () => void = () => undefined;
    const bothRunning = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const gate = async (): Promise<void> => {
      if (seen.length === 2) {
        release();
      }
      await bothRunning;
    };
    const { code, lines } = await runDispatcher(kit, recording(seen, gate), { env: { STEP: 'dispatcher' } });
    assert.equal(code, EXIT.ok);
    assert.deepEqual(
      seen.map(({ id, cwd, env }) => [id, cwd, env['STEP'], env['GH_TOKEN']]),
      [
        [BUILD.id, BUILD.cwd, BUILD.id, 'dispatcher-token'],
        [TEST.id, TEST.cwd, TEST.id, 'dispatcher-token'],
      ],
      'oldest first, the second started while the first still ran, each with its own environment and the credentials added back',
    );
    assert.deepEqual([kit.files.get(BUILD.log), kit.files.get(TEST.log)], ['ran build\n', 'ran test\n']);
    assert.deepEqual(lines, [`dispatcher pid ${CLI_PID} for ${DETACHED}`, `running parked step ${BUILD.id}: build`, `running parked step ${TEST.id}: test`, 'dispatcher ends: nothing parked or running']);
    assert.deepEqual([kit.files.get(RECORD), await kit.files.list(PARKED)], [undefined, []]);
  });

  it("writes a step's refusal or failure to its log and runs on", async () => {
    const kit = new CliHarness();
    await park(kit.files, PARKED, { ...BUILD, argv: ['status'] });
    const { code } = await runDispatcher(kit, recording([]));
    assert.equal(code, EXIT.ok);
    await park(kit.files, PARKED, { ...TEST, argv: ['queue', '--what', 'test', '--', 'npm', 'test'] });
    const { code: second } = await runDispatcher(kit, recording([]));
    assert.equal(second, EXIT.ok);
    assert.match(kit.files.get(BUILD.log) ?? '', /^FAILED .+\n$/);
    assert.equal(kit.files.get(TEST.log), 'FAILED a parked step runs only a detached queue run: queue --what test -- npm test\n');
  });

  it('ends at once when another live dispatcher holds the folder', async () => {
    const kit = new CliHarness();
    await park(kit.files, PARKED, BUILD);
    await kit.files.write(RECORD, JSON.stringify({ pid: 5100, startedAt: '2030-01-08T09:00:00.000Z' }));
    const sessionProcesses = new FakeSessionProcesses().add({ pid: 5100, parentPid: 1, name: 'node', commandLine: 'node main.js queue --dispatch' });
    const seen: Seen[] = [];
    const { lines } = await runDispatcher(kit, recording(seen), { sessionProcesses });
    assert.deepEqual([lines, seen.length, kit.files.get(parkedPathOf(PARKED, BUILD.id)) !== undefined], [[`a dispatcher already runs for ${DETACHED}`], 0, true]);
  });

  for (const [label, sessionProcesses] of [
    ['a dead dispatcher', new FakeSessionProcesses()],
    ["a process that took a dead dispatcher's pid", new FakeSessionProcesses().add({ pid: 5100, parentPid: 1, name: 'node', commandLine: 'node build.js' })],
  ] as const) {
    it(`takes the folder over from ${label}'s record`, async () => {
      const kit = new CliHarness();
      await park(kit.files, PARKED, BUILD);
      await kit.files.write(RECORD, JSON.stringify({ pid: 5100, startedAt: '2030-01-08T09:00:00.000Z' }));
      const seen: Seen[] = [];
      await runDispatcher(kit, recording(seen), { sessionProcesses });
      assert.deepEqual(seen.map(({ id }) => id), [BUILD.id]);
    });
  }

  it('names a file that is no parked step once, leaves it, and still ends', async () => {
    const kit = new CliHarness();
    const torn = parkedPathOf(PARKED, '20300108-095900-9');
    await kit.files.write(torn, '{"v":1,');
    await park(kit.files, PARKED, BUILD);
    const { lines } = await runDispatcher(kit, recording([]));
    assert.deepEqual(lines.filter((line) => line.startsWith('left ')), [`left ${torn}: it is no parked step`]);
    assert.equal(kit.files.get(torn), '{"v":1,');
    assert.equal(lines.at(-1), 'dispatcher ends: nothing parked or running');
  });

  it('holds the folder again for a step parked after it gave up its record, so no step is left unrun', async () => {
    const kit = new CliHarness();
    const files = new ParkOnFirstRemove(kit, RECORD, TEST);
    await park(files, PARKED, BUILD);
    const seen: Seen[] = [];
    const { lines } = await runDispatcher(kit, recording(seen), { files });
    assert.deepEqual(seen.map(({ id }) => id), [BUILD.id, TEST.id]);
    assert.deepEqual([lines.at(-1), files.get(RECORD)], ['dispatcher ends: nothing parked or running', undefined]);
  });

  it('looks for newly parked steps every poll while a step runs', async () => {
    const kit = new CliHarness();
    await park(kit.files, PARKED, BUILD);
    const seen: Seen[] = [];
    const start = kit.clock.now();
    let parkedLater = false;
    const gate = async (): Promise<void> => {
      if (!parkedLater) {
        parkedLater = true;
        await park(kit.files, PARKED, TEST);
        await kit.clock.sleep(DISPATCH_POLL_MS * 3);
      }
    };
    await runDispatcher(kit, recording(seen, gate));
    assert.deepEqual(seen.map(({ id }) => id), [BUILD.id, TEST.id]);
    assert.ok(kit.clock.now() - start >= DISPATCH_POLL_MS);
  });
});

describe('parking a step (T4093)', () => {
  it('parks the step and starts a hidden dispatcher with the whole environment in memory', async () => {
    const kit = new CliHarness();
    const processes = new FakeProcesses();
    await parkStep(kit.runtime({ processes, env: { GH_TOKEN: 'parker-token' } }), DETACHED, BUILD);
    assert.equal(kit.files.get(parkedPathOf(PARKED, BUILD.id)) !== undefined, true);
    const [hidden] = processes.hidden;
    assert.deepEqual([processes.hidden.length, hidden?.args, hidden?.log, hidden?.env['GH_TOKEN']], [1, ['/opt/teamrig/dist/cli/main.js', 'queue', '--dispatch'], join(DETACHED, DISPATCHER_LOG), 'parker-token']);
  });

  it('starts no second dispatcher while one runs', async () => {
    const kit = new CliHarness();
    await kit.files.write(RECORD, JSON.stringify({ pid: 5100, startedAt: '2030-01-08T09:00:00.000Z' }));
    const processes = new FakeProcesses();
    const sessionProcesses = new FakeSessionProcesses().add({ pid: 5100, parentPid: 1, name: 'node', commandLine: '' });
    assert.equal(await ensureDispatcher(kit.runtime({ processes, sessionProcesses }), DETACHED), undefined);
    assert.deepEqual(processes.hidden, [], "a process whose command line the system hides is taken for the record's");
  });

  it('takes the step back and refuses when no dispatcher starts', async () => {
    const kit = new CliHarness();
    const processes = new FakeProcesses().onStart('/usr/bin/node', { kind: 'failed', error: 'spawn EPERM' });
    await assert.rejects(parkStep(kit.runtime({ processes }), DETACHED, BUILD), /build did not start detached: spawn EPERM/);
    assert.deepEqual(await kit.files.list(PARKED), []);
  });
});

/** Files where the first removal of `record` parks `step` right after, as a parker landing after the dispatcher's last look. */
class ParkOnFirstRemove extends MemoryFiles {
  private parked = false;
  private readonly record: string;
  private readonly step: ParkedStep;

  constructor(kit: CliHarness, record: string, step: ParkedStep) {
    super({}, kit.clock);
    this.record = record;
    this.step = step;
  }

  override async remove(path: string): Promise<boolean> {
    const removed = await super.remove(path);
    if (path === this.record && !this.parked) {
      this.parked = true;
      await park(this, PARKED, this.step);
    }
    return removed;
  }
}
