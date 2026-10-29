import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PatternList } from './pattern-list.ts';

describe('PatternList', () => {
  it('matches a text by any pattern, case ignored, and by none when the list is empty', () => {
    const list = new PatternList(['^stripe_', 'token']);
    assert.equal(list.matches('STRIPE_LIVE'), true);
    assert.equal(list.matches('hf_Token'), true);
    assert.equal(list.matches('HOME'), false);
    assert.equal(new PatternList([]).matches('TOKEN'), false);
  });

  it('lets the last pattern that matches decide, a !pattern letting the text go', () => {
    const list = new PatternList(['TOKEN', '!^TOKENIZERS_', '_SECRET$']);
    assert.equal(list.matches('TOKENIZERS_PARALLELISM'), false);
    assert.equal(list.matches('TOKENIZERS_SECRET'), true);
  });
});
