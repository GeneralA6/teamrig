/** A file's text and where it is, for the duplicate search. */
export interface TextFile {
  readonly path: string;
  readonly text: string;
}

/** A line or sentence that repeats one seen earlier, in another file or the same one. */
export interface Duplicate {
  readonly path: string;
  readonly line: number;
  /** The repeat as written, without its list marker. */
  readonly text: string;
  readonly firstPath: string;
  readonly firstLine: number;
}

/** A shorter line or sentence is too common to count as a repeat (a heading, "Never skip hooks."). */
export const DUPLICATE_MIN_CHARS = 40;

const SENTENCE_END = /(?<=[.!?])\s+/;
const LIST_MARKER = /^(?:#+|[-*+>]|\d+[.)])\s*/;
const TRAILING_PUNCTUATION = /[\s.,;:!?]+$/;

/** A unit's text with its list marker, numbering and the ends of its spaces taken off. */
function trimmed(text: string): string {
  return text.trim().replace(LIST_MARKER, '').trim();
}

/** The key two units share when they say the same thing: lowercase, single spaces, no closing punctuation. */
export function normalUnit(text: string): string {
  return trimmed(text).toLowerCase().replace(/\s+/g, ' ').replace(TRAILING_PUNCTUATION, '');
}

/**
 * Every line or sentence (DUPLICATE_MIN_CHARS or longer once normalized) that repeats one before it, in file order:
 * the first one is kept, each later one is a duplicate naming where the first is.
 */
export function findDuplicates(files: readonly TextFile[]): Duplicate[] {
  const first = new Map<string, { readonly path: string; readonly line: number }>();
  const found: Duplicate[] = [];
  for (const file of files) {
    file.text.split(/\r?\n/).forEach((lineText, index) => {
      for (const unit of lineText.split(SENTENCE_END)) {
        const key = normalUnit(unit);
        if (key.length < DUPLICATE_MIN_CHARS) {
          continue;
        }
        const seen = first.get(key);
        if (seen === undefined) {
          first.set(key, { path: file.path, line: index + 1 });
        } else {
          found.push({ path: file.path, line: index + 1, text: trimmed(unit), firstPath: seen.path, firstLine: seen.line });
        }
      }
    });
  }
  return found;
}
