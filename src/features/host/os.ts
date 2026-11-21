import type { HostGroup } from '../feature.ts';

/** The operating systems the CLI's sessions and hooks run on. */
export const OS_FEATURES = {
  'os.windows-sessions': { doc: 'native Windows sessions and Windows Terminal tabs', byDefault: 'on' },
  'os.windows-hooks': { doc: 'hooks on Windows', byDefault: 'on' },
  'os.linux': { doc: 'sessions and hooks on Linux and macOS', byDefault: 'on' },
} as const satisfies HostGroup<'os'>;
