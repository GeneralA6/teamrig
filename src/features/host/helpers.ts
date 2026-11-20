import type { HostGroup } from '../feature.ts';

/** The helpers (subagents) a session starts. */
export const HELPERS_FEATURES = {
  'helpers.start-rules': { doc: 'helpers, and the rules at their start', byDefault: 'on' },
  'helpers.agent-types': { doc: "teamrig's agent types", byDefault: 'on' },
} as const satisfies HostGroup<'helpers'>;
