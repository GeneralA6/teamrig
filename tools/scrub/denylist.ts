import type { ScrubRule } from './rules.ts';

export class DenylistError extends Error {
  readonly line: number;

  constructor(line: number, reason: string) {
    super(`denylist line ${line}: ${reason}`);
    this.name = 'DenylistError';
    this.line = line;
  }
}

const LITERAL = /^\/(.+)\/([a-z]*)$/;

/**
 * Parses a private denylist: one rule per line, `/regex/flags` as given or a bare
 * case-insensitive regex; blank lines and `#` comments are skipped.
 */
export function parseDenylist(text: string): ScrubRule[] {
  const rules: ScrubRule[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      return;
    }
    rules.push({
      id: `denylist:${index + 1}`,
      description: 'private denylist term',
      pattern: compile(line, index + 1),
      revealMatch: true,
    });
  });
  return rules;
}

function compile(line: string, lineNumber: number): RegExp {
  const literal = LITERAL.exec(line);
  const source = literal ? (literal[1] ?? '') : line;
  const flags = literal ? (literal[2] ?? '') : 'i';
  if (flags.includes('y')) {
    throw new DenylistError(lineNumber, 'the sticky flag "y" is not supported');
  }
  try {
    return new RegExp(source, flags.includes('g') ? flags : `${flags}g`);
  } catch (error) {
    throw new DenylistError(lineNumber, error instanceof Error ? error.message : String(error));
  }
}
