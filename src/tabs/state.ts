/**
 * What a session is doing, as its tab shows it. Apart from the tab title code (status.ts), which reads transcripts,
 * so the public interface's document builders, which reach no file code, can name a tab's state.
 */
export type TabState = 'ready' | 'working' | 'waiting' | 'decision' | 'error' | 'compacting';
