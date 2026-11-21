import type { HostGroup } from '../feature.ts';

/** A session's life: opening, resuming and waking it, knowing which one it is, and what its turns end on. */
export const SESSIONS_FEATURES = {
  'sessions.open': { doc: 'opening a tab on its model, effort and name', byDefault: 'on' },
  'sessions.resume': { doc: 'resuming a session, and restoring it after a reboot', byDefault: 'on' },
  'sessions.identity': { doc: "the session's own id in the CLI", byDefault: 'on' },
  'sessions.wake': { doc: 'waking an idle session', byDefault: 'on' },
  'sessions.turn-end': { doc: 'the checks and metering at a turn end', byDefault: 'on' },
  'sessions.process': { doc: "finding the session's process", byDefault: 'on' },
  'sessions.in-tab': { doc: 'the in-tab command, bands, toasts and the refresh inside a turn', byDefault: 'on' },
  'sessions.carry': { doc: 'crons, scheduled wakes, the plan and the scratchpad carried over a refresh', byDefault: 'on' },
  'sessions.effort-writeback': { doc: 'a typed effort level written back to the session', byDefault: 'on' },
} as const satisfies HostGroup<'sessions'>;
