/**
 * A task's source. The owner's marker is the team's own word, so it is read first; a source that is neither the
 * marker nor a connector's is a session's, as the register only ever takes those three, and it stays one after the
 * session has left the team. Its name is served as a text of record `record` (the task's id).
 */
export function sourceOf(served, record, source, names) {
    const named = (kind, id, name) => ({ kind, id, name: served.plain(record, 'source.name', name) });
    if (source === names.owner) {
        return named('owner', source, source);
    }
    const connector = names.connectors.find((candidate) => candidate.id === source);
    if (connector !== undefined) {
        return named('connector', connector.id, connector.name);
    }
    return named('session', source, names.nameOf(source) ?? source);
}
