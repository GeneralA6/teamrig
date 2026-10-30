/** Claude Code's rough rate: a token is about four characters of English. */
const CHARS_PER_TOKEN = 4;

/** A finding's line in `teamrig setup scan`, without its id, and the tokens per turn applying it saves (0 for one that saves none). */
export interface Finding {
  readonly kind: string;
  readonly where: string;
  readonly what: string;
  readonly saves: number;
}

export function tokensOf(chars: number): number {
  return Math.ceil(chars / CHARS_PER_TOKEN);
}
