import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SecretScanner } from '../core/secrets.ts';
import { countOf, formatCounts, holdsCredential, isToolWide, KeepList, mergeCounts, normalRule, planAllowTrim, ruleClass } from './allow-rules.ts';

/** A value a rule can hold; no output may carry it. Joined, so no source line holds a URL the secret redactor catches. */
const HELD_VALUE = ['postgres://user:', 'hunter22', '@db.example.net'].join('');
/** A password assignment, joined here so no source line holds one. */
const ASSIGNED = ['PGPASSWORD', 'hunter22'].join('=');
const SECRETS = new SecretScanner();
/** A team's own secret shape (`register.secretPatterns`). */
const TEAM_SECRETS = new SecretScanner(['hush-[0-9]+']);

describe('normalRule', () => {
  it('reads a trailing :* as a trailing space and *, and leaves every other rule as it is', () => {
    assert.equal(normalRule('Bash(git push:*)'), 'Bash(git push *)');
    for (const rule of ['Bash(git push *)', 'Bash(a:*b)', 'WebSearch', 'Bash(', 'Read(//c/x/**)']) {
      assert.equal(normalRule(rule), rule);
    }
  });

  it("drops one leading MSYS_NO_PATHCONV=1 from a shell rule, and no other assignment or tool's", () => {
    assert.equal(normalRule('Bash(MSYS_NO_PATHCONV=1 kubectl get:*)'), 'Bash(kubectl get *)');
    assert.equal(normalRule('PowerShell(MSYS_NO_PATHCONV=1 Get-Date)'), 'PowerShell(Get-Date)');
    for (const rule of ['Bash(MSYS_NO_PATHCONV=0 kubectl get *)', 'Bash(NODE_OPTIONS=1 kubectl get *)', 'Read(MSYS_NO_PATHCONV=1 x)']) {
      assert.equal(normalRule(rule), rule);
    }
    assert.equal(normalRule('Bash(MSYS_NO_PATHCONV=1 MSYS_NO_PATHCONV=1 x)'), 'Bash(MSYS_NO_PATHCONV=1 x)');
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

describe('holdsCredential', () => {
  it("holds for a URL with a login, a password assignment and a team's own shape", () => {
    assert.equal(holdsCredential(`Bash(psql ${HELD_VALUE})`, SECRETS), true);
    assert.equal(holdsCredential(`Bash(${ASSIGNED} psql -h db)`, SECRETS), true);
    assert.equal(holdsCredential('Bash(deploy --token hush-42)', TEAM_SECRETS), true);
    assert.equal(holdsCredential('Bash(deploy --token hush-42)', SECRETS), false);
  });

  it('reads a trailing :* as the keep-list does, so a prefix ending in a key word is no assignment', () => {
    for (const rule of ['Bash(kubectl get secret:*)', 'Bash(kubectl get secret *)', 'Bash(git log)', 'WebFetch(domain:example.com)']) {
      assert.equal(holdsCredential(rule, SECRETS), false, rule);
    }
  });
});

describe('ruleClass', () => {
  it('names the tool for a named tool, mcp for an MCP tool, other or unreadable else, and never the body', () => {
    assert.equal(ruleClass('Bash(git push:*)', SECRETS), 'Bash wide');
    assert.equal(ruleClass('Bash(git log)', SECRETS), 'Bash exact');
    assert.equal(ruleClass('mcp__server__tool', SECRETS), 'mcp wide');
    assert.equal(ruleClass('hunter22', SECRETS), 'other wide');
    assert.equal(ruleClass('(nothing)', SECRETS), 'unreadable wide');
  });

  it('counts a rule that holds a credential as one, whatever else it approves', () => {
    assert.equal(ruleClass(`Bash(psql ${HELD_VALUE})`, SECRETS), 'Bash credential');
    assert.equal(ruleClass(`Bash(psql ${HELD_VALUE} *)`, SECRETS), 'Bash credential');
    assert.equal(ruleClass(`${HELD_VALUE}(x)`, SECRETS), 'unreadable credential');
    assert.equal(ruleClass('Bash(kubectl get secret:*)', SECRETS), 'Bash wide');
  });
});

describe('KeepList', () => {
  const keep = new KeepList(['Bash(kubectl get *)', 'PowerShell(Get-Date:*)', 'WebSearch']);

  it('keeps a listed rule in either wildcard spelling, and the bare command of a kept prefix', () => {
    for (const rule of ['Bash(kubectl get *)', 'Bash(kubectl get:*)', 'Bash(kubectl get)', 'PowerShell(Get-Date *)', 'PowerShell(Get-Date)', 'WebSearch']) {
      assert.equal(keep.keeps(rule), true, rule);
    }
  });

  it('keeps a listed shell rule behind MSYS_NO_PATHCONV=1', () => {
    for (const rule of ['Bash(MSYS_NO_PATHCONV=1 kubectl get:*)', 'Bash(MSYS_NO_PATHCONV=1 kubectl get)']) {
      assert.equal(keep.keeps(rule), true, rule);
    }
    assert.equal(new KeepList(['Bash(MSYS_NO_PATHCONV=1 kubectl get *)']).keeps('Bash(kubectl get:*)'), true);
  });

  it('keeps nothing wider, longer or of another tool', () => {
    for (const rule of ['Bash(kubectl *)', 'Bash(kubectl get pods)', 'PowerShell(kubectl get *)', 'Bash(kubectl get * --watch)', 'WebSearch(x)', 'WebFetch', 'Bash(MSYS_NO_PATHCONV=1 kubectl *)', 'Bash(NODE_OPTIONS=1 kubectl get *)']) {
      assert.equal(keep.keeps(rule), false, rule);
    }
  });
});

describe('planAllowTrim', () => {
  const keep = new KeepList(['Bash(kubectl get *)', 'WebSearch']);
  const allow = ['Bash(kubectl get:*)', 'Bash(git push:*)', `Bash(psql ${HELD_VALUE})`, 'WebSearch', 'Read(//c/Users/me/**)', 'WebFetch(domain:example.com)', 'Bash(node *)'];

  it('removes only the wide and credential rules off the list by default, keeping the other exact ones as counts', () => {
    const plan = planAllowTrim(allow, keep, 'wide', SECRETS);
    assert.deepEqual(plan.after, ['Bash(kubectl get:*)', 'WebSearch', 'WebFetch(domain:example.com)']);
    assert.deepEqual(plan.listed, ['Bash(kubectl get:*)', 'WebSearch']);
    assert.deepEqual(plan.keptOther, [['WebFetch exact', 1]]);
    assert.deepEqual(plan.removed, [['Bash wide', 2], ['Bash credential', 1], ['Read wide', 1]]);
  });

  it('removes every rule off the list with all', () => {
    const plan = planAllowTrim(allow, keep, 'all', SECRETS);
    assert.deepEqual(plan.after, ['Bash(kubectl get:*)', 'WebSearch']);
    assert.deepEqual(plan.keptOther, []);
    assert.deepEqual(plan.removed, [['Bash wide', 2], ['Bash credential', 1], ['Read wide', 1], ['WebFetch exact', 1]]);
    assert.equal(countOf(plan.removed), 5);
  });

  it('keeps a rule on the keep-list even when it holds a credential', () => {
    const plan = planAllowTrim(['Bash(deploy hush-42)'], new KeepList(['Bash(deploy hush-42)']), 'wide', TEAM_SECRETS);
    assert.deepEqual([plan.after, plan.removed], [['Bash(deploy hush-42)'], []]);
  });

  it('counts by class without any rule text', () => {
    const text = formatCounts(planAllowTrim(allow, keep, 'all', SECRETS).removed);
    assert.equal(text, 'Bash wide 2, Bash credential 1, Read wide 1, WebFetch exact 1');
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
