import type { HostGroup } from '../feature.ts';

/** What a session's terminal tab shows. */
export const TABS_FEATURES = {
  'tabs.title-status': { doc: 'tab titles and status circles', byDefault: 'on' },
  'tabs.waiting-state': { doc: "the tab's waiting-on-a-decision state", byDefault: 'on' },
  'tabs.memory': { doc: "what one tab's processes hold in memory, and the notice of a step killed for memory", byDefault: 'on' },
} as const satisfies HostGroup<'tabs'>;
