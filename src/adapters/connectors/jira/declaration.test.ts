import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { API_VERSION, apiVersionNotice, connectorDeclarationProblems, featuresOf, type ConnectorFeatureId, type Support } from '../../../plugin-api/index.ts';
import { NOT_BUILT, declaration } from './declaration.ts';

/** How each tracker row stands today; a row moves here when its method is built or proved. */
const TRACKER_ROWS: Readonly<Record<string, Support['kind']>> = {
  'tracker.issue-import': 'partial',
  'tracker.accept-label': 'unsupported',
  'tracker.watch': 'partial',
  'tracker.issue-open': 'partial',
  'tracker.comment': 'partial',
  'tracker.edit-body': 'partial',
  'tracker.close': 'partial',
  'tracker.labels': 'partial',
  'tracker.status-push': 'partial',
  'tracker.assign': 'partial',
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
    assert.equal(noticeOf('tracker.links'), NOT_BUILT.links);
    assert.deepEqual(NOT_BUILT, { links: 'the Jira connector does not read or write issue links yet' });
  });

  it('says an issue opens as a Task or the first type that can stand alone, its body as plain text (T4754)', () => {
    assert.deepEqual(declaration.manifest['tracker.issue-open'], {
      kind: 'partial',
      missing: 'Markdown, and a chosen issue type',
      notice: "an issue opens in Jira as a Task, or as the project's first type that is no sub-task when it has no Task, its body as plain paragraphs: its Markdown marks show as typed",
      proofs: [],
    });
  });

  it('says a close keeps its reason only where the workflow names it, and links no duplicate (T4754)', () => {
    assert.deepEqual(declaration.manifest['tracker.close'], {
      kind: 'partial',
      missing: "a link from a duplicate to its original, and a reason the project's workflow has no name for",
      notice: 'a Jira issue closes by a transition to a closed status: its reason is kept when the workflow has a status or a resolution named for it, and a duplicate gets no link to its original',
      proofs: [],
    });
  });

  it('says an assign replaces who held the issue, as Jira keeps one assignee, and that no claim line takes one (T4754)', () => {
    const oneAssignee = { kind: 'partial', missing: 'a second assignee', notice: 'a Jira issue holds one assignee, named by its account id, so an assign replaces who held it', proofs: [] };
    assert.deepEqual(declaration.manifest['tracker.assign'], oneAssignee);
    assert.deepEqual(declaration.manifest['tracker.status-push'], oneAssignee);
    assert.equal(noticeOf('tracker.claims'), 'a claim line takes only an issue that carries the accept label, and the Jira connector does not read who put a label on an issue yet');
  });

  it('holds a label name with a space under a hyphen (T4754)', () => {
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
