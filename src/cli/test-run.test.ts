import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { HELD_OPEN_LINE } from '../test-run/logs.ts';
import { APP, CliHarness, KIT, TEAM, TEAM_HOME } from '../testing/cli-harness.ts';
import { FakeShell } from '../testing/fake-shell.ts';
import { FaultyFiles, systemError } from '../testing/faulty-files.ts';
import { NODE_SPEC_FAILED } from '../testing/test-output.ts';
import { runsOneSpecFile } from './commands/test.ts';

const LOGS = join(TEAM_HOME, 'state', 'logs');
/** The harness's own CLI (`runtime.self`), which a run in a team starts as `teamrig queue`. */
const QUEUE = '/usr/bin/node /opt/teamrig/dist/cli/main.js queue --kind test';
const PASSED = '▶ parseArgs\n  ✔ splits a command (0.5ms)\n▶ parseArgs (1ms)\nℹ tests 1532\nℹ suites 1\nℹ pass 1532\nℹ fail 0\nℹ cancelled 0\n';

/** TAP output with `count` failing tests of about `size` characters each. */
function tapFailures(count: number, size: number): string {
  const points = Array.from({ length: count }, (_, index) => `not ok ${index + 1} fails ${index + 1}\n  ---\n  error: '${'x'.repeat(size)}'\n  ...`);
  return ['TAP version 13', ...points, `1..${count}`, `# tests ${count}`, '# pass 0', `# fail ${count}`, ''].join('\n');
}

function harness(config = TEAM): { kit: CliHarness; shell: FakeShell } {
  const kit = new CliHarness(config);
  return { kit, shell: new FakeShell(kit.clock) };
}

describe('teamrig test', () => {
  it('prints one PASS line with the count, and logs the command and all it printed', async () => {
    const { kit, shell } = harness();
    const result = await kit.run(['test', '--session', 'alpha', '--', 'npm', 'test'], { shell: shell.prints(PASSED, 0, 41_000) });
    const log = join(LOGS, 'test-alpha-1.log');
    assert.deepEqual(result, { code: 0, stdout: [`PASS npm test: 1,532 tests in 41 s. Log: ${log}`], stderr: [] });
    assert.equal(kit.files.get(log), `$ npm test\n${PASSED}exit 0\n`);
  });

  it('logs what a run printed while it still runs, so a run that never ends leaves its lines (#719)', async () => {
    const { kit, shell } = harness();
    let release = (): void => {};
    const hung = kit.run(['test', '--session', 'alpha', '--', 'npm', 'test'], { shell: shell.prints('ok 1\nok 2\n').hangsUntil(new Promise((done) => (release = done))) });
    const log = join(LOGS, 'test-alpha-1.log');
    for (let turn = 0; turn < 20 && kit.files.get(log) !== '$ npm test\nok 1\nok 2\n'; turn += 1) {
      await new Promise((done) => setImmediate(done));
    }
    assert.equal(kit.files.get(log), '$ npm test\nok 1\nok 2\n', 'the lines are in the log before the run ends');
    release();
    assert.equal((await hung).code, 0);
    assert.equal(kit.files.get(log), '$ npm test\nok 1\nok 2\nexit 0\n');
  });

  it("says in the log when a process held the run's output open after the command ended, and reports the command's end (#719)", async () => {
    const { kit, shell } = harness();
    const result = await kit.run(['test', '--', 'npm', 'test'], { shell: shell.prints(PASSED, 0, 1_000).heldOpen() });
    const log = join(LOGS, 'test-1.log');
    assert.deepEqual(result.stdout, [`PASS npm test: 1,532 tests in 1.0 s. Log: ${log}`]);
    assert.equal(kit.files.get(log), `$ npm test\n${PASSED}${HELD_OPEN_LINE}\nexit 0\n`);
  });

  it('runs the command line in the shell, in the current folder with the environment as it is', async () => {
    const { kit, shell } = harness();
    await kit.run(['test', '--', 'node', '--test', 'src/**/*.test.ts'], { shell, env: { PROBE: 'yes' } });
    const [request] = shell.ran;
    assert.equal(request?.command, `${QUEUE} --what 'test: node --test src/**/*.test.ts' -- node --test 'src/**/*.test.ts'`);
    assert.equal(request?.cwd, APP);
    assert.equal(request?.env['PROBE'], 'yes');
  });

  it('starts the command without the credential variables delivery.passEnv does not name', async () => {
    const { kit, shell } = harness({ ...TEAM, delivery: { passEnv: ['NPM_TOKEN'] } });
    const env = { PROBE: 'yes', GH_TOKEN: 'not-a-real-credential', NPM_TOKEN: 'not-a-real-credential' };
    await kit.run(['test', '--', 'npm', 'test'], { shell, env });
    const [request] = shell.ran;
    assert.deepEqual([request?.env['PROBE'], request?.env['GH_TOKEN'], request?.env['NPM_TOKEN']], ['yes', undefined, 'not-a-real-credential']);
  });

  it('passes every word after -- on, its flags and --help included', async () => {
    const { kit, shell } = harness();
    const result = await kit.run(['test', '--', 'npm test -- --help'], { shell });
    assert.equal(result.code, 0);
    assert.ok(shell.ran[0]?.command.endsWith(" -- 'npm test -- --help'"), shell.ran[0]?.command);
  });

  it('prints FAIL with how many failed, then each failing test in full, and exits 1', async () => {
    const { kit, shell } = harness();
    const result = await kit.run(['test', '--', 'node', '--test'], { shell: shell.prints(`\u001b[31m${NODE_SPEC_FAILED}\u001b[39m`, 1, 2_500) });
    const log = join(LOGS, 'test-1.log');
    assert.equal(result.code, 1);
    assert.equal(result.stdout[0], `FAIL node --test: 2 of 4 failed in 2.5 s. Log: ${log}`);
    assert.ok(result.stdout[1]?.startsWith('test at sample.test.mjs:5:3\n✖ refuses a typo'));
    assert.deepEqual([result.stdout[2], result.stdout[3]?.split('\n')[1]], ['', '✖ reads -h (1.2ms)']);
    assert.equal(result.stdout.length, 4);
    assert.ok(!kit.files.get(log)?.includes('\u001b'), 'the log holds the output without colour codes');
  });

  it("prints the output's last lines when a failed run shows no test runner", async () => {
    const { kit, shell } = harness();
    const result = await kit.run(['test', '--', 'tsc'], { shell: shell.prints('src/a.ts(3,1): error TS2304: Cannot find name "x".\n', 2) });
    assert.deepEqual(result.stdout, [`FAIL tsc in 0.0 s (exit 2). Log: ${join(LOGS, 'test-1.log')}`, "The output's last line:", 'src/a.ts(3,1): error TS2304: Cannot find name "x".']);
  });

  it('says when the command was ended by a signal, and the log ends with it', async () => {
    const { kit, shell } = harness();
    const result = await kit.run(['test', '--', 'npm test'], { shell: shell.prints('', { kind: 'signal', signal: 'SIGTERM' }) });
    assert.equal(result.code, 1);
    assert.equal(result.stdout[0], `FAIL npm test in 0.0 s (ended by SIGTERM). Log: ${join(LOGS, 'test-1.log')}`);
    assert.equal(kit.files.get(join(LOGS, 'test-1.log')), '$ npm test\nended by SIGTERM\n');
  });

  it('prints failures within the configured cap, then how many more the log holds', async () => {
    const output = tapFailures(3, 300);
    const capped = harness({ ...TEAM, tests: { maxFailureChars: 500 } });
    const few = await capped.kit.run(['test', '--', 'npm test'], { shell: capped.shell.prints(output, 1) });
    assert.deepEqual(few.stdout.slice(2), ['', '2 more failures in the log']);
    const roomy = harness();
    const all = await roomy.kit.run(['test', '--', 'npm test'], { shell: roomy.shell.prints(output, 1) });
    assert.equal(all.stdout.filter((line) => line.startsWith('not ok')).length, 3);
  });

  it('names the log after the session id, from a name or $TEAMRIG_SESSION, and keeps a name the team does not know', async () => {
    const { kit, shell } = harness();
    await kit.run(['test', '--', 'npm test'], { shell, env: { TEAMRIG_SESSION: 'app-bravo' } });
    await kit.run(['test', '--session', 'zulu', '--', 'npm test'], { shell });
    assert.deepEqual(
      kit.files.paths().filter((path) => path.includes('/logs/')),
      [join(LOGS, 'test-bravo-1.log'), join(LOGS, 'test-zulu-1.log')].map((path) => path.replaceAll('\\', '/')),
    );
  });

  it("numbers each run past the session's newest log and keeps the newest 20", async () => {
    const { kit, shell } = harness();
    for (let n = 1; n <= 20; n += 1) {
      await kit.files.write(join(LOGS, `test-alpha-${n}.log`), '');
    }
    const result = await kit.run(['test', '--session', 'alpha', '--', 'npm test'], { shell });
    assert.ok(result.stdout[0]?.endsWith(join(LOGS, 'test-alpha-21.log')));
    const logs = kit.files.paths().filter((path) => path.includes('/logs/test-alpha-'));
    assert.equal(logs.length, 20);
    assert.equal(kit.files.get(join(LOGS, 'test-alpha-1.log')), undefined);
  });

  it("works outside a team, with the kit home's logs folder and the default cap", async () => {
    const kit = new CliHarness(TEAM, null);
    const shell = new FakeShell().prints(tapFailures(3, 300), 1);
    const result = await kit.run(['test', '--', 'npm test'], { shell });
    assert.equal(shell.ran[0]?.command, 'npm test', 'outside a team there is no host queue to take its turn in');
    assert.ok(result.stdout[0]?.endsWith(`Log: ${join(KIT, 'logs', 'test-1.log')}`));
    assert.equal(result.stdout.filter((line) => line.startsWith('not ok')).length, 3);
  });

  it('in a team, runs through the host queue: one spec file as a small step, anything more as a heavy one, for its session (T2323)', async () => {
    const { kit, shell } = harness();
    const one = await kit.run(['test', '--session', 'alpha', '--', 'node', '--test', 'src/a.test.ts'], { shell: shell.prints(PASSED, 0, 1_000) });
    assert.equal(shell.ran[0]?.command, `${QUEUE} --small --what 'test: node --test src/a.test.ts' --session alpha -- node --test src/a.test.ts`);
    assert.equal(kit.files.get(join(LOGS, 'test-alpha-1.log'))?.split('\n')[0], '$ node --test src/a.test.ts', 'the log names the command as given');
    assert.equal(one.stdout[0], `PASS node --test src/a.test.ts: 1,532 tests in 1.0 s. Log: ${join(LOGS, 'test-alpha-1.log')}`);
    await kit.run(['test', '--session', 'alpha', '--', 'npm test'], { shell });
    assert.equal(shell.ran[1]?.command, `${QUEUE} --what 'test: npm test' --session alpha -- 'npm test'`);
  });

  it("runs bare when the team's config cannot be read, as the queue could not read it either", async () => {
    const kit = new CliHarness('{ not json');
    const shell = new FakeShell();
    await kit.run(['test', '--', 'npm test'], { shell });
    assert.equal(shell.ran[0]?.command, 'npm test');
  });

  it("uses the team's logs folder and the default cap when its config cannot be read", async () => {
    const kit = new CliHarness('{ not json');
    const result = await kit.run(['test', '--session', 'alpha', '--', 'npm test'], { shell: new FakeShell() });
    assert.equal(result.stdout[0], `PASS npm test in 0.0 s. Log: ${join(LOGS, 'test-alpha-1.log')}`);
  });

  it('adds to its log and never writes over it, which Windows refuses while a scan or reader holds the new file', async () => {
    const { kit, shell } = harness();
    const log = join(LOGS, 'test-alpha-1.log');
    const held = new FaultyFiles(kit.files).fail('write', log, systemError('EPERM', 'EPERM: operation not permitted, rename'));
    const result = await kit.run(['test', '--session', 'alpha', '--', 'npm', 'test'], { shell: shell.prints(PASSED, 0, 41_000), files: held });
    assert.deepEqual(result, { code: 0, stdout: [`PASS npm test: 1,532 tests in 41 s. Log: ${log}`], stderr: [] });
    assert.equal(kit.files.get(log), `$ npm test\n${PASSED}exit 0\n`);
  });

  it('fails with the reason when the command cannot start, and the log says why', async () => {
    const { kit, shell } = harness();
    const result = await kit.run(['test', '--', 'npm test'], { shell: shell.failsWith(new Error('spawn /bin/sh ENOENT')) });
    assert.deepEqual(result, { code: 1, stdout: [], stderr: ['FAILED spawn /bin/sh ENOENT'] });
    assert.equal(kit.files.get(join(LOGS, 'test-1.log')), '$ npm test\ncould not start: spawn /bin/sh ENOENT\n');
  });

  it('refuses a line with no command after --, or words before it', async () => {
    const { kit, shell } = harness();
    for (const [argv, reason] of [
      [['test'], 'no command to run after --'],
      [['test', '--'], 'no command to run after --'],
      [['test', 'npm', 'test'], 'put "npm" and the rest of the command after --'],
      [['test', '--session', 'Not A Name', '--', 'npm test'], '--session "Not A Name" is not a session id or name'],
    ] as const) {
      const result = await kit.run(argv, { shell });
      assert.equal(result.code, 64);
      assert.ok(result.stderr[0]?.startsWith(reason), result.stderr[0]);
    }
    const fromEnv = await kit.run(['test', '--', 'npm test'], { shell, env: { TEAMRIG_SESSION: 'Bad!' } });
    assert.ok(fromEnv.stderr[0]?.startsWith('$TEAMRIG_SESSION "Bad!" is not a session id or name'));
    assert.equal(shell.ran.length, 0);
  });

  it('refuses on Windows a command with a line break, which cmd.exe would cut, and an empty one, running nothing (T2156)', async () => {
    const { kit, shell } = harness();
    for (const [words, reason] of [
      [['bash', '-c', '\nnpm test'], 'a word of the command holds a line break, and cmd.exe'],
      [[''], 'the command after -- is empty'],
    ] as const) {
      const result = await kit.run(['test', '--', ...words], { shell, platform: 'win32' });
      assert.equal(result.code, 64);
      assert.ok(result.stderr[0]?.startsWith(reason), result.stderr[0]);
    }
    assert.equal(shell.ran.length, 0);
  });

  it('refuses a word that is only ||, running nothing, and runs the chain as one word (#661)', async () => {
    const { kit, shell } = harness();
    const refused = await kit.run(['test', '--', 'npm', 'test', '||', 'true'], { shell });
    assert.equal(refused.code, 64);
    assert.ok(refused.stderr[0]?.startsWith('the word "||" of the command is a shell operator'), refused.stderr[0]);
    assert.equal(shell.ran.length, 0);
    await kit.run(['test', '--', 'npm test || true'], { shell });
    assert.equal(shell.ran.length, 1);
  });

  it('still refuses -- on a command that takes no command line', async () => {
    const result = await new CliHarness().run(['show', 'T1', '--', 'x']);
    assert.equal(result.code, 64);
    assert.ok(result.stderr[0]?.startsWith('show takes no --'));
  });

  it('prints its own help', async () => {
    const result = await new CliHarness().run(['test', '--help']);
    assert.equal(result.code, 0);
    assert.ok(result.stdout[0]?.includes('test [--session <id|name>] -- <command ...>'));
  });
});

describe('runsOneSpecFile', () => {
  it('is a node run of one spec file, flags and a quoted path allowed', () => {
    assert.deepEqual(
      [['node', '--test', 'src/a.test.ts'], ['node --test --test-name-pattern=x "src/a b/c.test.ts"'], ['C:\\node\\node.exe','--test', 'a.test.mjs']].map(runsOneSpecFile),
      [true, true, true],
    );
  });

  it('is not a glob, two files, a folder, a package script or another program, which may run the whole suite', () => {
    assert.deepEqual(
      [['node', '--test', 'src/**/*.test.ts'], ['node', '--test', 'a.test.ts', 'b.test.ts'], ['node', '--test', 'src/'], ['npm test -- a.test.ts'], ['npx', 'tsx', 'a.test.ts'], []].map(runsOneSpecFile),
      [false, false, false, false, false, false],
    );
  });
});
