/** Always refused, whatever a team adds: credentials in URLs and `password=`-style assignments. */
const BUILT_IN = [
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
    /\b(?:password|passwd|secret|api[_-]?key)\s*[=:]\s*\S/i,
];
/** Refuses text that looks like it carries a secret, before it lands in a shared file. */
export class SecretScanner {
    patterns;
    /** `extra` are regular expression sources from the config, matched case-insensitively. */
    constructor(extra = []) {
        this.patterns = [...BUILT_IN, ...extra.map((source) => new RegExp(source, 'iu'))];
    }
    looksSecret(text) {
        return this.patterns.some((pattern) => pattern.test(text));
    }
}
