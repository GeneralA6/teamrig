import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  nodeProgramRunner,
  systemCredentials,
  windowsReadScript,
  windowsSaveScript,
  type ProgramRequest,
  type ProgramResult,
  type ProgramRunner,
} from './credentials.ts';

const NAME = 'teamrig-gh-acme';
const TOKEN = 'tok-acme';

/** A runner that answers every run with `result` and records each request. */
function answering(result: ProgramResult): { readonly run: ProgramRunner; readonly ran: ProgramRequest[] } {
  const ran: ProgramRequest[] = [];
  return {
    ran,
    run: async (request) => {
      ran.push(request);
      return result;
    },
  };
}

function exited(code: number, stdout = '', stderr = ''): ProgramResult {
  return { end: { kind: 'exited', code }, stdout, stderr };
}

/** A runner whose program cannot start, as `spawn` fails with `code`. */
function notStarting(code: string): ProgramRunner {
  return async (request) => {
    throw Object.assign(new Error(`spawn ${request.program} ${code}`), { code });
  };
}

function base64(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64');
}

describe('systemCredentials on Windows', () => {
  it('reads the credential through a PowerShell script passed encoded, never the secret in an argument', async () => {
    const runner = answering(exited(0, `${base64(TOKEN)}\r\n`));
    const store = systemCredentials('win32', runner.run);
    assert.deepEqual(await store.read(NAME), { kind: 'found', secret: TOKEN });
    const [request] = runner.ran;
    assert.equal(request?.program, 'powershell.exe');
    assert.deepEqual(request?.args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(Buffer.from(request?.args[3] ?? '', 'base64').toString('utf16le'), windowsReadScript(NAME));
    assert.ok(windowsReadScript(NAME).includes(`::Read('${NAME}')`));
  });

  it('says how to save one, and that none is saved when the script ends with 3', async () => {
    const store = systemCredentials('win32', answering(exited(3)).run);
    assert.equal(store.label, 'the Windows Credential Manager');
    assert.equal(store.saveCommand(NAME), `cmdkey /generic:${NAME} /user:teamrig /pass`);
    assert.deepEqual(await store.read(NAME), { kind: 'missing' });
  });

  it('gives a failure by its first error line, and a stop by its signal', async () => {
    const failed = systemCredentials('win32', answering(exited(1, '', '\nAdd-Type : boom\nat line 2\n')).run);
    assert.deepEqual(await failed.read(NAME), { kind: 'failed', reason: 'powershell.exe exited 1: Add-Type : boom' });
    const stopped = systemCredentials('win32', answering({ end: { kind: 'signal', signal: 'SIGTERM' }, stdout: '', stderr: '' }).run);
    assert.deepEqual(await stopped.read(NAME), { kind: 'failed', reason: 'powershell.exe was stopped (SIGTERM): no error text' });
  });

  it('refuses a saved value that is not a token, without printing it', async () => {
    const read = await systemCredentials('win32', answering(exited(0, base64('two words'))).run).read(NAME);
    assert.deepEqual(read, { kind: 'failed', reason: `credential ${NAME} does not hold a token: save it again with cmdkey /generic:${NAME} /user:teamrig /pass` });
  });
});

describe('systemCredentials on macOS', () => {
  it('reads the keychain item by service name, and exit 44 means none is saved', async () => {
    const runner = answering(exited(0, `${TOKEN}\n`));
    const store = systemCredentials('darwin', runner.run);
    assert.deepEqual(await store.read(NAME), { kind: 'found', secret: TOKEN });
    assert.deepEqual(runner.ran, [{ program: 'security', args: ['find-generic-password', '-s', NAME, '-w'] }]);
    assert.equal(store.saveCommand(NAME), `security add-generic-password -U -s ${NAME} -a teamrig -w`);
    assert.deepEqual(await systemCredentials('darwin', answering(exited(44, '', 'could not be found')).run).read(NAME), { kind: 'missing' });
  });
});

describe('systemCredentials on Linux', () => {
  it('reads the Secret Service item by its service attribute', async () => {
    const runner = answering(exited(0, `${TOKEN}\n`));
    const store = systemCredentials('linux', runner.run);
    assert.deepEqual(await store.read(NAME), { kind: 'found', secret: TOKEN });
    assert.deepEqual(runner.ran, [{ program: 'secret-tool', args: ['lookup', 'service', NAME] }]);
    assert.equal(store.saveCommand(NAME), `secret-tool store --label=${NAME} service ${NAME}`);
  });

  it('takes a silent exit 1 or no secret-tool as none saved, and an error text as a failure', async () => {
    assert.deepEqual(await systemCredentials('linux', answering(exited(1)).run).read(NAME), { kind: 'missing' });
    assert.deepEqual(await systemCredentials('linux', notStarting('ENOENT')).read(NAME), { kind: 'missing' });
    assert.deepEqual(await systemCredentials('linux', answering(exited(1, '', 'Cannot autolaunch D-Bus without X11\n')).run).read(NAME), {
      kind: 'failed',
      reason: 'secret-tool exited 1: Cannot autolaunch D-Bus without X11',
    });
    assert.deepEqual(await systemCredentials('linux', notStarting('EACCES')).read(NAME), {
      kind: 'failed',
      reason: 'secret-tool could not start: spawn secret-tool EACCES',
    });
  });
});

describe('credential names', () => {
  it('refuses a name that would need quoting, without running anything', async () => {
    const runner = answering(exited(0, TOKEN));
    assert.deepEqual(await systemCredentials('linux', runner.run).read("acme'; rm"), {
      kind: 'failed',
      reason: `"acme'; rm" is not a credential name: letters, digits, '.', '_' or '-'`,
    });
    assert.deepEqual(runner.ran, []);
  });
});

describe('nodeProgramRunner', () => {
  it('runs a program with no shell and gives its end, stdout and stderr', async () => {
    const result = await nodeProgramRunner()({
      program: process.execPath,
      args: ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 3'],
    });
    assert.deepEqual(result, { end: { kind: 'exited', code: 3 }, stdout: 'out', stderr: 'err' });
  });

  it('rejects when the program is not there', async () => {
    await assert.rejects(nodeProgramRunner()({ program: 'teamrig-no-such-program', args: [] }), { code: 'ENOENT' });
  });
});

/** A runner that answers each run with the next of `results` and records each request. */
function answeringEach(...results: ProgramResult[]): { readonly run: ProgramRunner; readonly ran: ProgramRequest[] } {
  const ran: ProgramRequest[] = [];
  return {
    ran,
    run: async (request) => {
      ran.push(request);
      const result = results[ran.length - 1];
      assert.ok(result !== undefined, `no answer for run ${ran.length}`);
      return result;
    },
  };
}

const KEY = 'aBc_-123.~+/=';

describe('saving a credential', () => {
  it('saves on Windows through an encoded script, the secret on stdin only, and reads it back', async () => {
    const runner = answeringEach(exited(0), exited(0, base64(KEY)));
    assert.deepEqual(await systemCredentials('win32', runner.run).save(NAME, KEY), { kind: 'saved' });
    const [save, read] = runner.ran;
    assert.equal(save?.program, 'powershell.exe');
    assert.equal(save?.stdin, KEY);
    assert.equal(Buffer.from(save?.args[3] ?? '', 'base64').toString('utf16le'), windowsSaveScript(NAME));
    assert.ok(windowsSaveScript(NAME).includes(`::Save('${NAME}', $secret)`));
    assert.ok(!(save?.args ?? []).some((arg) => arg.includes(KEY) || Buffer.from(arg, 'base64').toString('utf16le').includes(KEY)));
    assert.equal(read?.stdin, undefined);
  });

  it('saves on macOS through security -i, the secret in its stdin command, never in argv', async () => {
    const runner = answeringEach(exited(0), exited(0, `${KEY}\n`));
    assert.deepEqual(await systemCredentials('darwin', runner.run).save(NAME, KEY), { kind: 'saved' });
    assert.deepEqual(runner.ran[0], { program: 'security', args: ['-i'], stdin: `add-generic-password -U -s ${NAME} -a teamrig -w ${KEY}\n` });
  });

  it('saves on Linux through secret-tool store, the secret on stdin', async () => {
    const runner = answeringEach(exited(0), exited(0, `${KEY}\n`));
    assert.deepEqual(await systemCredentials('linux', runner.run).save(NAME, KEY), { kind: 'saved' });
    assert.deepEqual(runner.ran[0], { program: 'secret-tool', args: ['store', `--label=${NAME}`, 'service', NAME], stdin: KEY });
  });

  it('fails when the read back does not find the same secret, never naming it', async () => {
    const other = await systemCredentials('darwin', answeringEach(exited(0), exited(0, 'other\n')).run).save(NAME, KEY);
    assert.deepEqual(other, { kind: 'failed', reason: `the macOS keychain did not keep ${NAME}: read back, it holds another value` });
    const none = await systemCredentials('linux', answeringEach(exited(0), exited(1)).run).save(NAME, KEY);
    assert.deepEqual(none, { kind: 'failed', reason: `the Secret Service keyring did not keep ${NAME}: read back, nothing is saved under it` });
    const broken = await systemCredentials('linux', answeringEach(exited(0), exited(2, '', 'locked\n')).run).save(NAME, KEY);
    assert.deepEqual(broken, { kind: 'failed', reason: `the Secret Service keyring did not keep ${NAME}: read back, secret-tool exited 2: locked` });
  });

  it('fails by the tool end when the save itself fails, and reads nothing back', async () => {
    const runner = answeringEach(exited(1, '', 'CredWriteW failed with Windows error 1312\n'));
    assert.deepEqual(await systemCredentials('win32', runner.run).save(NAME, KEY), {
      kind: 'failed',
      reason: 'powershell.exe exited 1: CredWriteW failed with Windows error 1312',
    });
    assert.equal(runner.ran.length, 1);
    assert.deepEqual(await systemCredentials('linux', notStarting('ENOENT')).save(NAME, KEY), {
      kind: 'failed',
      reason: 'secret-tool could not start: spawn secret-tool ENOENT',
    });
  });

  it('refuses a name that needs quoting or a secret a tool would split, without running anything', async () => {
    const runner = answeringEach();
    const store = systemCredentials('darwin', runner.run);
    assert.deepEqual(await store.save('a b', KEY), { kind: 'failed', reason: `"a b" is not a credential name: letters, digits, '.', '_' or '-'` });
    const split = await store.save(NAME, 'two words');
    assert.deepEqual(split, { kind: 'failed', reason: `the secret for ${NAME} is not text teamrig saves: letters, digits and . _ ~ + / = -` });
    assert.ok(!split.reason.includes('two words'));
    assert.deepEqual(runner.ran, []);
  });
});

describe('nodeProgramRunner with stdin', () => {
  it('writes the request stdin to the program and closes it', async () => {
    const result = await nodeProgramRunner()({
      program: process.execPath,
      args: ['-e', 'let t = ""; process.stdin.on("data", (c) => (t += c)).on("end", () => process.stdout.write(t.toUpperCase()))'],
      stdin: 'secret',
    });
    assert.deepEqual(result, { end: { kind: 'exited', code: 0 }, stdout: 'SECRET', stderr: '' });
  });

  it('gives the exit of a program that ends without reading its stdin', async () => {
    const result = await nodeProgramRunner()({ program: process.execPath, args: ['-e', 'process.exitCode = 4'], stdin: 'x'.repeat(1 << 20) });
    assert.deepEqual(result.end, { kind: 'exited', code: 4 });
  });
});
