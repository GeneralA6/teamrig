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
 * /clear in whole seconds, that it comes with the restart's next ask, the person's hold (their keys in the tab or
 * their Hold) with the seconds it has left, or what else holds it (a live helper, a draft). The clear hand writes
 * it each time what it draws changes, null when there is no band, and the band's drawing reads it, so a write
 * redraws the band.
 */
export type TeamrigBand =
  | { readonly kind: 'counting'; readonly secondsLeft: number }
  | { readonly kind: 'refreshing' }
  | { readonly kind: 'waiting'; readonly by: 'activity' | 'button'; readonly secondsLeft: number }
  | { readonly kind: 'held'; readonly why: string }

/**
 * The update band above the prompt (src/mod/update-hand.ts UpdateNotice): the plugin a newer version is published
 * of, its marketplace, the version installed and the newest one. The update hand writes it each time the update it
 * shows changes, null when it shows none, and the band's drawing reads it.
 */
export type TeamrigUpdate = { readonly plugin: string; readonly marketplace: string; readonly installed: string; readonly newest: string }

declare module 'claude-code' {
  interface PluginState {
    teamrig: {
      reload: TeamrigReload
      band: TeamrigBand | null
      update: TeamrigUpdate | null
    }
  }
}
