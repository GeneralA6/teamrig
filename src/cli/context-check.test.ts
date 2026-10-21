import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { APP, CliHarness, TEAM } from '../testing/cli-harness.ts';
import { EXIT } from './runtime.ts';

const AS_ALPHA = { env: { TEAMRIG_SESSION: 'alpha' } };
/** The team's CLAUDE.md budget [contextFiles.maxClaudeMdChars], at its lowest allowed value. */
const BUDGET = 1_000;

describe('check and start print the context flags (T393)', () => {
  it('flags a project CLAUDE.md over its budget in check and start, and prints no CONTEXT line within it', async () => {
    const kit = new CliHarness({ ...TEAM, contextFiles: { maxClaudeMdChars: BUDGET } });
    await kit.files.write(join(APP, 'CLAUDE.md'), 'x'.repeat(BUDGET));
    const within = await kit.run(['check'], AS_ALPHA);
    assert.equal(within.code, EXIT.ok, within.stderr.join('\n'));
    assert.equal(
      within.stdout.some((line) => line.startsWith('CONTEXT')),
      false,
      within.stdout.join('\n'),
    );
    await kit.files.write(join(APP, 'CLAUDE.md'), 'x'.repeat(BUDGET + 1));
    for (const argv of [['check'], ['start'], ['check', '--all']]) {
      const result = await kit.run(argv, AS_ALPHA);
      assert.equal(result.code, EXIT.ok, result.stderr.join('\n'));
      const at = result.stdout.indexOf('CONTEXT 1 flag(s)');
      assert.notEqual(at, -1, `${argv.join(' ')}:\n${result.stdout.join('\n')}`);
      assert.match(result.stdout[at + 1] ?? '', /^ *WARN context-size CLAUDE\.md files \(.*CLAUDE\.md 1,001\): 1,001 characters .*\[contextFiles\.maxClaudeMdChars\]/);
    }
  });
});
