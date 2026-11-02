import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { CoreRuleKey } from './keys.ts';
import { PLACE_KINDS, type PlaceKind } from './places.ts';
import { loadsUnasked, rankCandidates } from './rank.ts';
import type { Candidate } from './scan.ts';
import type { LineTag } from './topics.ts';

function candidate(kind: PlaceKind, line: number, text: string, rules: readonly CoreRuleKey[] = ['push'], tags: readonly LineTag[] = []): Candidate {
  return { place: { kind, path: `/work/app/${kind}.md` }, line, text, topics: { rules, tags } };
}

/** Where each ranked candidate sits, as `<kind>:<line>`. */
function order(candidates: readonly Candidate[]): string[] {
  return rankCandidates(candidates).map(({ place, line }) => `${place.kind}:${line}`);
}

const PLAIN = 'Push straight to the release branch when a fix is ready.';

describe('rankCandidates', () => {
  it('puts the lines a session reads unasked first, then hooks and memory, then skills, keeping the scan order among equals', () => {
    const scanned = [
      candidate('claude-md', 1, PLAIN),
      candidate('rules', 2, PLAIN),
      candidate('skill', 3, PLAIN),
      candidate('memory', 4, PLAIN),
      candidate('team-rules', 5, PLAIN),
      candidate('hook', 6, PLAIN),
      candidate('settings', 7, PLAIN),
    ];
    assert.deepEqual(order(scanned), ['claude-md:1', 'rules:2', 'team-rules:5', 'settings:7', 'memory:4', 'hook:6', 'skill:3']);
  });

  it('within one place weight, puts a line naming the kit first, then one that directs or says which rule wins', () => {
    const scanned = [
      candidate('claude-md', 1, PLAIN),
      candidate('claude-md', 2, 'Where these notes say otherwise, they win.', [], ['precedence']),
      candidate('claude-md', 3, 'Never open a pull request before the lead agrees.'),
      candidate('claude-md', 4, 'The teamrig merge step runs from the release script here.', ['own-change'], ['teamrig']),
      candidate('claude-md', 5, 'Any session may merge a finished branch for another one.', ['own-change']),
    ];
    assert.deepEqual(order(scanned), ['claude-md:4', 'claude-md:2', 'claude-md:3', 'claude-md:5', 'claude-md:1']);
  });

  it('ranks by where a line loads before what it says: a skill line naming the kit comes after a plain CLAUDE.md line', () => {
    const scanned = [candidate('skill', 1, 'Never run teamrig merge from this skill.', ['own-change'], ['teamrig']), candidate('claude-md', 2, PLAIN)];
    assert.deepEqual(order(scanned), ['claude-md:2', 'skill:1']);
  });

  it('keeps every candidate, a plain imperative too, and never ranks a line up for the topics a long line touches', () => {
    const long = candidate('claude-md', 1, `${PLAIN} Then deploy, message the lead, update the register and commit.`, ['messages', 'register', 'deploy', 'commits', 'push']);
    const short = candidate('claude-md', 2, PLAIN);
    assert.deepEqual(order([short, long]), ['claude-md:2', 'claude-md:1']);
    assert.deepEqual(order([long, short]), ['claude-md:1', 'claude-md:2']);
  });
});

describe('loadsUnasked', () => {
  it('holds for a CLAUDE.md, a rules file, the team rules and settings, never for a skill, a memory file or a hook', () => {
    const unasked = PLACE_KINDS.filter((kind) => loadsUnasked(candidate(kind, 1, PLAIN)));
    assert.deepEqual(unasked, ['claude-md', 'rules', 'team-rules', 'settings']);
  });
});
