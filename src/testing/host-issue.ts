import type { HostIssue } from '../issues/issue.ts';

/** Open issue `number` of acme/web by its owner, with no labels, with any field overridden. */
export function testHostIssue(number: number, overrides: Partial<HostIssue> = {}): HostIssue {
  return {
    repo: 'acme/web',
    number,
    title: `Issue ${number}`,
    body: '',
    state: 'open',
    stateReason: '',
    labels: [],
    assignees: [],
    url: `https://github.com/acme/web/issues/${number}`,
    updatedAt: '2030-01-01T00:00:00Z',
    closedAt: undefined,
    lastEditedAt: undefined,
    authorAssociation: 'OWNER',
    author: 'maintainer',
    authorKind: 'User',
    labelEvents: [],
    renamedAt: undefined,
    ...overrides,
  };
}
