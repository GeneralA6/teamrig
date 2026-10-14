export interface Signoff {
  readonly name: string;
  readonly email: string;
}

const SIGNOFF_LINE = /^Signed-off-by:[ \t]*(.+?)[ \t]*<([^<>\s]+)>[ \t]*$/gim;

export function parseSignoffs(message: string): Signoff[] {
  return [...message.matchAll(SIGNOFF_LINE)].map((match) => ({ name: match[1] ?? '', email: match[2] ?? '' }));
}

/** Why `message` fails the DCO rule for a commit by `authorEmail`, or undefined when it passes. */
export function signoffProblem(authorEmail: string, message: string): string | undefined {
  const signoffs = parseSignoffs(message);
  if (signoffs.length === 0) {
    return 'no Signed-off-by line; commit with `git commit -s`';
  }
  const author = authorEmail.toLowerCase();
  return signoffs.some((signoff) => signoff.email.toLowerCase() === author)
    ? undefined
    : "no Signed-off-by line matches the commit author's e-mail";
}

/** Reads the e-mail from a git ident such as the output of `git var GIT_AUTHOR_IDENT`. */
export function emailFromIdent(ident: string): string {
  const email = /<([^<>]*)>/.exec(ident)?.[1];
  if (email === undefined || email === '') {
    throw new Error('cannot read an e-mail from the git author ident');
  }
  return email;
}
