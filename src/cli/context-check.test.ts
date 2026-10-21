import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP, CliHarness, SKILLS_DIR, TEAM, type RunOptions } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const AS_ALPHA = { env: { TEAMRIG_SESSION: 'alpha' } };
const AS_LEAD = { env: { TEAMRIG_SESSION: 'lead' } };
/** The team's CLAUDE.md budget [contextFiles.maxClaudeMdChars], at its lowest allowed value. */
const BUDGET = 1_000;
const HEADING = /^UNOWNED 1 warning\(s\) no session owns, so they go to the lead \(lead\): /;

describe('the warnings no session owns go to the lead (T951)', () => {
  it('prints a project CLAUDE.md over its budget as unowned in check and in the lead\'s start, not in another session\'s start', async () => {
    const kit = new CliHarness({ ...TEAM, contextFiles: { maxClaudeMdChars: BUDGET } });
    await kit.files.write(join(APP, 'CLAUDE.md'), 'x'.repeat(BUDGET));
    const within = await kit.run(['check'], AS_ALPHA);
    assert.equal(within.code, EXIT.ok, within.stderr.join('\n'));
    assert.equal(
      within.stdout.some((line) => line.startsWith('UNOWNED')),
      false,
      within.stdout.join('\n'),
    );
    await kit.files.write(join(APP, 'CLAUDE.md'), 'x'.repeat(BUDGET + 1));
    const runs: ReadonlyArray<readonly [readonly string[], RunOptions]> = [
      [['check'], AS_ALPHA],
      [['check', '--all'], AS_ALPHA],
      [['start'], AS_LEAD],
    ];
    for (const [argv, options] of runs) {
      const result = await kit.run([...argv], options);
      assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
      const at = result.stdout.findIndex((line) => HEADING.test(line));
      assert.notEqual(at, -1, `${argv.join(' ')}:\n${result.stdout.join('\n')}`);
      assert.match(
        result.stdout[at + 1] ?? '',
        /^ *from the context check \[contextFiles\.maxClaudeMdChars\]: WARN context-size CLAUDE\.md files \(.*CLAUDE\.md 1,001\): 1,001 characters .*\[contextFiles\.maxClaudeMdChars\]/,
      );
    }
    const alpha = await kit.run(['start'], AS_ALPHA);
    assert.equal(alpha.code, EXIT.ok, alpha.stderr.join('\n'));
    assert.equal(
      alpha.stdout.some((line) => line.startsWith('UNOWNED')),
      false,
      alpha.stdout.join('\n'),
    );
  });

  it("moves a skill's flags out of SKILLS into the lead's UNOWNED when its owner is no session on the team", async () => {
    const kit = new CliHarness(TEAM);
    await kit.files.write(join(SKILLS_DIR, 'orphan', 'SKILL.md'), '---\nname: orphan\ndescription: A skill with an owner who left.\n---\nOwner: ghost\nLast verified: 2030-01-01\n');
    const lead = await kit.run(['start', '--all'], AS_LEAD);
    assert.equal(lead.code, EXIT.ok, lead.stderr.join('\n'));
    assert.equal(lead.stdout.includes(`SKILLS 0 flag(s) in ${SKILLS_DIR}`), true, lead.stdout.join('\n'));
    assert.equal(lead.stdout.includes(`from the skill check of ${SKILLS_DIR}: SKILL OWNER (owner ghost is not a session on the team) ghost orphan`), true, lead.stdout.join('\n'));
  });
});
