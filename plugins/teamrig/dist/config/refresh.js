import { launchOf } from "./launch.js";
/** The `[1m]` suffix a Claude Code model alias or id takes for the 1M-token context window. */
const LARGE_WINDOW_SUFFIX = '[1m]';
/**
 * Whether session `id`'s launch model asks for a 1M-token window. A hook is never told the window, so a model whose
 * default window is that large without the suffix (the lead's plain `opus`) is found from what its refresh state shows
 * instead: the window the plugin's mod reports, or a size no 200k window has (src/refresh/decide.ts `windowOf`).
 */
export function largeWindowOf(config, id) {
    return launchOf(config, id).model?.endsWith(LARGE_WINDOW_SUFFIX) === true;
}
/**
 * The refresh settings of session `id`: on a `[1m]` launch the threshold raised to `largeWindowContextTokens` when
 * that is larger. A large window shown without the suffix raises it at each decision instead (src/refresh/decide.ts
 * `windowOf`).
 */
export function sessionRefreshOf(config, id) {
    const { refresh } = config;
    const large = refresh.largeWindowContextTokens > refresh.contextTokens && largeWindowOf(config, id);
    return { ...refresh, contextTokens: large ? refresh.largeWindowContextTokens : refresh.contextTokens };
}
