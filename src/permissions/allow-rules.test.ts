import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { countOf, formatCounts, isToolWide, KeepList, mergeCounts, normalRule, planAllowTrim, ruleClass } from './allow-rules.ts';

/** A value a rule can hold; no output may carry it. */
const HELD_VALUE = 'postgres://user:hunter22@db.example.net';

describe('normalRule', () => {
  it('reads a trailing :* as a trailing space and *, and leaves every other rule as it is', () => {
    assert.equal(normalRule('Bash(git push:*)'), 'Bash(git push *)');
    for (const rule of ['Bash(git push *)', 'Bash(a:*b)', 'WebSearch', 'Bash(', 'Read(//c/x/**)']) {
      assert.equal(normalRule(rule), rule);
    }
  });
});

describe('isToolWide', () => {
  it('holds for a bare tool, any * in the body, and a rule of no known shape', () => {
    for (const rule of ['Bash', 'WebFetch', 'Bash(node:*)', 'Bash(git push *)', 'Bash(rg * --files)', 'Read(//c/Users/me/**)', '(nothing)', 'Bash(open']) {
      assert.equal(isToolWide(rule), true, rule);
    }
  });

  it('does not hold for an exact command or a domain', () => {
    for (const rule of ['Bash(git log)', 'WebFetch(domain:example.com)', `Bash(psql ${HELD_VALUE})`]) {
      assert.equal(isToolWide(rule), false, rule);
    }
  });
});

describe('ruleClass', () => {
  it('names the tool for a named tool, mcp for an MCP tool, other or unreadable else, and never the body', () => {
    assert.equal(ruleClass('Bash(git push:*)'), 'Bash wide');
    assert.equal(ruleClass(`Bash(psql ${HELD_VALUE})`), 'Bash exact');
    assert.equal(ruleClass('mcp__server__tool'), 'mcp wide');
    assert.equal(ruleClass('hunter22'), 'other wide');
    assert.equal(ruleClass(`${HELD_VALUE}(x)`), 'unreadable wide');
  });
});

describe('KeepList', () => {
  const keep = new KeepList(['Bash(kubectl get *)', 'PowerShell(Get-Date:*)', 'WebSearch']);

  it('keeps a listed rule in either wildcard spelling, and the bare command of a kept prefix', () => {
    for (const rule of ['Bash(kubectl get *)', 'Bash(kubectl get:*)', 'Bash(kubectl get)', 'PowerShell(Get-Date *)', 'PowerShell(Get-Date)', 'WebSearch']) {
      assert.equal(keep.keeps(rule), true, rule);
    }
  });

  it('keeps nothing wider, longer or of another tool', () => {
    for (const rule of ['Bash(kubectl *)', 'Bash(kubectl get pods)', 'PowerShell(kubectl get *)', 'Bash(kubectl get * --watch)', 'WebSearch(x)', 'WebFetch']) {
      assert.equal(keep.keeps(rule), false, rule);
    }
  });
});

describe('planAllowTrim', () => {
  const keep = new KeepList(['Bash(kubectl get *)', 'WebSearch']);
  const allow = ['Bash(kubectl get:*)', 'Bash(git push:*)', `Bash(psql ${HELD_VALUE})`, 'WebSearch', 'Read(//c/Users/me/**)', 'WebFetch(domain:example.com)', 'Bash(node *)'];

  it('removes only the wide rules off the list by default, keeping the exact ones as counts', () => {
    const plan = planAllowTrim(allow, keep, 'wide');
    assert.deepEqual(plan.after, ['Bash(kubectl get:*)', `Bash(psql ${HELD_VALUE})`, 'WebSearch', 'WebFetch(domain:example.com)']);
    assert.deepEqual(plan.listed, ['Bash(kubectl get:*)', 'WebSearch']);
    assert.deepEqual(plan.keptOther, [['Bash exact', 1], ['WebFetch exact', 1]]);
    assert.deepEqual(plan.removed, [['Bash wide', 2], ['Read wide', 1]]);
  });

  it('removes every rule off the list with all', () => {
    const plan = planAllowTrim(allow, keep, 'all');
    assert.deepEqual(plan.after, ['Bash(kubectl get:*)', 'WebSearch']);
    assert.deepEqual(plan.keptOther, []);
    assert.deepEqual(plan.removed, [['Bash wide', 2], ['Bash exact', 1], ['Read wide', 1], ['WebFetch exact', 1]]);
    assert.equal(countOf(plan.removed), 5);
  });

  it('counts by class without any rule text', () => {
    const text = formatCounts(planAllowTrim(allow, keep, 'all').removed);
    assert.equal(text, 'Bash wide 2, Bash exact 1, Read wide 1, WebFetch exact 1');
    assert.ok(!text.includes('hunter22'));
  });
});

describe('mergeCounts', () => {
  it('adds up the classes of several counts, largest first, then by name', () => {
    const merged = mergeCounts([
      [
        ['Read wide', 1],
        ['Bash wide', 1],
      ],
      [
        ['Bash wide', 2],
        ['mcp exact', 3],
      ],
      [],
    ]);
    assert.deepEqual(merged, [
      ['Bash wide', 3],
      ['mcp exact', 3],
      ['Read wide', 1],
    ]);
    assert.deepEqual(mergeCounts([]), []);
  });
});
