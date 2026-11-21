import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandLine, nodeShellRunner, unrunnableReason } from './shell.ts';

const DIR = mkdtempSync(join(tmpdir(), 'teamrig-shell-'));
const ENV = { ...process.env, TEAMRIG_PROBE: 'probe value' };

after(() => rmSync(DIR, { recursive: true, force: true }));

/** A Node script in the temp folder, and the command line that runs it on this platform. */
function script(name: string, source: string): string {
  const path = join(DIR, name);
  writeFileSync(path, source);
  return commandLine([process.execPath, path], process.platform);
}

describe('commandLine', () => {
  it('runs one word as the command line itself', () => {
    assert.equal(commandLine(['npm run build && npm test'], 'linux'), 'npm run build && npm test');
    assert.equal(commandLine(['npm run build && npm test'], 'win32'), 'npm run build && npm test');
  });

  it('quotes each of several words a POSIX shell would read, so a glob is not expanded', () => {
    assert.equal(commandLine(['node', '--test', 'src/**/*.test.ts'], 'linux'), "node --test 'src/**/*.test.ts'");
    assert.equal(commandLine(['echo', "it's", 'a b', '$HOME', ''], 'darwin'), "echo 'it'\\''s' 'a b' '$HOME' ''");
    assert.equal(commandLine(['FOO=1', 'npx', 'jest', '--runInBand', 'a.test.ts:12'], 'linux'), 'FOO=1 npx jest --runInBand a.test.ts:12');
  });

  it('double-quotes each of several words cmd.exe would read, and leaves globs for the program', () => {
    assert.equal(commandLine(['node', '--test', 'src/**/*.test.ts'], 'win32'), 'node --test src/**/*.test.ts');
    assert.equal(commandLine(['C:\\Program Files\\nodejs\\node.exe', 'a&b', 'say "hi"', '50%', ''], 'win32'), '"C:\\Program Files\\nodejs\\node.exe" "a&b" "say \\"hi\\"" "50%" ""');
  });
});

describe('unrunnableReason', () => {
  it('refuses a blank command on every platform', () => {
    for (const platform of ['linux', 'win32'] as const) {
      for (const words of [[''], [' '], ['\n', '\t']]) {
        assert.match(unrunnableReason(words, platform) ?? '', /^the command after -- is empty/u);
      }
    }
  });

  it('refuses a word with a line break on Windows, where cmd.exe stops reading at it', () => {
    for (const words of [['bash', '-c', '\necho ran'], ['bash', '-c', 'echo one\necho two'], ['node -e "1"\r\nnode -e "2"']]) {
      assert.match(unrunnableReason(words, 'win32') ?? '', /line break, and cmd\.exe/u);
    }
  });

  it('lets a POSIX shell run a quoted line break, and Windows a command on one line', () => {
    assert.equal(unrunnableReason(['bash', '-c', '\necho ran'], 'linux'), undefined);
    assert.equal(unrunnableReason(['bash', '-c', 'echo ran'], 'win32'), undefined);
    assert.equal(unrunnableReason(['npm', 'test', ''], 'win32'), undefined);
  });

  it('refuses a word that is only &&, || or ;, which would reach the first program quoted, with the one-word hint (#661)', () => {
    for (const platform of ['linux', 'win32'] as const) {
      for (const operator of ['&&', '||', ';']) {
        const reason = unrunnableReason(['npm', 'run', 'build', operator, 'npm', 'test'], platform) ?? '';
        assert.ok(reason.startsWith(`the word "${operator}" of the command is a shell operator`), reason);
        assert.ok(reason.endsWith(`pass the whole chain as one quoted word: -- "npm run build ${operator} npm test"`), reason);
      }
    }
  });

  it('runs the chain as one word, and a word that holds an operator among other text, as today', () => {
    for (const platform of ['linux', 'win32'] as const) {
      assert.equal(unrunnableReason(['npm run build && npm test'], platform), undefined);
      assert.equal(unrunnableReason(['node', 'tool.js', 'a;b', '--x=&&', '||y'], platform), undefined);
      assert.equal(unrunnableReason([';'], platform), undefined);
    }
  });
});

describe('nodeShellRunner', () => {
  const shell = nodeShellRunner();

  it('keeps stdout and stderr together in the order they arrived', async () => {
    const command = script(
      'order.mjs',
      "const wait = () => new Promise((done) => setTimeout(done, 40));\nprocess.stdout.write('one\\n'); await wait();\nprocess.stderr.write('two\\n'); await wait();\nprocess.stdout.write('three é\\n');\n",
    );
    assert.deepEqual(await shell.run({ command, cwd: DIR, env: ENV }), { end: { kind: 'exited', code: 0 }, output: 'one\ntwo\nthree é\n' });
  });

  it('reports a failing exit code with what was printed', async () => {
    const command = script('fail.mjs', "console.error('broke');\nprocess.exitCode = 3;\n");
    assert.deepEqual(await shell.run({ command, cwd: DIR, env: ENV }), { end: { kind: 'exited', code: 3 }, output: 'broke\n' });
  });

  it('runs in the folder and environment given, with stdin already at its end', async () => {
    const command = script(
      'where.mjs',
      "let input = '';\nprocess.stdin.on('data', (chunk) => { input += chunk; });\nprocess.stdin.on('end', () => console.log(JSON.stringify({ cwd: process.cwd(), probe: process.env.TEAMRIG_PROBE, input })));\n",
    );
    const { end, output } = await shell.run({ command, cwd: DIR, env: ENV });
    assert.deepEqual(end, { kind: 'exited', code: 0 });
    assert.deepEqual(JSON.parse(output), { cwd: realpathSync(DIR), probe: 'probe value', input: '' });
  });

  it('hands each piece of output to onOutput as it arrives, all of it in order', async () => {
    const command = script('pieces.mjs', "process.stdout.write('one\\n');\nsetTimeout(() => process.stderr.write('two\\n'), 40);\n");
    const pieces: string[] = [];
    const result = await shell.run({ command, cwd: DIR, env: ENV, onOutput: (chunk) => pieces.push(chunk) });
    assert.equal(pieces.join(''), 'one\ntwo\n');
    assert.equal(result.output, 'one\ntwo\n');
    assert.equal(result.heldOpen, undefined);
  });

  it('ends a grace after the command exits while a process it started holds the output, with the command end (#719)', async () => {
    // The command prints, starts a child that keeps stdout and stderr open for 5 s, and exits 3 at once. The child is
    // detached: on Windows a child that is not dies with its parent's job object, and never holds the pipe.
    const command = script(
      'orphan.mjs',
      "import { spawn } from 'node:child_process';\nconsole.log('before');\n" +
        "spawn(process.execPath, ['-e', 'setTimeout(() => {}, 5000)'], { detached: true, stdio: ['ignore', 'inherit', 'inherit'] }).unref();\nprocess.exitCode = 3;\n",
    );
    const started = Date.now();
    // The orphan outlives the test and keeps its working folder busy; on Windows that folder cannot be removed
    // until it exits, so it runs in the system temp folder, not in DIR, which after() removes.
    const result = await nodeShellRunner(200).run({ command, cwd: tmpdir(), env: ENV });
    assert.ok(Date.now() - started < 4_000, `ended ${Date.now() - started} ms after the start, not when the orphan let go`);
    assert.deepEqual(result, { end: { kind: 'exited', code: 3 }, output: 'before\n', heldOpen: true });
  });

  it('rejects when the command cannot start, such as in a missing folder', async () => {
    await assert.rejects(shell.run({ command: 'node --version', cwd: join(DIR, 'missing'), env: ENV }), /ENOENT/);
  });
});
