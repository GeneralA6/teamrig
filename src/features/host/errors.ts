import type { HostGroup } from '../feature.ts';

/** What a turn that failed says about why, so each kind of failure gets its own rule. */
export const ERRORS_FEATURES = {
  'errors.kinds': { doc: 'a failed turn told apart by kind: rate limit, overload, auth, context too long, other', byDefault: 'on' },
} as const satisfies HostGroup<'errors'>;
