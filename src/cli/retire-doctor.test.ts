import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HIRES, ok, teamWithHelper } from '../testing/hired-team.ts';

describe('doctor after a retire', () => {
  it("reads the retired session's inbox as kept on purpose, not as an orphan", async () => {
    const kit = await teamWithHelper();
    ok(await kit.run(['inbox', 'add', '--to', 'helper', '--text', 'one more thing', '--session', 'lead']));
    ok(await kit.run(['retire', 'helper', '--yes', '--session', 'lead']));
    assert.doesNotMatch(ok(await kit.run(['doctor'])).stdout.join('\n'), /inbox-orphan|name-gone/);
    await kit.files.write(HIRES, '');
    assert.match(ok(await kit.run(['doctor'])).stdout.join('\n'), /inbox-orphan inbox helper/);
  });
});
