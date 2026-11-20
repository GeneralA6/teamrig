import type { CodeHost, Tracker } from '../issues/host.ts';
import type { FakeIssueHost } from './fake-issue-host.ts';

/**
 * `fake` as a tracker alone, as a host that holds issues and no code is: each tracker capability goes to the fake,
 * and it has no pull request, check, post or label file read. A flow that takes it asks a tracker for nothing a code
 * host holds, and a test that passes it fails to compile once the flow asks for more. Its issue fields are the
 * fake's as they are now: give the fake its fields (hasFields) first.
 */
export function trackerOnly(fake: FakeIssueHost): Tracker {
  return {
    name: fake.name,
    reach: (repo, use) => fake.reach(repo, use),
    list: (repo) => fake.list(repo),
    open: (draft) => fake.open(draft),
    editBody: (target, body) => fake.editBody(target, body),
    close: (target, reason, duplicateId) => fake.close(target, reason, duplicateId),
    issueId: (target) => fake.issueId(target),
    thread: (target) => fake.thread(target),
    comment: (target, body) => fake.comment(target, body),
    newComments: (target, since) => fake.newComments(target, since),
    labelName: (label) => fake.labelName(label),
    labelExists: (repo, label) => fake.labelExists(repo, label),
    createLabel: (repo, label) => fake.createLabel(repo, label),
    addLabels: (target, labels) => fake.addLabels(target, labels),
    removeLabel: (target, label) => fake.removeLabel(target, label),
    issueLabels: (target) => fake.issueLabels(target),
    assigneeExists: (repo, login) => fake.assigneeExists(repo, login),
    viewer: (repo) => fake.viewer(repo),
    assignableOn: (target, login) => fake.assignableOn(target, login),
    assign: (target, logins) => fake.assign(target, logins),
    unassign: (target, login) => fake.unassign(target, login),
    links: (repo) => fake.links(repo),
    addSubIssue: (parent, childId) => fake.addSubIssue(parent, childId),
    addBlockedBy: (target, blockerId) => fake.addBlockedBy(target, blockerId),
    watch: (repo, marks) => fake.watch(repo, marks),
    ...(fake.fields === undefined ? {} : { fields: fake.fields }),
  };
}

/**
 * `fake` as a code host alone, as a host that holds pull requests and no issue tracker is: its pull request, check,
 * post and label file reads go to the fake, and it has no issue, comment, label, assignee or link of its own.
 */
export function codeHostOnly(fake: FakeIssueHost): CodeHost {
  return {
    name: fake.name,
    reach: (repo, use) => fake.reach(repo, use),
    pulls: (repo, since) => fake.pulls(repo, since),
    jobLog: (repo, jobId) => fake.jobLog(repo, jobId),
    posts: (repo, since) => fake.posts(repo, since),
    labelFile: (repo) => fake.labelFile(repo),
  };
}
