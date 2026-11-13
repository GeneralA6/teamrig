import type { Env } from '../core/home.ts';
import type { CredentialRead, CredentialStore } from './credentials.ts';

/**
 * How a command reaches one repository: through the gh login, or through the token saved for the repository's
 * owner, which gh gets as `GH_TOKEN` for that run only. The secret is never printed.
 */
export interface RepoAccess {
  readonly via: 'login' | 'token';
  /** The environment gh runs with: `GH_TOKEN` is set only when a token reads the repository. */
  readonly env: Env;
  /** The repository's owner, in lowercase. */
  readonly owner: string;
  /** The credential that holds the owner's token: the one read, or the name to save one under. */
  readonly credential: string;
  /** The command that saves that credential, for a message that says how. */
  readonly save: string;
}

/**
 * The store holds an owner's credential but could not read it, such as a locked keyring. The command stops: the gh
 * login may reach far more than the saved key does, so it never stands in for a key that is there.
 */
export class TokenReadError extends Error {
  override readonly name = 'TokenReadError';

  constructor(credential: string, label: string, reason: string, save: string) {
    super(`could not read ${credential} from ${label}: ${reason}; unlock the store and rerun, or save the key again with: ${save}`);
  }
}

/** The prefix of the credential that holds an owner's token: `teamrig-gh-<owner>`, the owner in lowercase. */
export const TOKEN_PREFIX = 'teamrig-gh-';

/** The owner of `owner/name`, in lowercase. */
export function repoOwner(repo: string): string {
  return repo.slice(0, repo.indexOf('/')).toLowerCase();
}

/** The name of the credential `teamrig gh sync` looks for to read `owner`'s repositories. */
export function tokenName(owner: string): string {
  return `${TOKEN_PREFIX}${owner.toLowerCase()}`;
}

/**
 * The access to each repository, reading the store once per owner. A fine-grained GitHub token reaches the
 * repositories of one owner only, so a team that reads a personal account's and an organisation's
 * repositories saves one token for each, by name: no config names them. An owner with no saved token is
 * reached through the gh login; a token the store holds but could not read gives a TokenReadError, which stops
 * the command: never the gh login in its place.
 */
export class RepoTokens {
  private readonly store: CredentialStore;
  private readonly env: Env;
  private readonly reads = new Map<string, Promise<CredentialRead>>();

  constructor(store: CredentialStore, env: Env) {
    this.store = store;
    this.env = env;
  }

  /** The access to `repo`, or, when the store holds its owner's key but could not read it, the error that stops the command. */
  async accessFor(repo: string): Promise<RepoAccess | TokenReadError> {
    const owner = repoOwner(repo);
    const credential = tokenName(owner);
    const login: RepoAccess = { via: 'login', env: this.env, owner, credential, save: this.store.saveCommand(credential) };
    const read = await this.readOnce(credential);
    switch (read.kind) {
      case 'found':
        return { ...login, via: 'token', env: { ...this.env, GH_TOKEN: read.secret } };
      case 'missing':
        return login;
      case 'failed':
        return new TokenReadError(credential, this.store.label, read.reason, login.save);
    }
  }

  private readOnce(credential: string): Promise<CredentialRead> {
    const known = this.reads.get(credential);
    if (known !== undefined) {
      return known;
    }
    const read = this.store.read(credential);
    this.reads.set(credential, read);
    return read;
  }
}
