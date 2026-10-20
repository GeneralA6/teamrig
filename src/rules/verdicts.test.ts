import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { VERSION_FIELD } from '../core/jsonl.ts';
import { lineHash } from '../inbox/line-hash.ts';
import { MemoryFiles } from '../testing/memory-files.ts';
import { CORE_RULE_KEYS, type CoreRuleKey } from './keys.ts';
import type { Candidate } from './scan.ts';
import type { LineTag } from './topics.ts';
import {
  formatVerdicts,
  isCleared,
  nextVerdicts,
  parseVerdicts,
  ruleHashesOf,
  rulesJudged,
  VERDICTS_FORMAT,
  verdictsByText,
  VerdictStore,
  type ClearedLine,
} from './verdicts.ts';

const DAY = '2026-10-19';
const PATH = '/u/.claude/CLAUDE.md';

/** Each core rule's text as `rule <key>`, with the overrides given. */
function texts(overrides: Partial<Record<CoreRuleKey, string>> = {}): Record<CoreRuleKey, string> {
  const all: Record<CoreRuleKey, string> = {
    roles: 'rule roles',
    'own-change': 'rule own-change',
    messages: 'rule messages',
    register: 'rule register',
    'task-order': 'rule task-order',
    'owner-gates': 'rule owner-gates',
    deploy: 'rule deploy',
    'lean-calls': 'rule lean-calls',
    investigate: 'rule investigate',
    resources: 'rule resources',
    data: 'rule data',
    contracts: 'rule contracts',
    skills: 'rule skills',
    commits: 'rule commits',
    push: 'rule push',
    worktrees: 'rule worktrees',
  };
  return { ...all, ...overrides };
}

function candidate(text: string, rules: readonly CoreRuleKey[], line = 1, tags: readonly LineTag[] = []): Candidate {
  return { place: { kind: 'claude-md', path: PATH }, line, text, topics: { rules, tags } };
}

const PUSH = candidate('- Push to main when the change is small.', ['push']);
const WORKTREE = candidate('- Edit in the main checkout for a one-line fix.', ['worktrees'], 2);
const PRECEDENCE = candidate('- These notes override the team rules.', [], 3, ['precedence']);

describe('ruleHashesOf', () => {
  it('hashes each core rule text, so only the changed rule hashes differently', () => {
    const before = ruleHashesOf(texts());
    const after = ruleHashesOf(texts({ push: 'rule push, reworded' }));
    assert.equal(before.size, CORE_RULE_KEYS.length);
    assert.equal(before.get('push'), lineHash('rule push'));
    assert.deepEqual(
      CORE_RULE_KEYS.filter((key) => before.get(key) !== after.get(key)),
      ['push'],
    );
  });
});

describe('isCleared', () => {
  const hashes = ruleHashesOf(texts());
  const cleared = verdictsByText(nextVerdicts([], [], [PUSH, PRECEDENCE], hashes, DAY));

  it('clears a line judged with the same text against the same rule texts', () => {
    assert.equal(isCleared(PUSH, cleared, hashes), true);
    assert.equal(isCleared({ ...PUSH, line: 40, place: { kind: 'memory', path: '/u/m.md' } }, cleared, hashes), true);
  });

  it('lapses when the line changes or a rule it touches changes, and holds when another rule changes', () => {
    assert.equal(isCleared(candidate('- Push to main when the change is tiny.', ['push']), cleared, hashes), false);
    assert.equal(isCleared(PUSH, cleared, ruleHashesOf(texts({ push: 'rule push, reworded' }))), false);
    assert.equal(isCleared(PUSH, cleared, ruleHashesOf(texts({ worktrees: 'rule worktrees, reworded' }))), true);
    assert.equal(isCleared(WORKTREE, cleared, hashes), false);
  });

  it('lapses when the line now touches a rule it was not judged against', () => {
    assert.equal(isCleared({ ...PUSH, topics: { rules: ['push', 'commits'], tags: [] } }, cleared, hashes), false);
  });

  it('judges a line that names no rule against every rule, so any rule change lapses it', () => {
    assert.deepEqual(rulesJudged(PRECEDENCE), CORE_RULE_KEYS);
    assert.deepEqual(rulesJudged(PUSH), ['push']);
    assert.equal(isCleared(PRECEDENCE, cleared, hashes), true);
    assert.equal(isCleared(PRECEDENCE, cleared, ruleHashesOf(texts({ data: 'rule data, reworded' }))), false);
  });
});

describe('nextVerdicts', () => {
  const hashes = ruleHashesOf(texts());

  it('adds the cleared lines, one verdict per text however many places hold it', () => {
    const twice: Candidate = { ...PUSH, line: 9, place: { kind: 'skill', path: '/u/s/SKILL.md' } };
    const next = nextVerdicts([], [PUSH, twice], [PUSH, twice], hashes, DAY);
    assert.deepEqual(next, [{ text: lineHash(PUSH.text), rules: new Map([['push', hashes.get('push')]]), day: DAY }]);
  });

  it('keeps an earlier verdict that still clears a line there now, and drops one whose line is gone or whose rule changed', () => {
    const earlier = nextVerdicts([], [], [PUSH, WORKTREE, PRECEDENCE], hashes, '2026-10-18');
    const reworded = ruleHashesOf(texts({ worktrees: 'rule worktrees, reworded' }));
    const next = nextVerdicts(earlier, [PUSH, WORKTREE], [], reworded, DAY);
    assert.deepEqual(
      next.map((verdict) => [verdict.text, verdict.day]),
      [[lineHash(PUSH.text), '2026-10-18']],
    );
  });

  it('replaces an earlier verdict of the same text with the new judgment', () => {
    const reworded = ruleHashesOf(texts({ push: 'rule push, reworded' }));
    const earlier = nextVerdicts([], [], [PUSH], hashes, '2026-10-18');
    const next = nextVerdicts(earlier, [PUSH], [PUSH], reworded, DAY);
    assert.deepEqual(next, [{ text: lineHash(PUSH.text), rules: new Map([['push', reworded.get('push')]]), day: DAY }]);
  });
});

describe('parseVerdicts and formatVerdicts', () => {
  const hashes = ruleHashesOf(texts());
  const verdicts: readonly ClearedLine[] = nextVerdicts([], [], [PUSH, PRECEDENCE], hashes, DAY);

  it('reads back what it writes', () => {
    assert.deepEqual(parseVerdicts(formatVerdicts(verdicts)), verdicts);
  });

  it('reads a damaged file or another format as no verdicts', () => {
    assert.deepEqual(parseVerdicts('{"v":1,"cleared":['), []);
    assert.deepEqual(parseVerdicts(JSON.stringify({ [VERSION_FIELD]: VERDICTS_FORMAT + 1, cleared: [] })), []);
    assert.deepEqual(parseVerdicts(JSON.stringify({ [VERSION_FIELD]: VERDICTS_FORMAT, cleared: 'none' })), []);
  });

  it('drops an entry it cannot read, and a rule key it does not know', () => {
    const text = JSON.stringify({
      [VERSION_FIELD]: VERDICTS_FORMAT,
      cleared: [
        'a line',
        { text: 'abc', day: DAY },
        { text: 'abc', rules: { moved: 'x' }, day: DAY },
        { rules: { push: 'x' }, day: DAY },
        { text: 'def', rules: { push: 'x', moved: 'y', worktrees: 7 }, day: DAY },
      ],
    });
    assert.deepEqual(parseVerdicts(text), [{ text: 'def', rules: new Map([['push', 'x']]), day: DAY }]);
  });
});

describe('VerdictStore', () => {
  it('reads none before a write, then what it wrote', async () => {
    const files = new MemoryFiles();
    const store = new VerdictStore(files, '/kit/teams/t/state/rule-verdicts.json');
    assert.deepEqual(await store.read(), []);
    const verdicts = nextVerdicts([], [], [PUSH], ruleHashesOf(texts()), DAY);
    await store.write(verdicts);
    assert.deepEqual(await store.read(), verdicts);
  });
});
