import type { Env } from '../core/home.ts';
import type { CredentialRead, CredentialStore } from '../core/credentials.ts';
import { tokenName } from '../issues/token-names.ts';

/**
 * How a command reaches one repository: through the token saved for the repository's owner, which gh gets as
 * `GH_TOKEN` for that run only. The secret is never printed.
 */
export interface RepoAccess {
  /** The environment gh runs with, `GH_TOKEN` set to the owner's saved token. */
  readonly env: Env;
  /** The repository's owner, in lowercase. */
  readonly owner: string;
  /** The credential that holds the owner's token. */
  readonly credential: string;
  /** The command that saves that credential, for a message that says how. */
  readonly save: string;
}

/**
 * The owner's saved key cannot be used, so the command stops for that owner. The gh login never stands in for it:
 * that login may reach far more repositories, with far more rights, than the key the team saved for the owner.
 */
export abstract class NoAccessError extends Error {}

/** The store holds an owner's credential but could not read it, such as a locked keyring. */
export class TokenReadError extends NoAccessError {
  override readonly name = 'TokenReadError';

  constructor(credential: string, label: string, reason: string, save: string) {
    super(`could not read ${credential} from ${label}: ${reason}; unlock the store and rerun, or save the key again with: ${save}`);
  }
}

/** No key is saved for the owner. */
export class TokenMissingError extends NoAccessError {
  override readonly name = 'TokenMissingError';

  constructor(owner: string, credential: string, label: string, save: string) {
    super(`no token for ${owner} is saved as ${credential} in ${label}; teamrig reaches a repository only with its owner's saved token, never the gh login: save one with: ${save}`);
  }
}

/** The owner of `owner/name`, in lowercase. */
export function repoOwner(repo: string): string {
  return repo.slice(0, repo.indexOf('/')).toLowerCase();
}

/**
 * The access to each repository, reading the store once per owner. A fine-grained GitHub token reaches the
 * repositories of one owner only, so a team that reads a personal account's and an organisation's
 * repositories saves one token for each, by name: no config names them. An owner with no saved token, or one
 * the store could not read, gives a NoAccessError, which stops the command for that owner.
 */
export class RepoTokens {
  private readonly store: CredentialStore;
  private readonly env: Env;
  private readonly reads = new Map<string, Promise<CredentialRead>>();

  constructor(store: CredentialStore, env: Env) {
    this.store = store;
    this.env = env;
  }

  /** The access to `repo` through its owner's saved token, or the error that stops the command when there is none to use. */
  async accessFor(repo: string): Promise<RepoAccess | NoAccessError> {
    const owner = repoOwner(repo);
    const credential = tokenName(owner);
    const save = this.store.saveCommand(credential);
    const read = await this.readOnce(credential);
    switch (read.kind) {
      case 'found':
        return { env: { ...this.env, GH_TOKEN: read.secret }, owner, credential, save };
      case 'missing':
        return new TokenMissingError(owner, credential, this.store.label, save);
      case 'failed':
        return new TokenReadError(credential, this.store.label, read.reason, save);
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
