import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { featuresOf, isManifest, type FeatureIdOf, type FeatureSide, type Manifest, type Support } from '../plugin-api/index.ts';
import { SUPPORTED, UNSUPPORTED, manifestOf } from '../testing/manifests.ts';
import { resolveToggles, type AskedToggles } from './toggles.ts';

const PARTIAL: Support = { kind: 'partial', missing: 'the wake of a closed tab', notice: 'a closed tab is not woken', proofs: [] };

function manifest<Side extends FeatureSide>(side: Side, support: Support, over: Readonly<Record<string, Support>> = {}): Manifest<Side> {
  const data = manifestOf(side, support, over);
  assert.ok(isManifest(side, data));
  return data;
}

/** The resolved toggles as `id=toggle` for the ids asked about; a refusal fails the spec with its notices. */
function resolved<Side extends FeatureSide>(side: Side, of: Manifest<Side>, asked: AskedToggles, ids: readonly FeatureIdOf<Side>[]): readonly string[] {
  const toggles = resolveToggles(side, of, asked);
  if (toggles.kind === 'refused') {
    assert.fail(toggles.notices.join('; '));
  }
  return ids.map((id) => `${id}=${toggles.toggles.get(id)}`);
}

describe('the toggles of an adapter', () => {
  it('hold one toggle for every feature of the side', () => {
    const toggles = resolveToggles('connector', manifest('connector', SUPPORTED), {});
    assert.equal(toggles.kind, 'resolved');
    assert.deepEqual(toggles.kind === 'resolved' && [...toggles.toggles.keys()], featuresOf('connector').map((row) => row.id));
  });

  it('run a supported feature unless the team turns it off', () => {
    const of = manifest('host', SUPPORTED);
    assert.deepEqual(resolved('host', of, { 'sessions.wake': 'off', 'tabs.title-status': 'on' }, ['sessions.wake', 'tabs.title-status', 'rules.memory']), [
      'sessions.wake=off',
      'tabs.title-status=on',
      'rules.memory=on',
    ]);
  });

  it('run a feature supported in part as the team asks, else as its registry row says', () => {
    const of = manifest('host', SUPPORTED, { 'sessions.wake': PARTIAL, 'sessions.open': PARTIAL });
    assert.deepEqual(resolved('host', of, { 'sessions.open': 'off' }, ['sessions.wake', 'sessions.open']), ['sessions.wake=on', 'sessions.open=off']);
  });

  it('never run an unsupported feature, asked off or not asked', () => {
    const of = manifest('connector', SUPPORTED, { 'tracker.hidden-mark': UNSUPPORTED, 'tracker.fields': UNSUPPORTED });
    assert.deepEqual(resolved('connector', of, { 'tracker.fields': 'off' }, ['tracker.hidden-mark', 'tracker.fields', 'tracker.comment']), [
      'tracker.hidden-mark=off',
      'tracker.fields=off',
      'tracker.comment=on',
    ]);
  });
});

describe('asked toggles an adapter cannot hold', () => {
  it('turn on a feature it does not support: refused with the notice of its manifest', () => {
    const of = manifest('connector', SUPPORTED, { 'tracker.hidden-mark': { kind: 'unsupported', notice: 'the tool shows every mark' } });
    assert.deepEqual(resolveToggles('connector', of, { 'tracker.hidden-mark': 'on' }), { kind: 'refused', notices: ['tracker.hidden-mark cannot be on: the tool shows every mark'] });
  });

  it('name an id that is no feature of the side', () => {
    assert.deepEqual(resolveToggles('host', manifest('host', SUPPORTED), { 'tracker.comment': 'off', 'sessions.woke': 'on' }), {
      kind: 'refused',
      notices: ['tracker.comment is no host feature', 'sessions.woke is no host feature'],
    });
  });

  it('are refused for every reason at once', () => {
    const toggles = resolveToggles('host', manifest('host', UNSUPPORTED), { 'os.linux': 'on', 'os.bsd': 'on' });
    assert.deepEqual(toggles, { kind: 'refused', notices: ['os.bsd is no host feature', 'os.linux cannot be on: the tool has no such thing'] });
  });
});
