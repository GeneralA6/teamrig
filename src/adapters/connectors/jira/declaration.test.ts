import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, apiVersionNotice, connectorDeclarationProblems, featuresOf, type ConnectorFeatureId, type Support } from '../../../plugin-api/index.ts';
import { NOT_BUILT, declaration } from './declaration.ts';

/** How each tracker row stands today; a row moves here when its method is built or proved. */
const TRACKER_ROWS: Readonly<Record<string, Support['kind']>> = {
  'tracker.issue-import': 'partial',
  'tracker.accept-label': 'unsupported',
  'tracker.watch': 'partial',
  'tracker.issue-open': 'unsupported',
  'tracker.comment': 'partial',
  'tracker.edit-body': 'partial',
  'tracker.close': 'unsupported',
  'tracker.labels': 'partial',
  'tracker.status-push': 'partial',
  'tracker.assign': 'unsupported',
  'tracker.claims': 'unsupported',
  'tracker.clocks': 'partial',
  'tracker.mentions': 'unsupported',
  'tracker.follow': 'supported',
  'tracker.links': 'unsupported',
  'tracker.fields': 'unsupported',
  'tracker.similar': 'supported',
  'tracker.security-alert': 'supported',
  'tracker.stamp': 'supported',
  'tracker.hidden-mark': 'unsupported',
};

function noticeOf(id: ConnectorFeatureId): string | undefined {
  const row = declaration.manifest[id];
  return row.kind === 'supported' ? undefined : row.notice;
}

describe('the Jira declaration', () => {
  it('declares a tracker built for the plugin API of this teamrig', () => {
    assert.deepEqual(connectorDeclarationProblems(declaration), []);
    assert.equal(declaration.id, 'jira');
    assert.equal(declaration.name, 'Jira');
    assert.deepEqual(declaration.kinds, ['tracker']);
    assert.equal(declaration.refPrefix, 'jira:');
    assert.equal(apiVersionNotice(declaration.apiVersion, API_VERSION), undefined);
  });

  it('says of each tracker feature how far the adapter goes today', () => {
    const tracker = featuresOf('connector').filter((row) => row.group === 'tracker');
    assert.deepEqual(Object.fromEntries(tracker.map((row) => [row.id, declaration.manifest[row.id].kind])), TRACKER_ROWS);
  });

  it('claims no proof: none was made on a real site yet', () => {
    for (const row of featuresOf('connector')) {
      const support = declaration.manifest[row.id];
      assert.deepEqual(support.kind === 'unsupported' ? [] : support.proofs, [], row.id);
    }
  });

  it('is no code host, and says what a pull request feature needs', () => {
    for (const row of featuresOf('connector').filter((feature) => feature.group === 'codehost')) {
      assert.deepEqual(declaration.manifest[row.id], { kind: 'unsupported', notice: 'Jira is a tracker: pull requests, their checks and their reviews need a code host connector' }, row.id);
    }
  });

  it('gives a method that is not built yet the line its row carries', () => {
    assert.equal(noticeOf('tracker.issue-open'), NOT_BUILT.open);
    assert.equal(noticeOf('tracker.close'), NOT_BUILT.close);
    assert.equal(noticeOf('tracker.assign'), NOT_BUILT.assign);
    assert.equal(noticeOf('tracker.links'), NOT_BUILT.links);
    assert.equal(NOT_BUILT.open, 'the Jira connector does not open issues yet');
  });

  it('holds a label name with a space under a hyphen, so the status push lacks only the assignee (T4754)', () => {
    assert.deepEqual(declaration.manifest['tracker.status-push'], { kind: 'partial', missing: 'the assignee', notice: 'the Jira connector sets no assignee yet', proofs: [] });
    assert.equal(
      noticeOf('tracker.labels'),
      'a Jira label has no colour and no description and exists once an issue carries it; it holds no space, so a name with one is held with a hyphen in its place',
    );
  });

  it('says a comment and a description go to Jira as plain text', () => {
    assert.deepEqual(declaration.manifest['tracker.comment'], { kind: 'partial', missing: 'Markdown', notice: 'a comment is posted to Jira as plain paragraphs: its Markdown marks show as typed', proofs: [] });
    assert.equal(noticeOf('tracker.edit-body'), 'a description is written to Jira as plain paragraphs: its Markdown marks show as typed');
  });
});
