import type { HostGroup } from '../feature.ts';

/** How teamrig itself gets into the CLI and stays there. */
export const PLUGIN_FEATURES = {
  'plugin.hooks-file': { doc: "teamrig's hooks file loads as shipped", byDefault: 'on' },
  'plugin.hook-trust': { doc: 'guards stay on across a teamrig update', byDefault: 'on' },
  'plugin.install-update': { doc: 'installing and updating teamrig, and reading its version', byDefault: 'on' },
  'plugin.cli-on-path': { doc: '`teamrig` on the path', byDefault: 'on' },
} as const satisfies HostGroup<'plugin'>;
