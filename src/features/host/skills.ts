import type { HostGroup } from '../feature.ts';

/** The skills a session can load. */
export const SKILLS_FEATURES = {
  'skills.plugin': { doc: 'the plugin skills', byDefault: 'on' },
  'skills.team': { doc: 'team and session skills', byDefault: 'on' },
  'skills.session-listing': { doc: "a session's own skill listing", byDefault: 'on' },
} as const satisfies HostGroup<'skills'>;
