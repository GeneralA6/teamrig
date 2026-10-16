import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_HIRING } from '../config/defaults.ts';
import { resumeVerdict, type ResumeFacts } from './rehire.ts';

const NOW = Date.parse('2030-01-15T10:00:00Z');
const DAY_MS = 86_400_000;
const CLAUDE = '0123abcd-0000-4000-8000-00000000000a';
const LAST = `its last Claude Code session ${CLAUDE}`;

function facts(overrides: Partial<ResumeFacts> = {}): ResumeFacts {
  return { claudeSession: CLAUDE, changedAt: NOW - 2 * DAY_MS, tokens: 120_000, ...overrides };
}

describe('resumeVerdict', () => {
  it('resumes a recent, small session, with its numbers', () => {
    assert.deepEqual(resumeVerdict(facts(), DEFAULT_HIRING, NOW), { kind: 'resume', claudeSession: CLAUDE, detail: `${LAST} holds 120000 tokens of context, idle 2.0 day(s)` });
    assert.equal(resumeVerdict(facts({ tokens: 250_000, changedAt: NOW - 7 * DAY_MS }), DEFAULT_HIRING, NOW).kind, 'resume', 'the limits themselves still resume');
    assert.match(resumeVerdict(facts({ changedAt: NOW + 1000 }), DEFAULT_HIRING, NOW).detail, /idle 0\.0 day/);
  });

  it('starts fresh with no session on record, its transcript gone or its context unread', () => {
    assert.deepEqual(resumeVerdict(facts({ claudeSession: undefined }), DEFAULT_HIRING, NOW), { kind: 'fresh', detail: 'no Claude Code session of it is on record' });
    assert.deepEqual(resumeVerdict(facts({ changedAt: undefined }), DEFAULT_HIRING, NOW), { kind: 'fresh', detail: `${LAST} has no transcript in this project folder` });
    assert.deepEqual(resumeVerdict(facts({ tokens: undefined }), DEFAULT_HIRING, NOW), { kind: 'fresh', detail: `the context of ${LAST} could not be read` });
  });

  it('starts fresh past either limit, naming it', () => {
    assert.deepEqual(resumeVerdict(facts({ tokens: 250_001 }), DEFAULT_HIRING, NOW), {
      kind: 'fresh',
      detail: `${LAST} holds 250001 tokens of context, idle 2.0 day(s): over hiring.resumeMaxTokens 250000`,
    });
    assert.deepEqual(resumeVerdict(facts({ changedAt: NOW - 7 * DAY_MS - 1 }), DEFAULT_HIRING, NOW), {
      kind: 'fresh',
      detail: `${LAST} holds 120000 tokens of context, idle 7.0 day(s): over hiring.resumeMaxIdleDays 7`,
    });
    assert.equal(resumeVerdict(facts(), { resumeMaxTokens: 100_000, resumeMaxIdleDays: 7 }, NOW).kind, 'fresh');
  });
});
