import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { KIT_VERSION } from '../core/version.ts';
import { threadGuardLoad } from './guard-thread.ts';
import type { NodeEntry } from './node-main.ts';

const folder = mkdtempSync(join(tmpdir(), 'teamrig-guard-thread-'));
after(() => rmSync(folder, { recursive: true, force: true }));

/** A stand-in guard thread: `body` runs with `port`, `post` and the hook input read into `input`. */
function threadScript(name: string, body: string): URL {
  const path = join(folder, `${name}.mjs`);
  writeFileSync(
    path,
    [
      "import { parentPort as port } from 'node:worker_threads';",
      "import { text } from 'node:stream/consumers';",
      'const post = (message) => port.postMessage(message);',
      body,
    ].join('\n'),
  );
  return pathToFileURL(path);
}

/** The lines a run printed, beside a NodeEntry that keeps them. */
function keptEntry(): { readonly entry: NodeEntry; readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { entry: { out: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, script: 'main.js' }, stdout, stderr };
}

const ANSWERING = `
post({ kind: 'loaded' });
port.once('message', async (run) => {
  const input = await text(process.stdin);
  post({ kind: 'stderr', line: run.argv.join(' ') + ' from ' + run.script });
  post({ kind: 'stdout', line: 'read ' + input });
  post({ kind: 'answered', code: 2 });
});
`;

describe('threadGuardLoad', () => {
  it("runs the guard on its thread with the hook input, relaying its lines and exit code", async () => {
    const main = await threadGuardLoad(threadScript('answering', ANSWERING), Readable.from(['{"tool_name":"Bash"}']))();
    const kept = keptEntry();
    assert.equal(await main(['hook', 'push-guard'], kept.entry), 2);
    assert.deepEqual(kept.stdout, ['read {"tool_name":"Bash"}']);
    assert.deepEqual(kept.stderr, ['hook push-guard from main.js']);
  });

  it('rejects the load when the CLI fails to load there, or the thread cannot start or ends first', async () => {
    const input = (): Readable => Readable.from(['{}']);
    await assert.rejects(threadGuardLoad(threadScript('load-failed', "post({ kind: 'load-failed', message: 'broken on load' });"), input())(), /^Error: broken on load$/);
    await assert.rejects(threadGuardLoad(threadScript('syntax', 'export const = ;'), input())(), SyntaxError);
    await assert.rejects(threadGuardLoad(pathToFileURL(join(folder, 'gone.mjs')), input())(), /Cannot find module/);
    await assert.rejects(threadGuardLoad(threadScript('silent', ''), input())(), /its thread ended with exit 0 before it answered/);
  });

  it('rejects the run on a crash, a throw, an exit or a message it cannot read', async () => {
    const cases: readonly [string, string, RegExp][] = [
      ['crashed', "post({ kind: 'crashed', message: 'main is not a function' });", /^Error: main is not a function$/],
      ['throws', "throw new Error('late throw');", /late throw/],
      ['exits', 'process.exit(3);', /its thread ended with exit 3 before it answered/],
      ['garbled', "post({ kind: 'answered', code: 'zero' });", /its thread sent a message the entry cannot read/],
    ];
    for (const [name, onRun, why] of cases) {
      const script = threadScript(name, `post({ kind: 'loaded' });\nport.once('message', () => { ${onRun} });`);
      const main = await threadGuardLoad(script, Readable.from(['{}']))();
      await assert.rejects(main(['hook', 'push-guard'], keptEntry().entry), why, name);
    }
  });

  it('rejects a run asked after the thread already ended', async () => {
    const script = threadScript('ended', "post({ kind: 'loaded' });\nsetTimeout(() => process.exit(0), 10);\nsetTimeout(() => {}, 1000);");
    const main = await threadGuardLoad(script, Readable.from(['{}']))();
    await new Promise((resolve) => setTimeout(resolve, 200));
    await assert.rejects(main(['hook', 'push-guard'], keptEntry().entry), /its thread ended with exit 0 before it answered/);
  });

  it('runs the real CLI through guard-worker.ts', async () => {
    const main = await threadGuardLoad(new URL('./guard-worker.ts', import.meta.url), Readable.from(['']))();
    const kept = keptEntry();
    assert.equal(await main(['--version'], kept.entry), 0);
    assert.match(kept.stdout.join('\n'), new RegExp(KIT_VERSION.replaceAll('.', '\\.')));
  });
});
