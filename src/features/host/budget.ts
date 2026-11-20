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
  'budget.pools': { doc: 'a budget pool per CLI and account, never added to another', byDefault: 'on' },
  'budget.windows': { doc: 'the usage windows beside the week, each with its share used and its reset', byDefault: 'on' },
  'budget.tuning': { doc: "model and effort tuned from the user's own results, on evidence only", byDefault: 'off' },
} as const satisfies HostGroup<'budget'>;
