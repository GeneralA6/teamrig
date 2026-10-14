import { ID_PATTERN, NAME_PATTERN } from './ids.ts';

/**
 * A session on any team of the machine: `<team>/<id>`. Neither an id nor a name ever holds `/`, so
 * the address splits cleanly, and a bare id or name still means a session of the caller's own team.
 */
export interface SessionAddress {
  readonly team: string;
  readonly id: string;
}

/** A qualified session id, `<team>/<id>`, as a register records a task sourced from another team. */
export const ADDRESS_PATTERN = new RegExp(`^${ID_PATTERN.source.slice(1, -1)}/${ID_PATTERN.source.slice(1, -1)}$`);

/** An address as typed: the team when one is given, and the session part, an id or any name it has had. */
export interface AddressText {
  readonly team: string | undefined;
  readonly session: string;
}

/** `<team>/<session>` or a bare `<session>`; undefined for anything else. */
export function splitAddress(text: string): AddressText | undefined {
  const parts = text.split('/');
  const [first, second] = parts;
  if (parts.length === 1 && first !== undefined && NAME_PATTERN.test(first)) {
    return { team: undefined, session: first };
  }
  if (parts.length === 2 && first !== undefined && second !== undefined && ID_PATTERN.test(first) && NAME_PATTERN.test(second)) {
    return { team: first, session: second };
  }
  return undefined;
}

export function formatAddress(address: SessionAddress): string {
  return `${address.team}/${address.id}`;
}
