import type { HostGroup } from '../feature.ts';

/** What the budget reads from the CLI: its transcripts, each call's usage, the week and the status line. */
export const BUDGET_FEATURES = {
  'budget.transcripts': { doc: 'finding the transcripts', byDefault: 'on' },
  'budget.usage': { doc: 'the usage and weighted cost of each call', byDefault: 'on' },
  'budget.model-share': { doc: 'the share of each model and effort level', byDefault: 'on' },
  'budget.week-reading': { doc: 'the week reading and the pace line', byDefault: 'on' },
  'budget.five-hour': { doc: 'the five-hour forecast', byDefault: 'on' },
  'budget.status-line': { doc: "teamrig's status-line text", byDefault: 'on' },
  'budget.helper-weight': { doc: 'the weight of a helper', byDefault: 'on' },
} as const satisfies HostGroup<'budget'>;
