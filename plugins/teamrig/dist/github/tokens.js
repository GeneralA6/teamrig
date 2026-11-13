/**
 * The store holds an owner's credential but could not read it, such as a locked keyring. The command stops: the gh
 * login may reach far more than the saved key does, so it never stands in for a key that is there.
 */
export class TokenReadError extends Error {
    name = 'TokenReadError';
    constructor(credential, label, reason, save) {
        super(`could not read ${credential} from ${label}: ${reason}; unlock the store and rerun, or save the key again with: ${save}`);
    }
}
/** The prefix of the credential that holds an owner's token: `teamrig-gh-<owner>`, the owner in lowercase. */
export const TOKEN_PREFIX = 'teamrig-gh-';
/** The owner of `owner/name`, in lowercase. */
export function repoOwner(repo) {
    return repo.slice(0, repo.indexOf('/')).toLowerCase();
}
/** The name of the credential `teamrig gh sync` looks for to read `owner`'s repositories. */
export function tokenName(owner) {
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
    store;
    env;
    reads = new Map();
    constructor(store, env) {
        this.store = store;
        this.env = env;
    }
    /** The access to `repo`, or, when the store holds its owner's key but could not read it, the error that stops the command. */
    async accessFor(repo) {
        const owner = repoOwner(repo);
        const credential = tokenName(owner);
        const login = { via: 'login', env: this.env, owner, credential, save: this.store.saveCommand(credential) };
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
