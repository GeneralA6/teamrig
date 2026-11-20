import type { HostGroup } from '../feature.ts';

/** What reaches a session with each prompt. */
export const INBOX_FEATURES = {
  'inbox.prompt-line': { doc: 'inbox lines, the digest and the budget line at each prompt', byDefault: 'on' },
} as const satisfies HostGroup<'inbox'>;
