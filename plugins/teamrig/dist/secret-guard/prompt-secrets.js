import { SECRET_TEXT_PATTERNS, SECRET_TOKEN_PATTERNS } from "../core/secret-patterns.js";
import { configuredPatterns } from "../core/secrets.js";
import { sha256Hex } from "../exec/digest.js";
/** A value a framing shape holds that only stands in for a secret: `<pass>`, `${TOKEN}`, `*****`, `changeme`, `...`. */
const PLACEHOLDER = /[<>${}*[\]]|^(?:pass|password|passwd|pwd|secret|user|xxx+|changeme|example|redacted|\.\.\.)$/i;
/** A framed value shorter than this is a word, not a secret (`https://u:p@host` in an example). */
const MIN_FRAMED_SECRET = 6;
/**
 * `password: x` is ordinary prose in a prompt, so the assignment shape would block the owner's own words; a prompt is
 * scanned for tokens, credentials in a URL and Authorization headers only.
 */
const PROSE_SHAPES = new Set(['secret-assignment']);
/**
 * Finds the secrets a prompt carries and keeps only their hashes (T1481), so a blocked prompt's value can be found again
 * in Claude Code's history files without being held, logged or printed anywhere.
 */
export class PromptSecrets {
    patterns;
    /** `extra` are the team config's `secretPatterns` sources, matched case-insensitively. */
    constructor(extra = []) {
        this.patterns = [...SECRET_TOKEN_PATTERNS, ...SECRET_TEXT_PATTERNS.filter(({ id }) => !PROSE_SHAPES.has(id)), ...configuredPatterns(extra)].map((shape) => ({ shape, global: new RegExp(shape.pattern.source, `${shape.pattern.flags}g`) }));
    }
    /** Every distinct secret in `text`, in the order found; a placeholder in a framing shape is not one. */
    secretsIn(text) {
        const found = new Map();
        for (const { shape, global } of this.patterns) {
            for (const match of text.matchAll(global)) {
                const value = shape.secretGroup === undefined ? match[0] : match[shape.secretGroup];
                if (value === undefined || value === '' || (shape.secretGroup !== undefined && isPlaceholder(value)))
                    continue;
                const hash = sha256Hex(value);
                if (!found.has(hash))
                    found.set(hash, { id: shape.id, description: shape.description, hash });
            }
        }
        return [...found.values()];
    }
    /** The hashes among `hashes` whose secret `text` holds. */
    hashesIn(text, hashes) {
        return this.secretsIn(text)
            .map(({ hash }) => hash)
            .filter((hash) => hashes.has(hash));
    }
}
function isPlaceholder(value) {
    return value.length < MIN_FRAMED_SECRET || PLACEHOLDER.test(value);
}
