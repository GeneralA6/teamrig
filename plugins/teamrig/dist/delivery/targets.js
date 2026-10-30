/** What a deploy of `repo` disturbs: what a push to its default branch deploys and what its deploy block deploys, each once. */
export function repoTargetsOf(repo) {
    return [...new Set([...repo.deploysOnPush, ...(repo.deploy?.targets ?? [])])];
}
/** Every target a freeze, a job or a stable period may name: what the team's repositories deploy on push and what their deploy blocks deploy, each once. */
export function deployTargetsOf(repos) {
    return [...new Set(Object.values(repos).flatMap(repoTargetsOf))];
}
