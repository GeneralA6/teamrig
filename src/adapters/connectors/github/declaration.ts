import type { ConnectorDeclaration, Support } from '../../../plugin-api/index.ts';

/**
 * What runs on GitHub today. No row carries a proof yet: a proof is the record of a live run on the operating
 * system it names, added when that run is made, so until then the parity page shows the row unproved.
 */
const SUPPORTED: Support = { kind: 'supported', proofs: [] };

export const declaration: ConnectorDeclaration = {
  apiVersion: '0.1.0',
  id: 'github',
  name: 'GitHub',
  kinds: ['tracker', 'codehost'],
  refPrefix: 'gh:',
  // GitHub's keys are still the team config's own `github` section, which the commands read.
  configKeys: {},
  manifest: {
    'tracker.issue-import': SUPPORTED,
    'tracker.accept-label': SUPPORTED,
    'tracker.watch': SUPPORTED,
    'tracker.issue-open': SUPPORTED,
    'tracker.comment': SUPPORTED,
    'tracker.edit-body': SUPPORTED,
    'tracker.close': SUPPORTED,
    'tracker.labels': SUPPORTED,
    'tracker.status-push': SUPPORTED,
    'tracker.assign': SUPPORTED,
    'tracker.claims': SUPPORTED,
    'tracker.clocks': SUPPORTED,
    'tracker.mentions': SUPPORTED,
    'tracker.follow': SUPPORTED,
    'tracker.links': SUPPORTED,
    'tracker.fields': SUPPORTED,
    'tracker.similar': SUPPORTED,
    'tracker.security-alert': SUPPORTED,
    'tracker.stamp': SUPPORTED,
    'tracker.hidden-mark': { kind: 'unsupported', notice: 'GitHub shows every mark on an issue to its readers: a mark there is a label or a comment' },
    'codehost.pull-news': SUPPORTED,
    'codehost.ci-excerpt': SUPPORTED,
    'codehost.pr-conflicts': SUPPORTED,
    'codehost.review-posts': SUPPORTED,
    'codehost.linked-pulls': SUPPORTED,
  },
};
