import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { FakeHooks } from '../testing/fake-hooks.ts';
import { askGates, GateOutput, gateReadiness, HOOK_LINE_MAX_CHARS, shownLine, type GateRun } from './gates.ts';

const FLOW = { name: 'flow', command: ['node', 'gates/flow.js'] };
const REGISTRY = { name: 'registry', command: ['node', 'gates/registry.js'] };

function run(hooks: FakeHooks): GateRun {
  return { hooks, scanner: new SecretScanner(), cwd: '/repo/app', env: { PATH: '/bin', TEAMRIG_VERB: 'roll' }, timeoutSeconds: 20 };
}

describe('GateOutput', () => {
  it('keeps the first line that is not a tag as the reason, and the last tag', () => {
    const output = new GateOutput();
    ['', 'tag=v1', '  batch run open since 23:10 UTC  ', 'more detail', 'tag=sha-0f8e2c4a', 'tag=bad tag!'].forEach(output.hear);
    assert.equal(output.reason, 'batch run open since 23:10 UTC');
    assert.equal(output.tag, 'sha-0f8e2c4a');
  });

  it('has no reason or tag when the gate printed none', () => {
    const output = new GateOutput();
    assert.equal(output.reason, undefined);
    assert.equal(output.tag, undefined);
  });
});

describe('gateReadiness', () => {
  it('reads exit 0 as go, 2 as refuse and 75 as wait, each with the gate’s reason', () => {
    assert.deepEqual(gateReadiness('flow', { kind: 'exited', code: 0 }, 'clear', 20), { kind: 'go' });
    assert.deepEqual(gateReadiness('flow', { kind: 'exited', code: 2 }, 'the roll is frozen', 20), { kind: 'refuse', reason: 'gate flow refuses the roll: the roll is frozen' });
    assert.deepEqual(gateReadiness('flow', { kind: 'exited', code: 75 }, undefined, 20), { kind: 'wait', reason: 'gate flow holds the roll' });
  });

  it('waits on any other end, so a broken gate never lets a roll through', () => {
    assert.deepEqual(gateReadiness('flow', { kind: 'exited', code: 1 }, 'TypeError: x is undefined', 20), {
      kind: 'wait',
      reason: 'gate flow failed (exit 1), so the roll waits: TypeError: x is undefined',
    });
    assert.deepEqual(gateReadiness('flow', { kind: 'timedOut' }, undefined, 20), { kind: 'wait', reason: 'gate flow gave no answer within 20 s, so the roll waits' });
    assert.deepEqual(gateReadiness('flow', { kind: 'signal', signal: 'SIGTERM' }, undefined, 20), { kind: 'wait', reason: 'gate flow was stopped by SIGTERM, so the roll waits' });
    assert.deepEqual(gateReadiness('flow', { kind: 'notStarted', error: 'spawn node ENOENT' }, undefined, 20), {
      kind: 'wait',
      reason: 'gate flow could not start (spawn node ENOENT), so the roll waits',
    });
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

describe('askGates', () => {
  it('asks each gate in order with its name and phase, and goes with the last tag printed', async () => {
    const hooks = new FakeHooks().answer(FLOW.command, { lines: ['no flow open', 'tag=v1'] }).answer(REGISTRY.command, { lines: ['tag=sha-0f8e2c4a'] });
    const answer = await askGates([FLOW, REGISTRY], 'locked', run(hooks));
    assert.deepEqual(answer, { readiness: { kind: 'go' }, tag: 'sha-0f8e2c4a' });
    assert.deepEqual(hooks.commands, ['node gates/flow.js', 'node gates/registry.js']);
    assert.deepEqual(
      hooks.ran.map((request) => [request.cwd, request.env['TEAMRIG_GATE_NAME'], request.env['TEAMRIG_GATE_PHASE'], request.env['TEAMRIG_VERB'], request.timeoutMs]),
      [
        ['/repo/app', 'flow', 'locked', 'roll', 20_000],
        ['/repo/app', 'registry', 'locked', 'roll', 20_000],
      ],
    );
  });

  it('stops at the first gate that does not pass, with its redacted reason and no tag', async () => {
    const hooks = new FakeHooks().answer(FLOW.command, { lines: ['tag=v1', ['flow open; db password', '=', 'hunter2'].join('')], end: 75 });
    const answer = await askGates([FLOW, REGISTRY], 'before', run(hooks));
    assert.deepEqual(answer, { readiness: { kind: 'wait', reason: 'gate flow holds the roll: flow open; db [redacted password or key assignment]' }, tag: undefined });
    assert.deepEqual(hooks.commands, ['node gates/flow.js']);
  });

  it('goes with no tag when there are no gates', async () => {
    assert.deepEqual(await askGates([], 'before', run(new FakeHooks())), { readiness: { kind: 'go' }, tag: undefined });
  });
});
