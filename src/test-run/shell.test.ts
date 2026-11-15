import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandLine, endOf, nodeShellRunner, unrunnableReason } from './shell.ts';

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
});

describe('endOf', () => {
  it('reads an exit code, or the signal when there is none', () => {
    assert.deepEqual(endOf(3, null), { kind: 'exited', code: 3 });
    assert.deepEqual(endOf(null, 'SIGTERM'), { kind: 'signal', signal: 'SIGTERM' });
    assert.deepEqual(endOf(null, null), { kind: 'signal', signal: 'an unknown signal' });
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

  it('rejects when the command cannot start, such as in a missing folder', async () => {
    await assert.rejects(shell.run({ command: 'node --version', cwd: join(DIR, 'missing'), env: ENV }), /ENOENT/);
  });
});
