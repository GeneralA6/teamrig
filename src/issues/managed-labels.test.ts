import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DESIGN_LABEL, DESIGN_LABEL_SPEC } from './design-label.ts';
import { managedLabel, MANAGED_LABEL_SPECS } from './managed-labels.ts';
import { STATUS_LABEL_PREFIX, STATUS_LABEL_SPECS } from './status-push.ts';

describe('the labels teamrig makes (T3096)', () => {
  it('are the five status labels and the design label, each named once', () => {
    assert.deepEqual(MANAGED_LABEL_SPECS, [...STATUS_LABEL_SPECS, DESIGN_LABEL_SPEC]);
    assert.equal(new Set(MANAGED_LABEL_SPECS.map((spec) => spec.name)).size, 6);
  });

  it('keep the design label out of the status family, so the push never takes it off', () => {
    assert.equal(DESIGN_LABEL.startsWith(STATUS_LABEL_PREFIX), false);
  });

  it('fit GitHub: a name of at most 50 characters, a colour of six hex digits, a description of at most 100', () => {
    for (const spec of MANAGED_LABEL_SPECS) {
      assert.ok(spec.name.length <= 50, spec.name);
      assert.match(spec.color, /^[0-9a-f]{6}$/u, spec.name);
      assert.ok(spec.description.length <= 100, spec.name);
    }
  });

  it('finds the spec of a managed label by name, and none for any other', () => {
    assert.equal(managedLabel('design'), DESIGN_LABEL_SPEC);
    assert.equal(managedLabel('status:claimed')?.color, '1d76db');
    assert.equal(managedLabel('Design'), undefined);
    assert.equal(managedLabel('bug'), undefined);
  });
});
