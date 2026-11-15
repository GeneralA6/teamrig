import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ServiceRoleConfig } from '../config/types.ts';
import { isRecord, recordField, stringField } from '../core/guards.ts';
import { toJsonlLine } from '../core/jsonl.ts';
import { ROLE_CAP_WINDOW_MS, roleAllowOutput, roleAllowRecord, roleAllowsSince, roleCapOutput, roleHolding } from './service-role-allow.ts';

const ROLES: Readonly<Record<string, ServiceRoleConfig>> = {
  github: { holders: ['alpha'], commands: ['issue close', 'issue comment'] },
  bot: { holders: ['alpha', 'bravo'], commands: ['issue comment'] },
  open: { holders: 'team', commands: ['issue close'] },
  ship: { holders: 'team', commands: ['queue ship', 'queue merge'] },
};

function decisionOf(output: string): string | undefined {
  const parsed: unknown = JSON.parse(output);
  assert.ok(isRecord(parsed));
  return stringField(recordField(parsed, 'hookSpecificOutput') ?? {}, 'permissionDecision');
}

describe('service-role allow: who holds what', () => {
  it('finds the role naming the holder for the command, the first by name when two do', () => {
    assert.equal(roleHolding(ROLES, 'issue close', 'alpha'), 'github');
    assert.equal(roleHolding(ROLES, 'issue comment', 'alpha'), 'bot');
    assert.equal(roleHolding(ROLES, 'issue comment', 'bravo'), 'bot');
  });

  it('gives no role to a session it does not name, nor through "team" for a command that acts as whoever runs it', () => {
    assert.equal(roleHolding(ROLES, 'issue close', 'bravo'), undefined);
    assert.equal(roleHolding(ROLES, 'issue close', 'charlie'), undefined);
    assert.equal(roleHolding({}, 'issue close', 'alpha'), undefined);
  });

  it('gives a ship and merge to every session through "team", since the allow holds each to its own task branch (C4)', () => {
    assert.equal(roleHolding(ROLES, 'queue ship', 'charlie'), 'ship');
    assert.equal(roleHolding(ROLES, 'queue merge', 'alpha'), 'ship');
    assert.equal(roleHolding({ github: { holders: ['alpha'], commands: ['issue close'] } }, 'queue ship', 'alpha'), undefined);
  });
});

describe('service-role allow: the daily cap and the log', () => {
  const now = Date.parse('2030-01-07T12:00:00.000Z');
  const call = { command: 'issue close', target: 'acme/web#7', session: 'alpha' } as const;
  const line = (at: string, role: string): string => toJsonlLine(roleAllowRecord({ at: new Date(at), session: 'alpha', claudeSession: 'c', role, call }));

  it('counts the role allows of that role since the window opened, and nothing else', () => {
    const log = [
      line('2030-01-06T11:59:59.000Z', 'github'),
      line('2030-01-06T12:00:00.000Z', 'github'),
      line('2030-01-07T11:00:00.000Z', 'github'),
      line('2030-01-07T11:00:00.000Z', 'bot'),
      toJsonlLine({ v: 1, at: '2030-01-07T11:00:00.000Z', answer: 'route', route: 'merge', role: 'github' }),
      toJsonlLine({ v: 1, at: 'yesterday', answer: 'role', role: 'github' }),
      toJsonlLine({ v: 1, at: '2030-01-07T11:00:00.000Z', answer: 'role', role: 'github', command: 'queue merge', target: 't1-cli' }),
      'not json',
    ].join('');
    assert.equal(roleAllowsSince(log, 'github', now - ROLE_CAP_WINDOW_MS), 2);
    assert.equal(roleAllowsSince('', 'github', 0), 0);
  });

  it('logs the role, command and issue, never the text', () => {
    const record = roleAllowRecord({ at: new Date(now), session: 'alpha', claudeSession: 'c', role: 'github', call });
    assert.deepEqual(record, {
      v: 1,
      at: '2030-01-07T12:00:00.000Z',
      session: 'alpha',
      claudeSession: 'c',
      tool: 'Bash',
      event: 'PreToolUse',
      answer: 'role',
      role: 'github',
      command: 'issue close',
      target: 'acme/web#7',
    });
  });

  it('allows a call naming its role, and asks past the cap, refusing when asks are off', () => {
    assert.equal(decisionOf(roleAllowOutput('github', call)), 'allow');
    assert.equal(decisionOf(roleCapOutput('github', 10, 'ask')), 'ask');
    assert.equal(decisionOf(roleCapOutput('github', 10, 'refuse')), 'deny');
  });
});
