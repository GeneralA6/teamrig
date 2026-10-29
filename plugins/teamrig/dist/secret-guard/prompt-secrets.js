import { SecretShapes } from "../core/secret-shapes.js";
import { sha256Hex } from "../exec/digest.js";
/**
 * Finds the secrets a prompt carries by the write-time set (`core/secret-shapes.ts`) and keeps only their hashes (T1481),
 * so a blocked prompt's value can be found again in Claude Code's history files without being held, logged or printed
 * anywhere.
 */
export class PromptSecrets {
    shapes;
    /** `extra` are the team config's `secretPatterns` sources, matched case-insensitively. */
    constructor(extra = []) {
        this.shapes = new SecretShapes(extra);
    }
    /** Every distinct secret in `text`, in the order found; a placeholder in a framing shape is not one. */
    secretsIn(text) {
        const found = new Map();
        for (const { id, description, value } of this.shapes.hitsIn(text)) {
            const hash = sha256Hex(value);
            if (!found.has(hash))
                found.set(hash, { id, description, hash });
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
