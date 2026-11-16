/**
 * The owner's saved key cannot be used, so the command stops for that owner. The gh login never stands in for it:
 * that login may reach far more repositories, with far more rights, than the key the team saved for the owner.
 */
export class NoAccessError extends Error {
}
/** The store holds an owner's credential but could not read it, such as a locked keyring. */
export class TokenReadError extends NoAccessError {
    name = 'TokenReadError';
    constructor(credential, label, reason, save) {
        super(`could not read ${credential} from ${label}: ${reason}; unlock the store and rerun, or save the key again with: ${save}`);
    }
}
/** No key is saved for the owner. */
export class TokenMissingError extends NoAccessError {
    name = 'TokenMissingError';
    constructor(owner, credential, label, save) {
        super(`no token for ${owner} is saved as ${credential} in ${label}; teamrig reaches a repository only with its owner's saved token, never the gh login: save one with: ${save}`);
    }
}
/** The prefix of the credential that holds an owner's token: `teamrig-gh-<owner>`, the owner in lowercase. */
export const TOKEN_PREFIX = 'teamrig-gh-';
/**
 * The credential the ship tool (tools/ship) reads its own GitHub token from, apart from the owners' tokens. Kept here
 * beside `TOKEN_PREFIX` so the secret guard refuses a session line naming either from one source.
 */
export const SHIP_TOKEN = 'teamrig-ship-gh';
/** The owner of `owner/name`, in lowercase. */
export function repoOwner(repo) {
    return repo.slice(0, repo.indexOf('/')).toLowerCase();
}
/** The name of the credential `teamrig issue sync` looks for to read `owner`'s repositories. */
export function tokenName(owner) {
    return `${TOKEN_PREFIX}${owner.toLowerCase()}`;
}
/**
 * The access to each repository, reading the store once per owner. A fine-grained GitHub token reaches the
 * repositories of one owner only, so a team that reads a personal account's and an organisation's
 * repositories saves one token for each, by name: no config names them. An owner with no saved token, or one
 * the store could not read, gives a NoAccessError, which stops the command for that owner.
 */
export class RepoTokens {
    store;
    env;
    reads = new Map();
    constructor(store, env) {
        this.store = store;
        this.env = env;
    }
    /** The access to `repo` through its owner's saved token, or the error that stops the command when there is none to use. */
    async accessFor(repo) {
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
    readOnce(credential) {
        const known = this.reads.get(credential);
        if (known !== undefined) {
            return known;
        }
        const read = this.store.read(credential);
        this.reads.set(credential, read);
        return read;
    }
}
