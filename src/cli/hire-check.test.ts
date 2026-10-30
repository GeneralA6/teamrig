import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ok, teamWithHelper } from '../testing/hired-team.ts';

describe('check on hired sessions', () => {
  it('flags REVIEW-DUE past the review day, for the lead and in its own start, never RETIRE-DUE for a hire idle 8 days', async () => {
    const kit = await teamWithHelper();
    assert.doesNotMatch(ok(await kit.run(['check', '--session', 'lead'])).stdout.join('\n'), /HIRES/);
    kit.clock.advance(8 * 86_400_000);
    const lines = ok(await kit.run(['check', '--all', '--session', 'lead'])).stdout;
    assert.deepEqual(
      lines.filter((line) => line.startsWith('HIRE')),
      ['HIRES 1 flag(s)', 'HIRE REVIEW-DUE (review day 2030-01-15 passed) helper: decide whether its job goes on, else retire it (teamrig retire helper)'],
    );
    assert.match(ok(await kit.run(['start', '--session', 'helper'])).stdout.join('\n'), /HIRE REVIEW-DUE .* helper/);
    assert.doesNotMatch(ok(await kit.run(['start', '--session', 'alpha'])).stdout.join('\n'), /HIRE /);
  });
});
