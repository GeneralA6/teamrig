import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { askChecks, CheckOutput, checkReadiness, HOOK_LINE_MAX_CHARS, shownLine, type CheckRun } from './checks.ts';

const FLOW = { name: 'flow', command: ['node', 'checks/flow.js'] };
const REGISTRY = { name: 'registry', command: ['node', 'checks/registry.js'] };

function run(hooks: FakeHooks): CheckRun {
  return { hooks, scanner: new SecretScanner(), cwd: '/repo/app', env: { PATH: '/bin', TEAMRIG_VERB: 'deploy' }, timeoutSeconds: 20 };
}

describe('CheckOutput', () => {
  it('keeps the first line that is not a tag as the reason, and the last tag', () => {
    const output = new CheckOutput();
    ['', 'tag=v1', '  batch run open since 23:10 UTC  ', 'more detail', 'tag=sha-0f8e2c4a', 'tag=bad tag!'].forEach(output.hear);
    assert.equal(output.reason, 'batch run open since 23:10 UTC');
    assert.equal(output.tag, 'sha-0f8e2c4a');
  });

  it('has no reason or tag when the check printed none', () => {
    const output = new CheckOutput();
    assert.equal(output.reason, undefined);
    assert.equal(output.tag, undefined);
  });
});

describe('checkReadiness', () => {
  it('reads exit 0 as go, 2 as refuse and 75 as wait, each with the gate’s reason', () => {
    assert.deepEqual(checkReadiness('flow', { kind: 'exited', code: 0 }, 'clear', 20), { kind: 'go' });
    assert.deepEqual(checkReadiness('flow', { kind: 'exited', code: 2 }, 'the deploy is frozen', 20), { kind: 'refuse', reason: 'check flow refuses the deploy: the deploy is frozen' });
    assert.deepEqual(checkReadiness('flow', { kind: 'exited', code: 75 }, undefined, 20), { kind: 'wait', cause: 'check', reason: 'check flow holds the deploy' });
  });

  it('waits on any other end, so a broken check never lets a deploy through', () => {
    assert.deepEqual(checkReadiness('flow', { kind: 'exited', code: 1 }, 'TypeError: x is undefined', 20), {
      kind: 'wait',
      cause: 'check',
      reason: 'check flow failed (exit 1), so the deploy waits: TypeError: x is undefined',
    });
    assert.deepEqual(checkReadiness('flow', { kind: 'timedOut' }, undefined, 20), { kind: 'wait', cause: 'check', reason: 'check flow gave no answer within 20 s, so the deploy waits' });
    assert.deepEqual(checkReadiness('flow', { kind: 'signal', signal: 'SIGTERM' }, undefined, 20), { kind: 'wait', cause: 'check', reason: 'check flow was stopped by SIGTERM, so the deploy waits' });
    assert.deepEqual(checkReadiness('flow', { kind: 'notStarted', error: 'spawn node ENOENT' }, undefined, 20), {
      kind: 'wait',
      cause: 'check',
      reason: 'check flow could not start (spawn node ENOENT), so the deploy waits',
    });
    assert.deepEqual(checkReadiness('flow', { kind: 'stopped' }, undefined, 20), { kind: 'wait', cause: 'check', reason: 'check flow was killed when its launching shell ended, so the deploy waits' });
  });
});

describe('shownLine', () => {
  it('redacts a secret and cuts a long line', () => {
    const scanner = new SecretScanner();
    assert.equal(shownLine(scanner, ['probe failed: password', '=', 'hunter2'].join('')), 'probe failed: [redacted password or key assignment]');
    const long = shownLine(scanner, 'x'.repeat(1000));
    assert.equal(long.length, HOOK_LINE_MAX_CHARS);
    assert.ok(long.endsWith('…'));
  });
});

describe('askChecks', () => {
  it('asks each check in order with its name and phase, and goes with the last tag printed', async () => {
    const hooks = new FakeHooks().answer(FLOW.command, { lines: ['no flow open', 'tag=v1'] }).answer(REGISTRY.command, { lines: ['tag=sha-0f8e2c4a'] });
    const answer = await askChecks([FLOW, REGISTRY], 'locked', run(hooks));
    assert.deepEqual(answer, { readiness: { kind: 'go' }, tag: 'sha-0f8e2c4a' });
    assert.deepEqual(hooks.commands, ['node checks/flow.js', 'node checks/registry.js']);
    assert.deepEqual(
      hooks.ran.map((request) => [request.cwd, request.env['TEAMRIG_CHECK_NAME'], request.env['TEAMRIG_CHECK_PHASE'], request.env['TEAMRIG_VERB'], request.timeoutMs]),
      [
        ['/repo/app', 'flow', 'locked', 'deploy', 20_000],
        ['/repo/app', 'registry', 'locked', 'deploy', 20_000],
      ],
    );
  });

  it('stops at the first check that does not pass, with its redacted reason and no tag', async () => {
    const hooks = new FakeHooks().answer(FLOW.command, { lines: ['tag=v1', ['flow open; db password', '=', 'hunter2'].join('')], end: 75 });
    const answer = await askChecks([FLOW, REGISTRY], 'before', run(hooks));
    assert.deepEqual(answer, { readiness: { kind: 'wait', cause: 'check', reason: 'check flow holds the deploy: flow open; db [redacted password or key assignment]' }, tag: undefined });
    assert.deepEqual(hooks.commands, ['node checks/flow.js']);
  });

  it('goes with no tag when there are no checks', async () => {
    assert.deepEqual(await askChecks([], 'before', run(new FakeHooks())), { readiness: { kind: 'go' }, tag: undefined });
  });
});
