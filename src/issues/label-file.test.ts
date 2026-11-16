import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LABEL_DESCRIPTION_MAX, parseLabelFile } from './label-file.ts';

describe('parseLabelFile', () => {
  const one = (label: Record<string, unknown>): string => JSON.stringify({ labels: [label] });

  it('reads each label', () => {
    assert.deepEqual(parseLabelFile(one({ name: 'bug', color: 'd73a4a', description: 'Type: a bug' })), [{ name: 'bug', color: 'd73a4a', description: 'Type: a bug' }]);
  });

  it('refuses a missing list, a malformed label, an over-long description and a name listed twice in any case', () => {
    assert.throws(() => parseLabelFile('[]'), /expected \{ "labels"/);
    assert.throws(() => parseLabelFile(one({ name: 'bug', color: '#d73a4a', description: 'x' })), /six-digit lowercase hex color/);
    assert.throws(() => parseLabelFile(one({ name: ' ', color: 'd73a4a', description: 'x' })), /needs a name/);
    assert.throws(() => parseLabelFile(one({ name: 'bug', color: 'd73a4a' })), /needs a name/);
    assert.throws(() => parseLabelFile(one({ name: 'bug', color: 'd73a4a', description: 'x'.repeat(LABEL_DESCRIPTION_MAX + 1) })), /over 100 characters/);
    const twice = { labels: [{ name: 'Bug', color: 'd73a4a', description: '' }, { name: 'bug', color: 'd73a4a', description: '' }] };
    assert.throws(() => parseLabelFile(JSON.stringify(twice)), /bug is listed twice/);
  });
});
