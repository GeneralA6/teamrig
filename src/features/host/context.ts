import type { HostGroup } from '../feature.ts';

/** A session's context window: its size and what happens as it fills. */
export const CONTEXT_FEATURES = {
  'context.compact-hold': { doc: 'holding a compaction while a handover is written', byDefault: 'on' },
  'context.size': { doc: 'the context size and its refresh thresholds', byDefault: 'on' },
  'context.refresh': { doc: 'how the CLI starts fresh (clear, compaction or a new process), with the handover read after', byDefault: 'on' },
} as const satisfies HostGroup<'context'>;
