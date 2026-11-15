/**
 * A post on an issue or pull request as an issue host (host.ts) reads it for the mention scan: a comment, an inline
 * review comment, a review or the item's own body. Its text and author are outside input: matched in code, never run,
 * and only a capped excerpt of it ever reaches a session.
 */
export interface HostPost {
  /** Unique in its repository and stable across edits, such as `comment:<id>` or `body:<number>`. */
  readonly key: string;
  /** The issue or pull request it is on. */
  readonly number: number;
  readonly url: string;
  /** The login that wrote it; `ghost` for a deleted account. */
  readonly author: string;
  readonly text: string;
  /** When it was last written or edited (an ISO time). */
  readonly updatedAt: string;
}
