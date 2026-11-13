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
/** The name of the credential `teamrig gh sync` looks for to read `owner`'s repositories. */
export function tokenName(owner) {
    return `${TOKEN_PREFIX}${owner.toLowerCase()}`;
}
/**
 * The access to each repository, reading the store once per owner. A fine-grained GitHub token reaches the
 * repositories of one owner only, so a team that reads a personal account's and an organisation's
 * repositories saves one token for each, by name: no config names them. An owner with no saved token is
 * read through the gh login, and so is one whose store could not be read, with a note saying why.
 */
export class RepoTokens {
    store;
    env;
    reads = new Map();
    constructor(store, env) {
        this.store = store;
        this.env = env;
    }
    async accessFor(repo) {
        const owner = repoOwner(repo);
        const credential = tokenName(owner);
        const login = { via: 'login', env: this.env, owner, credential, save: this.store.saveCommand(credential) };
        const read = await this.readOnce(credential);
        switch (read.kind) {
            case 'found':
                return { access: { ...login, via: 'token', env: { ...this.env, GH_TOKEN: read.secret } } };
            case 'missing':
                return { access: login };
            case 'failed':
                return { access: login, note: `could not read ${credential} from ${this.store.label}: ${read.reason}` };
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
