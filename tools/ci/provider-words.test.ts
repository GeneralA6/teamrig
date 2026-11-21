import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { type SkillFile, baselineText, compareCounts, hitLine, parseBaseline, providerHits, skillCounts, termPattern } from './provider-words.ts';

const file = (skill: string, ...lines: readonly string[]): SkillFile => ({ skill, path: `${skill}/SKILL.md`, text: lines.join('\n') });
/** One file's hits, each as `<line> <term>`. */
const hits = (source: SkillFile): string[] => providerHits([source]).map((hit) => `${hit.line} ${hit.term}`);

describe('termPattern', () => {
  it('bounds a term at its word-character edges, so gh never hits high or a longer word', () => {
    const gh = termPattern('gh');
    assert.equal('a high bar, ghost, ghx'.match(gh), null);
    assert.deepEqual('run gh pr, `gh`, gh:acme/web, teamrig-gh-acme'.match(gh), ['gh', 'gh', 'gh', 'gh']);
  });

  it('takes a non-word edge as it is and escapes the pattern characters', () => {
    assert.deepEqual('see .claude/skills and x.claude/y'.match(termPattern('.claude/')), ['.claude/', '.claude/']);
    assert.equal('see aclaude/'.match(termPattern('.claude/')), null);
    assert.deepEqual('type /clear, not /clearly'.match(termPattern('/clear')), ['/clear']);
    assert.equal('CLAUDExmd'.match(termPattern('CLAUDE.md')), null);
  });

  it('matches case-blind', () => {
    assert.deepEqual('GitHub, github.com, GITHUB_TOKEN'.match(termPattern('GitHub')), ['GitHub', 'github']);
    assert.deepEqual('Pull request and pull request'.match(termPattern('pull request')), ['Pull request', 'pull request']);
  });
});

describe('providerHits', () => {
  it("finds each term once per match, by line, in the terms' order, as the list spells it", () => {
    const skill = file('s/one', 'Open a pull request on GitHub with gh pr create.', 'Then /clear.', 'jira and JQL', 'nothing here');
    assert.deepEqual(hits(skill), ['1 GitHub', '1 gh', '1 pull request', '2 /clear', '3 Jira', '3 JQL']);
  });

  it('counts a term twice on one line', () => {
    assert.deepEqual(hits(file('s/one', 'GitHub, then GitHub again')), ['1 GitHub', '1 GitHub']);
  });

  it('prints a hit as path, line and term', () => {
    const [hit] = providerHits([file('s/one', '', 'Claude Code')]);
    assert.ok(hit);
    assert.equal(hitLine(hit), 's/one/SKILL.md:2: Claude Code');
  });
});

describe('skillCounts', () => {
  it("sums each skill's files and lists a skill with none at 0, sorted by folder", () => {
    const files = [file('s/two', 'GitHub'), file('s/one', 'nothing'), { skill: 's/two', path: 's/two/more.md', text: 'gh and JQL' }];
    assert.deepEqual([...skillCounts(files)], [['s/one', 0], ['s/two', 3]]);
  });
});

describe('compareCounts', () => {
  it('sorts the counts into rose, fell and gone, a skill the baseline lacks having 0', () => {
    const counts = new Map([['a', 3], ['b', 1], ['c', 2], ['d', 0]]);
    const baseline = new Map([['a', 3], ['b', 4], ['z', 1]]);
    assert.deepEqual(compareCounts(counts, baseline), {
      rose: [{ skill: 'c', count: 2, baseline: 0 }],
      fell: [{ skill: 'b', count: 1, baseline: 4 }],
      gone: ['z'],
    });
  });
});

describe('the baseline file', () => {
  it('reads back what it writes, skills sorted', () => {
    const text = baselineText(new Map([['b', 2], ['a', 0]]));
    assert.match(text, /"a": 0,\n {4}"b": 2\n/);
    assert.ok(text.endsWith('}\n'));
    assert.deepEqual([...parseBaseline(JSON.parse(text))], [['a', 0], ['b', 2]]);
  });

  it('refuses a file without a skills object or with a count that is not a whole number', () => {
    assert.throws(() => parseBaseline([]), /needs a "skills" object/);
    assert.throws(() => parseBaseline({ skills: [] }), /needs a "skills" object/);
    assert.throws(() => parseBaseline({ skills: { a: '1' } }), /count of a is not a whole number/);
    assert.throws(() => parseBaseline({ skills: { a: 1.5 } }), /count of a is not a whole number/);
    assert.throws(() => parseBaseline({ skills: { a: -1 } }), /count of a is not a whole number/);
  });
});
