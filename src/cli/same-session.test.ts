import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { backgroundJobSessionOf, isForkOf } from './same-session.ts';

describe('isForkOf', () => {
  it('reads a fork resumed from the session or its transcript, in any flag spelling', () => {
    assert.ok(isForkOf('claude --fork-session --resume c0', 'c0'));
    assert.ok(isForkOf('claude --fork-session -r c0', 'c0'));
    assert.ok(isForkOf('claude --fork-session --resume=/p/c0.jsonl', 'c0'));
    assert.ok(isForkOf('claude\0--fork-session\0--resume\0/p/c0.jsonl', 'c0'));
  });

  it('is false without a fork flag, for another session, or for an unreadable command line', () => {
    assert.ok(!isForkOf('claude --resume c0', 'c0'));
    assert.ok(!isForkOf('claude --fork-session --resume c1', 'c0'));
    assert.ok(!isForkOf('claude --fork-session', 'c0'));
    assert.ok(!isForkOf(undefined, 'c0'));
  });
});

describe('backgroundJobSessionOf', () => {
  const host = 'claude bg-pty-host --bg-pty-host /s.sock 77 25 -- claude --session-id host-session';

  it("names the session of the job's background host, else the job's own", () => {
    assert.equal(backgroundJobSessionOf([{ commandLine: 'claude' }, { commandLine: host }]), 'host-session');
    assert.equal(backgroundJobSessionOf([{ commandLine: 'claude --session-id=own' }, { commandLine: 'x --bg-pty-host /s.sock' }]), 'own');
  });

  it('is undefined for a process no background host runs, a host beyond its hops, or a job naming no session', () => {
    assert.equal(backgroundJobSessionOf([{ commandLine: 'claude --session-id own' }, { commandLine: 'bash' }]), undefined);
    assert.equal(backgroundJobSessionOf([{ commandLine: 'claude' }, { commandLine: 'a' }, { commandLine: 'b' }, { commandLine: host }]), undefined);
    assert.equal(backgroundJobSessionOf([{ commandLine: 'claude' }, { commandLine: 'x --bg-pty-host /s.sock' }]), undefined);
    assert.equal(backgroundJobSessionOf([]), undefined);
  });
});
