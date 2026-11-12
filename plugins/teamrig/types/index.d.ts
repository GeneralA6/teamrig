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

/** An update the band names (src/mod/update-hand.ts UpdateNotice): the plugin, its marketplace, installed and newest. */
export type TeamrigUpdateNotice = { readonly plugin: string; readonly marketplace: string; readonly installed: string; readonly newest: string }

/**
 * The update band above the prompt (src/mod/update-hand.ts UpdateView): an update out, one installing, one installed
 * and reloading, or one whose install failed and may be tried again. The update hand writes it each time what it
 * shows changes, null when it shows none, and the band's drawing reads it.
 */
export type TeamrigUpdate =
  | { readonly kind: 'available'; readonly notice: TeamrigUpdateNotice }
  | { readonly kind: 'updating'; readonly notice: TeamrigUpdateNotice }
  | { readonly kind: 'updated'; readonly plugin: string; readonly version: string }
  | { readonly kind: 'failed'; readonly notice: TeamrigUpdateNotice; readonly why: string }

/**
 * The meeting's agenda panel in the root team lead's tab (src/mod/meeting-panel-hand.ts MeetingPanelView): when the
 * meeting started, its cards in order (each one's id, title, whether it is decided and the decision, and a short
 * summary of what it asks), the card on the table and how many are left. The meeting panel hand writes it each time
 * it asks the CLI, null once no meeting is open, and the pane's drawing reads it.
 */
export type TeamrigMeetingPanel = {
  readonly startedAt: string
  readonly items: readonly {
    readonly id: string
    readonly title: string
    readonly settled: boolean
    readonly decision: string | null
    readonly summary: string | null
  }[]
  readonly current: string | null
  readonly left: number
}

declare module 'claude-code' {
  interface PluginState {
    teamrig: {
      reload: TeamrigReload
      band: TeamrigBand | null
      updateView: TeamrigUpdate | null
      meetingPanel: TeamrigMeetingPanel | null
    }
  }
}
