/** What a team's config and the hook's environment add to the read-only shell check. */
export interface ReadonlyRules {
  /**
   * The command prefixes the team trusts (`readonlyShell.allowPrefixes`), each as its words: a command that starts
   * with one runs whatever arguments follow, which the team vouches for.
   */
  readonly prefixes: readonly (readonly string[])[];
  /** The names in the environment the shell inherits: assigning one changes what every later program reads. */
  readonly exported: ReadonlySet<string>;
}

/** One word of a command as the prefix match reads it. */
export interface PrefixWord {
  readonly text: string;
  readonly dynamic: boolean;
}

/**
 * How a configured prefix is written: words a command line spells the same way unquoted, one space apart, the first
 * naming a program (no leading `-`, and no `=`, which would set a variable). Anything else could never match a
 * command as written.
 */
export const PREFIX_PATTERN = /^[\w@./:+][\w@./:+-]*(?: [\w@./:=+-]+)*$/;

/** A configured prefix as its words (`npx tsc --noEmit` is three), split on the one space `PREFIX_PATTERN` allows. */
export function prefixWords(prefix: string): readonly string[] {
  return prefix.split(' ');
}

/** Whether the command's first words are, static and in order, the words of one of `prefixes`. */
export function startsWithPrefix(words: readonly PrefixWord[], prefixes: readonly (readonly string[])[]): boolean {
  return prefixes.some(
    (prefix) =>
      prefix.length <= words.length &&
      prefix.every((text, index) => {
        const word = words[index];
        return word !== undefined && !word.dynamic && word.text === text;
      }),
  );
}
