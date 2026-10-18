import { SECRET_TEXT_PATTERNS, SECRET_TOKEN_PATTERNS } from "./secret-patterns.js";
/**
 * Refuses text that looks like it carries a secret, before it lands in a shared file, or redacts it. Every write path that
 * checks for secrets (inbox lines; task titles, descriptions, refs, notes and evidence) goes through this one class, which
 * always applies the shapes in `secret-patterns.ts`, whatever a team adds.
 */
export class SecretScanner {
    patterns;
    /** `extra` are regular expression sources from the config, matched case-insensitively. */
    constructor(extra = []) {
        const configured = extra.map((source, index) => ({
            id: `config-${index + 1}`,
            description: 'secret pattern from the team config',
            pattern: new RegExp(source, 'iu'),
        }));
        this.patterns = [...SECRET_TOKEN_PATTERNS, ...SECRET_TEXT_PATTERNS, ...configured];
    }
    /** The first secret shape `text` matches; undefined when it matches none. */
    find(text) {
        return this.patterns.find(({ pattern }) => pattern.test(text));
    }
    /** Why `subject` is refused, or undefined when `text` looks clean. The reason names the shape, never the text. */
    refusal(subject, text) {
        const found = this.find(text);
        return found === undefined ? undefined : `${subject} looks like it holds a secret (${found.description}); refer to where it is kept instead`;
    }
    /**
     * `text` with each match of a secret shape, up to the end of its word, replaced by `[redacted <shape>]`: for a
     * line a team's own command printed, written where others read it. A shape matches only a secret's start (a
     * `password=` and one character), so the rest of the word goes too.
     */
    redact(text) {
        return this.patterns.reduce((line, { pattern, description }) => line.replace(new RegExp(`(?:${pattern.source})\\S*`, `${pattern.flags}g`), `[redacted ${description}]`), text);
    }
}
