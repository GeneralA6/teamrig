import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const GUARD_MAIN = join(HERE, 'guard-main.ts');
const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } });
const FORCE_PUSH = JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'git push --force origin main' } });
/** The limit the copies run with, so a hang ends the spec in half a second, not 12. */
const COPY_LIMIT = 'export const GUARD_LIMIT_MS = 500;';

interface Ended {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly ms: number;
}

function run(script: string, args: readonly string[], input: string, env: NodeJS.ProcessEnv = process.env): Promise<Ended> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - started }));
    child.stdin.end(input);
  });
}

/** Runs `hook push-guard` through copies of the entry and the runner beside a stand-in `node-main.ts`. */
async function throughCopy(nodeMain: string): Promise<Ended> {
  const folder = mkdtempSync(join(tmpdir(), 'teamrig-guard-main-'));
  try {
    const runner = readFileSync(join(HERE, 'guard-runner.ts'), 'utf8');
    const shortened = runner.replace(/^export const GUARD_LIMIT_MS = 12_000;$/m, COPY_LIMIT);
    assert.ok(shortened.includes(COPY_LIMIT), 'guard-runner.ts declares GUARD_LIMIT_MS = 12_000');
    writeFileSync(join(folder, 'package.json'), '{ "type": "module" }\n');
    copyFileSync(GUARD_MAIN, join(folder, 'guard-main.ts'));
    writeFileSync(join(folder, 'guard-runner.ts'), shortened);
    writeFileSync(join(folder, 'node-main.ts'), nodeMain);
    return await run(join(folder, 'guard-main.ts'), ['hook', 'push-guard'], FORCE_PUSH);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

function assertBlocked(ended: Ended, why: RegExp): void {
  assert.equal(ended.status, 2, ended.stderr);
  assert.equal(ended.stdout, '');
  assert.match(ended.stderr, /teamrig blocked this call: its push-guard guard /);
  assert.match(ended.stderr, why);
}

describe('guard-main, on broken copies of the CLI', () => {
  it('blocks a CLI with a syntax error, a throw on load, a missing module or no runWithNode', async () => {
    assertBlocked(await throughCopy('export const runWithNode = (;\n'), /could not load \(/);
    assertBlocked(await throughCopy("throw new Error('broken on load');\nexport async function runWithNode() { return 0; }\n"), /could not load \(broken on load\)/);
    assertBlocked(await throughCopy("import './gone.ts';\nexport async function runWithNode() { return 0; }\n"), /could not load \(Cannot find module/);
    assertBlocked(await throughCopy('export const other = 1;\n'), /crashed \(main is not a function\)/);
  });

  it('blocks a run that hangs, with or without work pending, at the limit', async () => {
    const idle = await throughCopy('export function runWithNode() { return new Promise(() => {}); }\n');
    assertBlocked(idle, /gave no answer within 0\.5 s/);
    assert.ok(idle.ms >= 450, `${idle.ms} ms`);
    assertBlocked(await throughCopy('export function runWithNode() { setInterval(() => {}, 1000); return new Promise(() => {}); }\n'), /gave no answer within 0\.5 s/);
  });

  it('blocks a throw or a rejection nobody handles', async () => {
    assertBlocked(await throughCopy("export function runWithNode() { setTimeout(() => { throw new Error('late throw'); }, 10); return new Promise(() => {}); }\n"), /crashed \(late throw\)/);
    assertBlocked(await throughCopy("export function runWithNode() { void Promise.reject(new Error('stray')); return new Promise(() => {}); }\n"), /crashed \(stray\)/);
  });

  it('blocks an answer that is not JSON and a failed exit, keeping what the CLI wrote to stderr', async () => {
    assertBlocked(await throughCopy("export async function runWithNode(argv, entry) { entry.out.stdout('garbled'); return 0; }\n"), /printed something other than its JSON answer \("garbled"\)/);
    const failed = await throughCopy("export async function runWithNode(argv, entry) { entry.out.stderr('FAILED the register is locked'); return 1; }\n");
    assertBlocked(failed, /ended with exit 1/);
    assert.match(failed.stderr, /^FAILED the register is locked\n/);
  });

  it('passes a JSON answer or none on with exit 0, and ends a run that lingers after its answer at the limit', async () => {
    const deny = await throughCopy(`export async function runWithNode(argv, entry) { entry.out.stdout(${JSON.stringify(DENY)}); return 0; }\n`);
    assert.deepEqual([deny.status, deny.stdout, deny.stderr], [0, `${DENY}\n`, '']);
    const quiet = await throughCopy('export async function runWithNode() { return 0; }\n');
    assert.deepEqual([quiet.status, quiet.stdout, quiet.stderr], [0, '', '']);
    const lingering = await throughCopy(`export async function runWithNode(argv, entry) { setInterval(() => {}, 1000); entry.out.stdout(${JSON.stringify(DENY)}); return 0; }\n`);
    assert.deepEqual([lingering.status, lingering.stdout], [0, `${DENY}\n`]);
  });
});

describe('guard-main, on the real CLI', () => {
  /** A fixed team in an empty kit home keeps the run off any team pointer above the temp folder on the test machine. */
  async function inTempHome(args: readonly string[], input: string): Promise<Ended> {
    const home = mkdtempSync(join(tmpdir(), 'teamrig-guard-main-home-'));
    try {
      return await run(GUARD_MAIN, args, input, { ...process.env, TEAMRIG_HOME: home, TEAMRIG_TEAM: 'app' });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }

  it("passes the push guard's deny on", async () => {
    const ended = await inTempHome(['hook', 'push-guard'], FORCE_PUSH);
    assert.equal(ended.status, 0, ended.stderr);
    assert.match(ended.stdout, /"permissionDecision":"deny"/);
  });

  it('blocks a hook the CLI does not know, which it answers with a usage exit', async () => {
    const ended = await inTempHome(['hook', 'no-such-guard'], FORCE_PUSH);
    assert.equal(ended.status, 2);
    assert.match(ended.stderr, /its no-such-guard guard ended with exit 64/);
  });
});
