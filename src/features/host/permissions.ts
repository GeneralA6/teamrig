import type { HostGroup } from '../feature.ts';

/** What the CLI's own permission settings refuse and grant. */
export const PERMISSIONS_FEATURES = {
  'permissions.deny-lines': { doc: 'the permission deny lines, their doctor checks and trim', byDefault: 'on' },
  'permissions.auto-mode-routes': { doc: 'the push and deploy routes granted to auto mode', byDefault: 'on' },
} as const satisfies HostGroup<'permissions'>;
