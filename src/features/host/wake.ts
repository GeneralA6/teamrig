import type { HostGroup } from '../feature.ts';

/** Turns teamrig starts on its own. */
export const WAKE_FEATURES = {
  'wake.api-retry': { doc: 'sending a turn again after an API error', byDefault: 'on' },
  'wake.cost': { doc: "what a wake turn costs, from the CLI's prompt-cache lifetime and the measured turns", byDefault: 'on' },
} as const satisfies HostGroup<'wake'>;
