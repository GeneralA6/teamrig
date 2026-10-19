/**
 * teamrig's contract with Claude Code: the session values its mod (hooks/register.ts) keeps through `$.state`.
 */

/**
 * The reload hand's last /reload-plugins in this session (src/mod/reload-hand.ts ReloadRecord): the installs it
 * reloaded for and when, in milliseconds since the epoch. The mod the reload loads reads it back, checking its shape,
 * so it keeps the gap between reloads and never runs a second one for the same installs.
 */
export type TeamrigReload = { readonly fingerprint: string; readonly at: number }

/**
 * The band above the prompt while a refresh's /clear is near (src/mod/clear-hand.ts BandView): the count to the
 * /clear in whole seconds, or that it comes with the restart's next ask. The clear hand writes it each time it
 * changes, null when there is no band, and the band's drawing reads it, so a write redraws the band.
 */
export type TeamrigBand = { readonly kind: 'counting'; readonly secondsLeft: number } | { readonly kind: 'refreshing' }

declare module 'claude-code' {
  interface PluginState {
    teamrig: {
      reload: TeamrigReload
      band: TeamrigBand | null
    }
  }
}
