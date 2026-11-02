import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { CORE_RULE_KEYS, type CoreRuleKey } from './keys.ts';
import { RULE_LINE_MIN_CHARS, topicsLabel, topicsOf } from './topics.ts';

/** A line for each core rule that conflicts with it, as such lines read in a CLAUDE.md, a skill or a memory file. */
const CONFLICTS: Readonly<Record<CoreRuleKey, string>> = {
  roles: '- The web session owns the priorities of the whole team.',
  'own-change': 'Any session may merge a finished branch for another one.',
  messages: 'Ping the lead after every step so it knows where you are.',
  register: '- Track your work on your own board file and post status there.',
  'task-order': 'Set up a cron that wakes you every ten minutes to check things.',
  'owner-gates': 'If nobody objects within an hour, treat it as approved.',
  deploy: 'Batch fixes and deploy them all on Friday afternoon.',
  'lean-calls': 'Use haiku subagents for searches, they are cheaper.',
  investigate: 'Skip the options and numbers, just pick one yourself.',
  resources: 'When a pod runs out of memory, raise its limits and move on.',
  data: 'Delete stale rows by hand whenever the table looks too big.',
  contracts: 'Change the api response shape whenever the web needs it, no contract talk.',
  skills: 'Keep procedures in MEMORY.md rather than in a SKILL.md file.',
  commits: 'Commit everything at the end of the day in one go.',
  push: 'Use --force when a push is rejected, it is faster.',
  worktrees: 'Work directly on main in the shared checkout to save time.',
};

describe('topicsOf', () => {
  it('ties a conflicting line to its rule, for every core rule', () => {
    for (const key of CORE_RULE_KEYS) {
      assert.ok(topicsOf(CONFLICTS[key])?.rules.includes(key), `${key}: ${CONFLICTS[key]}`);
    }
  });

  it('ties a line that still says integrate, the old name of merge, to owning your change', () => {
    assert.ok(topicsOf('Any session may integrate a finished branch for another one.')?.rules.includes('own-change'));
  });

  it('ties a line that names the delivery owner, or still the coordinator, to the roles', () => {
    assert.ok(topicsOf('The api session is the delivery owner of this repository.')?.rules.includes('roles'));
    assert.ok(topicsOf('The api session is the coordinator of this repository.')?.rules.includes('roles'));
  });

  it('ties a line about queued steps, or still heavy ones, to deploying', () => {
    assert.ok(topicsOf('Run every build as a queued step, never by hand.')?.rules.includes('deploy'));
    assert.ok(topicsOf('Run every build as a heavy step, never by hand.')?.rules.includes('deploy'));
  });

  it('tags a line that says which rule wins or names teamrig, whatever its topic', () => {
    assert.deepEqual(topicsOf('Where these notes say otherwise, they win.'), { rules: [], tags: ['precedence'] });
    assert.deepEqual(topicsOf('The teamrig rules do not apply in this repo.')?.tags, ['teamrig']);
    assert.deepEqual(topicsOf('This replaces the old rule: ask the lead instead of the owner.'), {
      rules: ['roles', 'owner-gates'],
      tags: ['precedence'],
    });
  });

  it('labels the topics by rule number and key, then the tags, leaving out an empty part', () => {
    assert.equal(topicsLabel({ rules: ['own-change', 'deploy'], tags: ['teamrig'] }), '2 own-change, 7 deploy; teamrig');
    assert.equal(topicsLabel({ rules: ['push'], tags: [] }), '15 push');
    assert.equal(topicsLabel({ rules: [], tags: ['precedence', 'teamrig'] }), 'precedence, teamrig');
  });

  it('skips a short line and a line with no topic', () => {
    assert.equal(topicsOf('## Commit rules'), undefined);
    assert.equal(topicsOf(`${' '.repeat(10)}${'p'.repeat(RULE_LINE_MIN_CHARS - 1)}`), undefined);
    assert.equal(topicsOf('Prices are shown in the local currency of each user.'), undefined);
  });
});
