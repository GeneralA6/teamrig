/**
 * teamrig's contract with Claude Code: the session values its mod (hooks/register.ts) keeps through `$.state`.
 */

/**
 * The reload hand's last /reload-plugins in this session (src/mod/reload-hand.ts ReloadRecord): the installs it
 * reloaded for and when, in milliseconds since the epoch. The mod the reload loads reads it back, checking its shape,
 * so it keeps the gap between reloads and never runs a second one for the same installs.
 */
export type TeamrigReload = { readonly fingerprint: string; readonly at: number }

declare module 'claude-code' {
  interface PluginState {
    teamrig: {
      reload: TeamrigReload
    }
  }
}
