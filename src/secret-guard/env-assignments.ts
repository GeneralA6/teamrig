import { isIdentifierName } from '../core/secret-patterns.ts';
import { isPlaceholderValue, type SecretShapeHit } from '../core/secret-shapes.ts';
import type { SecretNames } from './names.ts';

/**
 * `NAME=value` as an environment dump, a `.env` file or `docker inspect` prints it: an upper-case name with no space
 * around `=`. Source code writes `token = x` or `token: string`, so a Read or Grep of code passes. The value stops at
 * a space, a quote or a shell operator; a quoted value is the quoted-literal shape's.
 */
const ASSIGNMENT = /(?<![\w$])([A-Z][A-Z0-9_]*)=([^\s"'`;,&|()<>]+)/g;
/** A number: a limit, a port or a count (`TOKEN_LIMIT=200000`). */
const NUMBER = /^\d+(?:\.\d+)?$/;
/** A path to the secret, not the secret: `KEY_FILE=/a/b.pem`, `C:\k.pem`, `~/.ssh/id`, `./key`. */
const PATH = /^(?:[A-Za-z]:)?[\\/~.]/;
/** One plain lower-case word: a mode or a kind (`AUTH_MODE=oauth`, `TOKEN_TYPE=bearer`). */
const PLAIN_WORD = /^[a-z]+$/;

/**
 * The output-only shape of T1369 R7: the value of a secret variable, the name judged by the team's `SecretNames`.
 * Output is not prose, so the unquoted form is in here; prompts and notes stay without it.
 */
export class EnvAssignments {
  private readonly names: SecretNames;

  constructor(names: SecretNames) {
    this.names = names;
  }

  /** Every secret variable's value in `text`, in the order found; a value that only names or points to one passes. */
  hitsIn(text: string): SecretShapeHit[] {
    const hits: SecretShapeHit[] = [];
    for (const [, name = '', value = ''] of text.matchAll(ASSIGNMENT)) {
      if (!this.names.secret(name) || isPlainValue(value)) continue;
      hits.push({ id: 'env-assignment', description: 'value of a secret variable', value });
    }
    return hits;
  }
}

/** True when an assigned `value` is not a secret: a placeholder, a name, a number, a path or a plain word. */
function isPlainValue(value: string): boolean {
  return isPlaceholderValue(value) || isIdentifierName(value) || NUMBER.test(value) || PATH.test(value) || PLAIN_WORD.test(value);
}
