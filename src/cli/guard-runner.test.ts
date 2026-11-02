import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { GUARD_LIMIT_MS, judgeGuard, runGuard, type GuardHost, type GuardMain } from './guard-runner.ts';
import { EXIT, type ExitCode } from './runtime.ts';
import type { NodeEntry } from './node-main.ts';

const DENY = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'no' } });
const ARGV = ['hook', 'push-guard'];
const SCRIPT = '/kit/dist/cli/main.js';

/** The process as the runner sees it: what it wrote, how it ended, and the time limit and fatal listener to fire. */
class FakeHost implements GuardHost {
  readonly written: string[] = [];
  readonly errors: string[] = [];
  readonly exits: number[] = [];
  exitCode: number | undefined;
  limitMs: number | undefined;
  released = false;
  failWrites = false;
  private fatal: ((cause: unknown) => void) | undefined;
  private fire: (() => void) | undefined;

  readonly onFatal = (listener: (cause: unknown) => void): void => {
    this.fatal = listener;
  };

  readonly startLimit = (ms: number, fire: () => void): { readonly release: () => void } => {
    this.limitMs = ms;
    this.fire = fire;
    return { release: () => (this.released = true) };
  };

  readonly write = (text: string): void => {
    if (this.failWrites) {
      throw new Error('EAGAIN: resource temporarily unavailable, write');
    }
    this.written.push(text);
  };

  readonly writeError = (text: string): void => {
    this.errors.push(text);
  };

  readonly exit = (code: number): void => {
    this.exits.push(code);
  };

  readonly setExitCode = (code: number): void => {
    this.exitCode = code;
  };

  crash(cause: unknown): void {
    this.fatal?.(cause);
  }

  timeOut(): void {
    this.fire?.();
  }
}

/** A CLI run that prints `stdout` and `stderr` lines, then ends with `code`; it records what it was given. */
function answering(code: ExitCode, stdout: readonly string[] = [], stderr: readonly string[] = []): { readonly main: GuardMain; readonly calls: { argv: readonly string[]; entry: NodeEntry }[] } {
  const calls: { argv: readonly string[]; entry: NodeEntry }[] = [];
  const main: GuardMain = async (argv, entry) => {
    calls.push({ argv, entry });
    stdout.forEach((line) => entry.out.stdout(line));
    stderr.forEach((line) => entry.out.stderr(line));
    return code;
  };
  return { main, calls };
}

/** A CLI run that never ends. */
const HANGING: GuardMain = () => new Promise<ExitCode>(() => undefined);

describe('judgeGuard', () => {
  it('passes on an empty answer and a JSON object, each with exit 0', () => {
    assert.deepEqual(judgeGuard('push-guard', { kind: 'answered', code: 0, stdout: [] }), { exitCode: 0, stdout: '', stderr: '' });
    assert.deepEqual(judgeGuard('push-guard', { kind: 'answered', code: 0, stdout: [''] }), { exitCode: 0, stdout: '', stderr: '' });
    assert.deepEqual(judgeGuard('push-guard', { kind: 'answered', code: 0, stdout: [DENY] }), { exitCode: 0, stdout: `${DENY}\n`, stderr: '' });
  });

  it("keeps a guard's own block, moving what it printed to stderr, where Claude Code shows it", () => {
    assert.deepEqual(judgeGuard('exec-guard', { kind: 'answered', code: EXIT.refused, stdout: ['REFUSED not yours'] }), { exitCode: 2, stdout: '', stderr: 'REFUSED not yours\n' });
    assert.deepEqual(judgeGuard('exec-guard', { kind: 'answered', code: EXIT.refused, stdout: [] }), { exitCode: 2, stdout: '', stderr: '' });
  });

  it('blocks on any other exit, naming the guard, the exit and the fix', () => {
    for (const code of [EXIT.failed, EXIT.usage, EXIT.printed]) {
      const verdict = judgeGuard('secret-guard', { kind: 'answered', code, stdout: [DENY] });
      assert.equal(verdict.exitCode, 2);
      assert.equal(verdict.stdout, '');
      assert.match(verdict.stderr, new RegExp(`^teamrig blocked this call: its secret-guard guard ended with exit ${code}, and a guard that cannot answer must not let a call through\\. Fix: run \`claude plugin update teamrig@teamrig\``));
    }
  });

  it('blocks on an answer that is not one JSON object, quoting at most 200 characters of it', () => {
    for (const stdout of [['garbled'], ['[1]'], ['null'], ['"deny"'], [DENY, DENY], [`${DENY} trailing`]]) {
      const verdict = judgeGuard('cold-send', { kind: 'answered', code: 0, stdout });
      assert.equal(verdict.exitCode, 2, stdout.join('|'));
      assert.match(verdict.stderr, /its cold-send guard printed something other than its JSON answer \(/);
    }
    const long = judgeGuard('cold-send', { kind: 'answered', code: 0, stdout: ['x'.repeat(500)] });
    assert.ok(long.stderr.includes(`("${'x'.repeat(200)}")`));
    assert.ok(!long.stderr.includes('x'.repeat(201)));
  });

  it('blocks a guard that could not load or crashed, with the first line of the cause', () => {
    const load = judgeGuard('package-guard', { kind: 'load-failed', cause: new SyntaxError("Unexpected token ';'\n    at line 3") });
    assert.equal(load.exitCode, 2);
    assert.match(load.stderr, /its package-guard guard could not load \(Unexpected token ';'\), and/);
    assert.ok(!load.stderr.includes('at line 3'));
    assert.match(judgeGuard('helper-gate', { kind: 'crashed', cause: 'a thrown string' }).stderr, /its helper-gate guard crashed \(a thrown string\), and/);
  });

  it('blocks a guard that gave no answer in time, and says to retry', () => {
    const verdict = judgeGuard('picker-guard', { kind: 'timed-out', limitMs: 12_000 });
    assert.equal(verdict.exitCode, 2);
    assert.match(verdict.stderr, /its picker-guard guard gave no answer within 12 s, .* Fix: retry the call; if every call times out/);
  });
});

describe('runGuard', () => {
  it("runs the CLI with the argv and the entry script, passes its answer on and lets the process end on its own", async () => {
    const host = new FakeHost();
    const run = answering(EXIT.ok, [DENY], ['a note']);
    await runGuard(ARGV, SCRIPT, async () => run.main, host);
    assert.deepEqual(run.calls.map(({ argv, entry }) => [argv, entry.script]), [[ARGV, SCRIPT]]);
    assert.deepEqual(host.written, [`${DENY}\n`]);
    assert.deepEqual(host.errors, ['a note\n']);
    assert.equal(host.exitCode, 0);
    assert.deepEqual(host.exits, []);
    assert.equal(host.limitMs, GUARD_LIMIT_MS);
    assert.equal(host.released, true);
  });

  it('blocks when the CLI cannot load, without running anything', async () => {
    const host = new FakeHost();
    await runGuard(ARGV, SCRIPT, () => Promise.reject(new Error("Cannot find module './hook.js'")), host);
    assert.deepEqual(host.exits, [2]);
    assert.deepEqual(host.written, []);
    assert.match(host.errors.join(''), /its push-guard guard could not load \(Cannot find module '\.\/hook\.js'\)/);
  });

  it('blocks when the run rejects', async () => {
    const host = new FakeHost();
    await runGuard(ARGV, SCRIPT, async () => () => Promise.reject(new TypeError('main is not a function')), host);
    assert.deepEqual(host.exits, [2]);
    assert.match(host.errors.join(''), /crashed \(main is not a function\)/);
  });

  it('blocks a run that outlives the limit, and an answer after that changes nothing', async () => {
    const host = new FakeHost();
    let finish: (code: ExitCode) => void = () => undefined;
    const late: GuardMain = (_argv, entry) =>
      new Promise<ExitCode>((resolve) => {
        finish = (code) => {
          entry.out.stdout(DENY);
          resolve(code);
        };
      });
    const running = runGuard(ARGV, SCRIPT, async () => late, host, 500);
    await setImmediate();
    assert.equal(host.limitMs, 500);
    host.timeOut();
    assert.deepEqual(host.exits, [2]);
    assert.match(host.errors.join(''), /gave no answer within 0\.5 s/);
    finish(EXIT.ok);
    await running;
    assert.deepEqual(host.written, []);
    assert.equal(host.exitCode, 2);
    assert.equal(host.errors.length, 1);
  });

  it('blocks on an uncaught exception or rejection before the answer', async () => {
    const host = new FakeHost();
    void runGuard(ARGV, SCRIPT, async () => HANGING, host);
    await setImmediate();
    host.crash(new Error('late throw'));
    assert.deepEqual(host.exits, [2]);
    assert.match(host.errors.join(''), /crashed \(late throw\)/);
  });

  it('keeps a given answer when the process crashes or lingers after it: it ends with the answer\'s code', async () => {
    const host = new FakeHost();
    await runGuard(ARGV, SCRIPT, async () => answering(EXIT.ok, [DENY]).main, host);
    host.crash(new Error('a stray rejection'));
    host.timeOut();
    assert.deepEqual(host.exits, [0, 0]);
    assert.deepEqual(host.written, [`${DENY}\n`]);
    assert.deepEqual(host.errors, []);
  });

  it('blocks when the answer cannot be written', async () => {
    const host = new FakeHost();
    host.failWrites = true;
    await runGuard(ARGV, SCRIPT, async () => answering(EXIT.ok, [DENY]).main, host);
    assert.deepEqual(host.exits, [2]);
    assert.equal(host.exitCode, undefined);
    assert.match(host.errors.join(''), /crashed \(EAGAIN/);
  });

  it('names the hook "hook" when argv names none', async () => {
    const host = new FakeHost();
    await runGuard([], SCRIPT, async () => answering(EXIT.usage).main, host);
    assert.match(host.errors.join(''), /its hook guard ended with exit 64/);
  });
});
