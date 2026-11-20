import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isRecord, recordField, stringField, type JsonRecord } from '../core/guards.ts';
import { toJsonlLine } from '../core/jsonl.ts';
import { ASK_REFUSED_NOTE } from './permission.ts';
import { replyText } from '../testing/host.ts';
import { ROLE_CAP_WINDOW_MS, roleAllowRecord, roleAllowReply, roleAllowsSince, roleCapReply } from './service-role-allow.ts';

function recordOf(output: string): JsonRecord {
  const parsed: unknown = JSON.parse(output);
  assert.ok(isRecord(parsed));
  return parsed;
}

function decisionOf(output: string): string | undefined {
  return stringField(recordField(recordOf(output), 'hookSpecificOutput') ?? {}, 'permissionDecision');
}

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

  it('weighs a migrate by the issue rows its line names, and any line with no positive whole count as one (T4606)', () => {
    const migrate = { command: 'issue migrate', target: '/kit/teams/app/tasks/T1/rows.jsonl', session: 'alpha' } as const;
    const at = '2030-01-07T11:00:00.000Z';
    const counted = toJsonlLine(roleAllowRecord({ at: new Date(at), session: 'alpha', claudeSession: 'c', role: 'github', call: migrate, count: 5 }));
    const odd = [0, -2, 1.5, '7'].map((count) => toJsonlLine({ v: 1, at, answer: 'role', role: 'github', command: 'issue migrate', target: 'x', count }));
    assert.equal(roleAllowsSince([counted, line(at, 'github'), ...odd].join(''), 'github', now - ROLE_CAP_WINDOW_MS), 5 + 1 + odd.length);
    assert.equal(recordOf(counted)['count'], 5);
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

  it('writes the line as it does today, naming the tab claudeSession: the cap reads the role and the time, never the id (T4762)', () => {
    assert.equal(
      line('2030-01-07T12:00:00.000Z', 'github'),
      '{"v":1,"at":"2030-01-07T12:00:00.000Z","session":"alpha","claudeSession":"c","tool":"Bash","event":"PreToolUse","answer":"role","role":"github","command":"issue close","target":"acme/web#7"}\n',
    );
  });

  it('allows a call naming its role, and refuses past the cap, saying when it runs again and the route (T3356)', () => {
    assert.equal(decisionOf(replyText('tool-start', roleAllowReply('github', call))), 'allow');
    const capped = replyText('tool-start', roleCapReply('github', 10));
    assert.equal(decisionOf(capped), 'deny');
    const reason = stringField(recordField(recordOf(capped), 'hookSpecificOutput') ?? {}, 'permissionDecisionReason') ?? '';
    assert.match(reason, /ran its 10 calls .* is refused\. The role runs again once its oldest call of the window is 24 hours old/);
    assert.ok(reason.endsWith(` ${ASK_REFUSED_NOTE}`), reason);
    assert.doesNotMatch(reason, /Owner: allow/);
  });
});
