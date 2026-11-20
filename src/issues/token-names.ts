/** The prefix of the credential that holds an owner's token: `teamrig-gh-<owner>`, the owner in lowercase. */
export const TOKEN_PREFIX = 'teamrig-gh-';

/**
 * The credential the ship tool (tools/ship) reads its own GitHub token from, apart from the owners' tokens. Kept here
 * beside `TOKEN_PREFIX` so the secret guard refuses a session line naming either from one source.
 */
export const SHIP_TOKEN = 'teamrig-ship-gh';

/** The name of the credential `teamrig issue sync` looks for to read `owner`'s repositories. */
export function tokenName(owner: string): string {
  return `${TOKEN_PREFIX}${owner.toLowerCase()}`;
}
