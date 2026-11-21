import { isHttpsUrl, type HttpClient } from '../core/http.ts';

/** How many redirects a fetch follows: a release file answers one, to the host that stores it. */
export const MAX_REDIRECTS = 3;

/** The statuses that send a GET on to another address. */
const REDIRECTS: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

export type ArchiveFetch = { readonly ok: true; readonly bytes: Uint8Array } | { readonly ok: false; readonly reason: string };

function failed(reason: string): ArchiveFetch {
  return { ok: false, reason };
}

/** The address a redirect names, read against the one that answered it; undefined when it is no URL. */
function nextOf(location: string, from: string): string | undefined {
  return URL.canParse(location, from) ? new URL(location, from).href : undefined;
}

/**
 * The bytes at `url`, an https address, fetched with no header of any kind. The client hands a redirect back
 * unfollowed, so this follows up to `MAX_REDIRECTS` itself and holds each hop to https. A reason never quotes an
 * address: a file store's redirect carries a signed one.
 *
 * The client answers text, so the bytes are that text's UTF-8: a file that was not UTF-8 comes back changed, and
 * then misses the sha256 its reader pins, which is the refusal it should get.
 */
export async function fetchArchive(http: HttpClient, url: string): Promise<ArchiveFetch> {
  let address = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    if (!isHttpsUrl(address)) return failed(hop === 0 ? 'its address is not an https URL' : 'it was redirected to an address that is not an https URL');
    const result = await http.send({ method: 'GET', url: address });
    if (result.kind === 'failed') return failed(result.reason);
    if (result.status === 200) return { ok: true, bytes: new TextEncoder().encode(result.body) };
    if (!REDIRECTS.has(result.status)) return failed(`the server answered ${result.status}`);
    const location = result.headers['location'];
    const next = location === undefined ? undefined : nextOf(location, address);
    if (next === undefined) return failed(`the server answered ${result.status} with no address to go to`);
    address = next;
  }
  return failed(`it was redirected more than ${MAX_REDIRECTS} times`);
}
