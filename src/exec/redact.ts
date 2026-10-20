import type { SecretScanner } from '../core/secrets.ts';

/** A value the executor put into a run's environment, by its variable's name. */
export interface InjectedValue {
  readonly name: string;
  readonly value: string;
}

/** A shorter injected value is not redacted by value: it would blank common words, and so short a value is no secret. */
export const MIN_REDACTED_LENGTH = 4;

/** The bounds of the output tail the audit log keeps: what a reviewer reads, and the counts the command printed. */
export const TAIL_LINES = 40;
export const TAIL_CHARS = 4000;

/** A URL's user part, with or without a password: `scheme://user:pass@` or `scheme://token@`. */
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/giu;

/** `value` as it appears percent-encoded in a URL; undefined when it has no such form (a lone surrogate). */
function encodedForm(value: string): string | undefined {
  try {
    return encodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}

/**
 * `text` (a command's output) made safe to keep where others read it: each injected value, also in its percent-encoded
 * form, becomes `[redacted NAME]` (longest first, so a value holding another goes whole); a URL's user part becomes
 * `[redacted]` and keeps the host; then the scanner's secret shapes go too.
 */
export function redact(text: string, values: readonly InjectedValue[], scanner: SecretScanner): string {
  const forms = values
    .filter(({ value }) => value.length >= MIN_REDACTED_LENGTH)
    .flatMap(({ name, value }) => [...new Set([value, encodedForm(value) ?? value])].map((form) => ({ name, form })))
    .sort((left, right) => right.form.length - left.form.length);
  const byValue = forms.reduce((out, { name, form }) => out.split(form).join(`[redacted ${name}]`), text);
  return scanner.redact(byValue.replace(URL_USERINFO, '$1[redacted]@'));
}

/** The last `maxLines` lines of `text` (newlines as `\n`), cut to its last `maxChars` characters when still longer. */
export function tailOf(text: string, maxLines: number = TAIL_LINES, maxChars: number = TAIL_CHARS): string {
  const lines = text.replace(/\r?\n$/u, '').split(/\r?\n/u);
  const kept = lines.slice(-maxLines).join('\n');
  return kept.length > maxChars ? kept.slice(-maxChars) : kept;
}
