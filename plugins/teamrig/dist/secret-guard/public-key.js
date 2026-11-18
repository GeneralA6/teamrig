import { createPublicKey } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
/** The most bytes the guard reads of a `.pub.pem` file to tell a public key; a longer file stays a secret (#875). */
export const PUBLIC_KEY_MAX_BYTES = 64 * 1024;
/** The glob that lists every `.pem` file, the one whose `.pub.pem` names the content check may clear. */
export const PEM_GLOB = '**/*.pem';
/** The name ending of a file the content check reads. */
export const PUBLIC_PEM_SUFFIX = '.pub.pem';
const BEGIN = /^-----BEGIN (PUBLIC KEY|RSA PUBLIC KEY)-----$/;
const END = /^-----END (PUBLIC KEY|RSA PUBLIC KEY)-----$/;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
/**
 * Whether the base64 `body` of a block labelled `label` is exactly one public key Node's crypto reads: base64 that
 * only looks like one does not parse, and the key read back must give the same bytes and the same base64, since the
 * parse alone would pass a key with other bytes behind it, and the decoder drops text behind a padding `=`.
 */
function parsesAsPublicKey(label, body) {
    try {
        const text = body.join('');
        const der = Buffer.from(text, 'base64');
        const type = label === 'RSA PUBLIC KEY' ? 'pkcs1' : 'spki';
        const key = createPublicKey({ key: der, format: 'der', type });
        return key.type === 'public' && der.toString('base64') === text && key.export({ type, format: 'der' }).equals(der);
    }
    catch {
        return false;
    }
}
/**
 * True when `text` holds one or more PEM blocks labelled exactly `PUBLIC KEY` or `RSA PUBLIC KEY` and nothing else but
 * blank lines: each block closed under its own label, base64 alone inside, and each one a public key Node's crypto
 * parses. The label check stays beside the parse, since crypto would also take a private key block and derive its
 * public half. A private key, a key-shaped label around other base64 (a token, a private key's DER), any other block
 * or any other text, even a note, reads as false, so no secret rides in beside a public key.
 */
export function holdsPublicKeysOnly(text) {
    let open;
    let block = [];
    let blocks = 0;
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (open === undefined) {
            if (line === '') {
                continue;
            }
            open = BEGIN.exec(line)?.[1];
            if (open === undefined) {
                return false;
            }
            block = [];
        }
        else if (END.exec(line)?.[1] === open) {
            if (!parsesAsPublicKey(open, block)) {
                return false;
            }
            open = undefined;
            blocks += 1;
        }
        else if (BASE64.test(line)) {
            block.push(line);
        }
        else {
            return false;
        }
    }
    return open === undefined && blocks > 0;
}
/**
 * The text of the regular file at `path`, read at once, for the content check; undefined when it is no regular file
 * (a folder, or a pipe that would block the guard), cannot be read, or is past {@link PUBLIC_KEY_MAX_BYTES}.
 */
export function readKeyText(path) {
    let fd;
    try {
        // Opened without blocking and checked on the open file, so a file swapped for a pipe after a check never holds
        // the guard past its hook's time limit, which would let the call through.
        fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
        if (!fstatSync(fd).isFile()) {
            return undefined;
        }
        const buffer = Buffer.alloc(PUBLIC_KEY_MAX_BYTES + 1);
        let size = 0;
        for (;;) {
            const read = readSync(fd, buffer, size, buffer.length - size, size);
            if (read === 0 || size + read === buffer.length) {
                size += read;
                break;
            }
            size += read;
        }
        return size > PUBLIC_KEY_MAX_BYTES ? undefined : buffer.toString('utf8', 0, size);
    }
    catch {
        return undefined;
    }
    finally {
        if (fd !== undefined) {
            closeSync(fd);
        }
    }
}
