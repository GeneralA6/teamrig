import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { listingOverrides, usedByOf, type ListingScope } from './listing.ts';

function skill(name: string, body = `Owner: ${name.split('-')[0] ?? name}\n`) {
  return { name, text: `---\nname: ${name}\ndescription: Use when testing.\n---\n\n${body}` };
}

const SCOPE: ListingScope = { session: 'alpha', areas: ['lead', 'alpha', 'bravo', 'bravo-two'], sharedPrefix: 'team', otherAreas: 'name-only' };

describe('usedByOf', () => {
  it('reads the sessions of the Used by line, by comma or space, without the closing stop', () => {
    assert.deepEqual(usedByOf(skill('bravo-x', 'Owner: bravo\nUsed by: alpha, lead.\n').text), ['alpha', 'lead']);
    assert.deepEqual(usedByOf(skill('bravo-x', 'Used by:alpha lead;\n').text), ['alpha', 'lead']);
  });

  it('reads none without the line, and none from the frontmatter', () => {
    assert.deepEqual(usedByOf(skill('bravo-x').text), []);
    assert.deepEqual(usedByOf('---\nname: bravo-x\nUsed by: alpha\n---\n\nOwner: bravo\n'), []);
    assert.deepEqual(usedByOf('Owner: bravo\nUsed by:\n'), []);
  });
});

describe('listingOverrides', () => {
  it("lists another session's skills at the level, its own, shared and personal ones in full", () => {
    const skills = [skill('alpha-build'), skill('bravo-deploy'), skill('lead-meeting'), skill('team-ship'), skill('dataviz')];
    assert.deepEqual(listingOverrides(skills, SCOPE), { 'bravo-deploy': 'name-only', 'lead-meeting': 'name-only' });
  });

  it('lists in full a skill whose Used by line names the session', () => {
    const skills = [skill('bravo-deploy', 'Owner: bravo\nUsed by: lead, alpha\n'), skill('bravo-check', 'Owner: bravo\nUsed by: lead\n')];
    assert.deepEqual(listingOverrides(skills, SCOPE), { 'bravo-check': 'name-only' });
  });

  it('takes the longest session id a skill starts with as its area', () => {
    const skills = [skill('bravo-two-run')];
    assert.deepEqual(listingOverrides(skills, { ...SCOPE, session: 'bravo-two' }), {});
    assert.deepEqual(listingOverrides(skills, { ...SCOPE, session: 'bravo' }), { 'bravo-two-run': 'name-only' });
  });

  it('keeps the shared skills in full when the shared prefix is also a session id', () => {
    assert.deepEqual(listingOverrides([skill('bravo-ship')], { ...SCOPE, sharedPrefix: 'bravo' }), {});
  });

  it('lists at each level the config names, and every skill in full on on', () => {
    const skills = [skill('bravo-deploy')];
    assert.deepEqual(listingOverrides(skills, { ...SCOPE, otherAreas: 'user-invocable-only' }), { 'bravo-deploy': 'user-invocable-only' });
    assert.deepEqual(listingOverrides(skills, { ...SCOPE, otherAreas: 'off' }), { 'bravo-deploy': 'off' });
    assert.deepEqual(listingOverrides(skills, { ...SCOPE, otherAreas: 'on' }), {});
  });
});
