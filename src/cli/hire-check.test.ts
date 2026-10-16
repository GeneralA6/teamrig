import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ok, teamWithHelper } from '../testing/hired-team.ts';

describe('check on hired sessions', () => {
  it('flags RETIRE-DUE past hiring.idleHours and REVIEW-DUE past the review day, for the lead and in its own start', async () => {
    const kit = await teamWithHelper();
    assert.doesNotMatch(ok(await kit.run(['check', '--session', 'lead'])).stdout.join('\n'), /HIRES/);
    kit.clock.advance(8 * 86_400_000);
    const lines = ok(await kit.run(['check', '--all', '--session', 'lead'])).stdout;
    assert.ok(lines.includes('HIRES 2 flag(s)'), lines.join('\n'));
    assert.ok(lines.includes('HIRE RETIRE-DUE (no open task for 192 h, hiring.idleHours 4) helper: retire it (teamrig retire helper)'), lines.join('\n'));
    assert.ok(lines.includes('HIRE REVIEW-DUE (review day 2030-01-15 passed) helper: decide whether its job goes on, else retire it (teamrig retire helper)'), lines.join('\n'));
    assert.match(ok(await kit.run(['start', '--session', 'helper'])).stdout.join('\n'), /HIRE RETIRE-DUE .* helper/);
    assert.doesNotMatch(ok(await kit.run(['start', '--session', 'alpha'])).stdout.join('\n'), /HIRE /);
  });
});
