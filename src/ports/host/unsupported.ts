/** What a host adapter gives in place of a port its tool cannot fill: the reason, in words a human reads. */
export interface Unsupported {
  readonly kind: 'unsupported';
  readonly notice: string;
}

export function unsupported(notice: string): Unsupported {
  return { kind: 'unsupported', notice };
}

/** Whether a port's place holds an {@link Unsupported}: the core asks before it calls the port. */
export function isUnsupported(port: object): port is Unsupported {
  return 'kind' in port && port.kind === 'unsupported' && 'notice' in port && typeof port.notice === 'string';
}
