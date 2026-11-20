import type { ConnectorDeclaration, Support } from '../../../plugin-api/index.ts';

/** A team with no outside tool: its tasks live in the register alone, so no feature that reaches a tool can run. */
const NONE: Support = { kind: 'unsupported', notice: 'the local connector keeps tasks in the register: it has no outside tracker or code host' };

export const declaration: ConnectorDeclaration = {
  apiVersion: '0.1.0',
  id: 'local',
  name: 'Local',
  kinds: ['tracker'],
  refPrefix: 'local:',
  configKeys: {},
  manifest: {
    'tracker.issue-import': NONE,
    'tracker.accept-label': NONE,
    'tracker.watch': NONE,
    'tracker.issue-open': NONE,
    'tracker.comment': NONE,
    'tracker.edit-body': NONE,
    'tracker.close': NONE,
    'tracker.labels': NONE,
    'tracker.status-push': NONE,
    'tracker.assign': NONE,
    'tracker.claims': NONE,
    'tracker.clocks': NONE,
    'tracker.mentions': NONE,
    'tracker.follow': NONE,
    'tracker.links': NONE,
    'tracker.fields': NONE,
    'tracker.similar': NONE,
    'tracker.security-alert': NONE,
    'tracker.stamp': NONE,
    'tracker.hidden-mark': NONE,
    'codehost.pull-news': NONE,
    'codehost.ci-excerpt': NONE,
    'codehost.pr-conflicts': NONE,
    'codehost.review-posts': NONE,
    'codehost.linked-pulls': NONE,
  },
};
