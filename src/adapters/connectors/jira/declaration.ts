import type { ConnectorDeclaration, Support } from '../../../plugin-api/index.ts';

/**
 * What the Jira Cloud connector says of itself. A row says what this adapter does today, not what Jira could do: a
 * method not built yet is unsupported, with the line its call answers. No row holds a proof until a run on a real
 * site made one.
 */

/** What a tracker method that is not built yet answers; its row says the same. */
export const NOT_BUILT = {
  links: 'the Jira connector does not read or write issue links yet',
} as const;

/** Built, with no live proof yet. */
const UNPROVED: Support = { kind: 'supported', proofs: [] };

/** Jira holds issues and no code. */
const NOT_A_CODE_HOST: Support = { kind: 'unsupported', notice: 'Jira is a tracker: pull requests, their checks and their reviews need a code host connector' };

function partial(missing: string, notice: string): Support {
  return { kind: 'partial', missing, notice, proofs: [] };
}

function unsupported(notice: string): Support {
  return { kind: 'unsupported', notice };
}

/** An assign names an account by its id, and Jira keeps one per issue. */
const ONE_ASSIGNEE: Support = partial('a second assignee', 'a Jira issue holds one assignee, named by its account id, so an assign replaces who held it');

export const declaration: ConnectorDeclaration = {
  apiVersion: '0.1.0',
  id: 'jira',
  name: 'Jira',
  kinds: ['tracker'],
  refPrefix: 'jira:',
  manifest: {
    'tracker.issue-import': partial(
      "a description's formatting, and the reporter's tie to the project",
      'a Jira description is read as plain text, and Jira names no tie between a reporter and the project: every issue is read as an outsider\'s',
    ),
    'tracker.accept-label': unsupported('the Jira connector does not read who put a label on an issue yet, so the accept label takes no issue'),
    'tracker.watch': partial('a free look for a change', 'each look for a change is one Jira search, which counts against the site\'s rate limit'),
    'tracker.issue-open': partial(
      'Markdown, and a chosen issue type',
      "an issue opens in Jira as a Task, or as the project's first type that is no sub-task when it has no Task, its body as plain paragraphs: its Markdown marks show as typed",
    ),
    'tracker.comment': partial('Markdown', 'a comment is posted to Jira as plain paragraphs: its Markdown marks show as typed'),
    'tracker.edit-body': partial('Markdown', 'a description is written to Jira as plain paragraphs: its Markdown marks show as typed'),
    'tracker.close': partial(
      "a link from a duplicate to its original, and a reason the project's workflow has no name for",
      'a Jira issue closes by a transition to a closed status: its reason is kept when the workflow has a status or a resolution named for it, and a duplicate gets no link to its original',
    ),
    'tracker.labels': partial(
      'a label made with a colour and a description, and a name holding a space',
      'a Jira label has no colour and no description and exists once an issue carries it; it holds no space, so a name with one is held with a hyphen in its place',
    ),
    'tracker.status-push': ONE_ASSIGNEE,
    'tracker.assign': ONE_ASSIGNEE,
    'tracker.claims': unsupported('a claim line takes only an issue that carries the accept label, and the Jira connector does not read who put a label on an issue yet'),
    'tracker.clocks': partial("a commenter's tie to the project", 'Jira names no tie between a commenter and the project: every comment is read as an outsider\'s'),
    'tracker.mentions': unsupported('the Jira connector does not read comments for a mention yet'),
    'tracker.follow': UNPROVED,
    'tracker.links': unsupported(NOT_BUILT.links),
    'tracker.fields': unsupported('the Jira connector does not write an issue\'s priority or type yet'),
    'tracker.similar': UNPROVED,
    'tracker.security-alert': UNPROVED,
    'tracker.stamp': UNPROVED,
    'tracker.hidden-mark': unsupported('the Jira connector keeps no hidden mark on an issue yet'),
    'codehost.pull-news': NOT_A_CODE_HOST,
    'codehost.ci-excerpt': NOT_A_CODE_HOST,
    'codehost.pr-conflicts': NOT_A_CODE_HOST,
    'codehost.review-posts': NOT_A_CODE_HOST,
    'codehost.linked-pulls': NOT_A_CODE_HOST,
  },
};
