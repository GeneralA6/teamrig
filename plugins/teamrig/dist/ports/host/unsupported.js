export function unsupported(notice) {
    return { kind: 'unsupported', notice };
}
/** Whether a port's place holds an {@link Unsupported}: the core asks before it calls the port. */
export function isUnsupported(port) {
    return 'kind' in port && port.kind === 'unsupported' && 'notice' in port && typeof port.notice === 'string';
}
