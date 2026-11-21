/** What a connector is to the team: where its issues live, or where its code and pull requests do. */
export const CONNECTOR_KINDS = ['tracker', 'codehost'];
export function isConnectorKind(value) {
    return CONNECTOR_KINDS.some((kind) => kind === value);
}
