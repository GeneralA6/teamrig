import { printable } from "../core/printable.js";
/** What a cut field holds in place of its text. */
export function cutText(shape) {
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
    found = [];
    shapes;
    constructor(shapes) {
        this.shapes = shapes;
    }
    /** The cuts made so far, in the order the texts were served. */
    get cuts() {
        return [...this.found];
    }
    /** Whether serving `text` would cut it: asked first by a record whose own id is made from its text. */
    wouldCut(text) {
        return this.shapes.find(text) !== undefined;
    }
    /** A team text field of record `id`. */
    plain(id, field, text) {
        return this.scanned(id, field, text);
    }
    /** {@link plain} for a field that may be unset. */
    plainOrNull(id, field, text) {
        return text === null ? null : this.scanned(id, field, text);
    }
    /** A field that may hold outside text, marked with who wrote it. */
    marked(id, field, text, source) {
        const scanned = this.scanned(id, field, text);
        return { text: source === 'outside' ? printable(scanned) : scanned, source };
    }
    /** {@link marked} for a field that may be unset. */
    markedOrNull(id, field, text, source) {
        return text === null ? null : this.marked(id, field, text, source);
    }
    scanned(id, field, text) {
        const shape = this.shapes.find(text)?.description;
        if (shape === undefined) {
            return text;
        }
        this.found.push({ id, field, shape });
        return cutText(shape);
    }
}
