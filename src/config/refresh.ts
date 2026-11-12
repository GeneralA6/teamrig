import { launchOf } from './launch.ts';
import { AUTO_RESTART_LEAD, type KitConfig, type RefreshConfig } from './types.ts';

/** The `[1m]` suffix a Claude Code model alias or id takes for the 1M-token context window. */
const LARGE_WINDOW_SUFFIX = '[1m]';

/** `refresh` as it applies to one session: the automatic restart resolved to on or off, the threshold to its window. */
export type SessionRefresh = Omit<RefreshConfig, 'autoRestart'> & { readonly autoRestart: boolean };

/** Whether the automatic restart is on for session `id`: `lead` turns it on for the team's lead only. */
export function autoRestartOf(config: Pick<KitConfig, 'refresh' | 'roles'>, id: string): boolean {
  const { autoRestart } = config.refresh;
  return autoRestart === AUTO_RESTART_LEAD ? config.roles.lead === id : autoRestart;
}

/**
 * Whether session `id`'s launch model asks for a 1M-token window. A hook is never told the window, so a model whose
 * default window is that large without the suffix (the lead's plain `opus`) is found from what its refresh state shows
 * instead: the window the plugin's mod reports, or a size no 200k window has (src/refresh/decide.ts `windowOf`).
 */
export function largeWindowOf(config: KitConfig, id: string): boolean {
  return launchOf(config, id).model?.endsWith(LARGE_WINDOW_SUFFIX) === true;
}

/**
 * The refresh settings of session `id`: the automatic restart resolved (`autoRestartOf`), and on a `[1m]` launch the
 * threshold raised to `largeWindowContextTokens` when that is larger. A large window shown without the suffix raises
 * it at each decision instead (src/refresh/decide.ts `windowOf`).
 */
export function sessionRefreshOf(config: KitConfig, id: string): SessionRefresh {
  const { refresh } = config;
  const large = refresh.largeWindowContextTokens > refresh.contextTokens && largeWindowOf(config, id);
  return { ...refresh, autoRestart: autoRestartOf(config, id), contextTokens: large ? refresh.largeWindowContextTokens : refresh.contextTokens };
}
