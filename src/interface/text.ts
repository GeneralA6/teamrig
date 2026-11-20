import { printable } from '../core/printable.ts';

/** Who wrote a served text: the team's own sessions and people, or someone outside it (an imported issue's author). */
export type TextSource = 'team' | 'outside';

/**
 * A field that can hold text from outside the team. It always has this form, whoever wrote it, so a reader's type
 * never changes with the data and it can never draw outside text as the team's own by forgetting a check.
 */
export interface MarkedText {
  readonly text: string;
  readonly source: TextSource;
}

/** A text left out of a document because it matched a secret's shape: which record, which field and which shape. */
export interface Cut {
  /** The record's own id: a task's id, an inbox line's key, a setting's path. */
  readonly id: string;
  readonly field: string;
  /** The shape's name, never the matched text. */
  readonly shape: string;
}

/** What finds a secret's shape in a text; `SecretScanner` (src/core/secrets.ts) is the one the CLI passes. */
export interface SecretShapes {
  find(text: string): { readonly description: string } | undefined;
}

/** What a cut field holds in place of its text. */
export function cutText(shape: string): string {
  return `[cut: ${shape}]`;
}

/**
 * Every free text of one document passes through here on its way out. A text that matches a secret's shape is not
 * served: the whole field becomes a fixed text naming the shape, since a shape matches only a secret's start and
 * nothing beside it may leak, and the cut is kept for the document's `cuts`. Outside text has its control characters
 * and bidi marks escaped, so a reader that prints it gets no escape sequence and no reordered line; team text is
 * served as written, line breaks included.
 */
export class ServedText {
  private readonly found: Cut[] = [];
  private readonly shapes: SecretShapes;

  constructor(shapes: SecretShapes) {
    this.shapes = shapes;
  }

  /** The cuts made so far, in the order the texts were served. */
  get cuts(): readonly Cut[] {
    return [...this.found];
  }

  /** A team text field of record `id`. */
  plain(id: string, field: string, text: string): string {
    return this.scanned(id, field, text);
  }

  /** {@link plain} for a field that may be unset. */
  plainOrNull(id: string, field: string, text: string | null): string | null {
    return text === null ? null : this.scanned(id, field, text);
  }

  /** A field that may hold outside text, marked with who wrote it. */
  marked(id: string, field: string, text: string, source: TextSource): MarkedText {
    const scanned = this.scanned(id, field, text);
    return { text: source === 'outside' ? printable(scanned) : scanned, source };
  }

  /** {@link marked} for a field that may be unset. */
  markedOrNull(id: string, field: string, text: string | null, source: TextSource): MarkedText | null {
    return text === null ? null : this.marked(id, field, text, source);
  }

  private scanned(id: string, field: string, text: string): string {
    const shape = this.shapes.find(text)?.description;
    if (shape === undefined) {
      return text;
    }
    this.found.push({ id, field, shape });
    return cutText(shape);
  }
}
