import type { ConnectorGroup } from '../feature.ts';

/** What a code host, the tool holding a team's code and pull requests, is asked for. */
export const CODEHOST_FEATURES = {
  'codehost.pull-news': { kind: 'codehost', doc: 'opened, merged, conflicting, failing and reviewed pull requests reach their session', byDefault: 'on' },
  'codehost.ci-excerpt': { kind: 'codehost', doc: "the end of a failed CI job's log", byDefault: 'on' },
  'codehost.pr-conflicts': { kind: 'codehost', doc: 'the files a pull request conflicts on (`pr conflicts`)', byDefault: 'on' },
  'codehost.review-posts': { kind: 'codehost', doc: 'review comments and reviews in the mention scan', byDefault: 'on' },
  'codehost.linked-pulls': { kind: 'codehost', doc: 'how many open pull requests close an issue', byDefault: 'on' },
} as const satisfies ConnectorGroup<'codehost'>;
