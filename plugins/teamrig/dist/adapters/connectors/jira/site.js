/**
 * Where a Jira Cloud project lives. The tracker port names a place by `repo`, which for Jira is `<site>/<project key>`
 * in lowercase (`acme/eng` is project ENG on acme.atlassian.net), so `acme/eng#12` is the issue ENG-12 and one saved
 * credential serves a whole site.
 */
/**
 * A site's name: the first label of its `atlassian.net` host. No dot and no slash, because it becomes the host of
 * every request's URL: a name that could spell another host would carry the sign-in header there.
 */
const SITE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** A project key as `repo` holds it, in lowercase: Jira's own is the same text in capitals. */
const PROJECT = /^[a-z][a-z0-9_]*$/;
/** The project `repo` names as `<site>/<project key>`, or undefined when it names none. */
export function parseProject(repo) {
    const [site, key, ...rest] = repo.split('/');
    if (site === undefined || key === undefined || rest.length > 0 || !SITE.test(site) || !PROJECT.test(key)) {
        return undefined;
    }
    return { site, key: key.toUpperCase() };
}
/** What a `repo` that names no project is told. */
export function projectProblem(repo) {
    return `${JSON.stringify(repo)} is not a Jira project: write it as <site>/<project key>, the site being the name before .atlassian.net`;
}
/** The site's own address, which a person opens. */
function siteUrl(site) {
    return `https://${site}.atlassian.net`;
}
/** The root of the site's REST API, version 3. */
export function baseUrl(site) {
    return `${siteUrl(site)}/rest/api/3`;
}
/** The name the site's sign-in is saved under in the operating system's store: the account's e-mail, a colon and its API token. */
export function credentialName(site) {
    return `teamrig-jira-${site}`;
}
/** The key of the project's issue `number`, as Jira names it (`ENG-12`). */
export function issueKey(project, number) {
    return `${project.key}-${number}`;
}
/** The number of the project's issue `key`; undefined when the key is another project's, or no issue key. */
export function issueNumber(project, key) {
    const prefix = `${project.key}-`;
    const digits = key.startsWith(prefix) ? key.slice(prefix.length) : '';
    return /^[1-9][0-9]{0,9}$/.test(digits) ? Number(digits) : undefined;
}
/** The page of the project's issue `number`. */
export function browseUrl(project, number) {
    return `${siteUrl(project.site)}/browse/${issueKey(project, number)}`;
}
