interface CompiledPattern {
  readonly keep: boolean;
  readonly pattern: RegExp;
}

/** Regular expressions over a text, case ignored, in order: the last one that matches decides, and a `!pattern` lets the text go. */
export class PatternList {
  private readonly patterns: readonly CompiledPattern[];

  constructor(patterns: readonly string[]) {
    this.patterns = patterns.map((pattern) => {
      const keep = pattern.startsWith('!');
      return { keep, pattern: new RegExp(keep ? pattern.slice(1) : pattern, 'iu') };
    });
  }

  /** True when the last pattern that matches `text` is not a `!pattern`. */
  matches(text: string): boolean {
    let matched = false;
    for (const { keep, pattern } of this.patterns) {
      if (pattern.test(text)) {
        matched = !keep;
      }
    }
    return matched;
  }
}
