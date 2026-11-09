import { isRecord } from "../core/guards.js";
/**
 * How long one admission may hold the admit file: a step's look at the line, the memory gate's reads (about 2 s) and
 * its take; a claim older than this is an admission that died.
 */
export const ADMIT_TTL_MS = 30_000;
/** Tries per claim: a dead claim removed may be claimed again by another admission first. */
const ATTEMPTS = 3;
function isAdmitClaim(value) {
    return (isRecord(value) &&
        typeof value['ticket'] === 'string' &&
        typeof value['pid'] === 'number' &&
        typeof value['expiresAt'] === 'string' &&
        !Number.isNaN(Date.parse(value['expiresAt'])));
}
function parseClaim(text) {
    try {
        const value = JSON.parse(text);
        return isAdmitClaim(value) ? value : undefined;
    }
    catch {
        return undefined;
    }
}
/**
 * The host's admit file, `<lock>.admit`: one admission at a time holds it while it reads the host's room and takes its
 * share of it, so two admissions never both read the same room as free. It is created whole, naming its process, and
 * runs out after `ADMIT_TTL_MS`; a claim whose process is gone, that ran out or that cannot be read is removed by the
 * next admission that finds it.
 */
export class AdmitFile {
    path;
    ports;
    constructor(path, ports) {
        this.path = path;
        this.ports = ports;
    }
    /**
     * Claims the file for the admission of `id`: the text it wrote, which {@link release} takes, while this admission
     * holds it; undefined while another live admission does. A dead claim is removed while its text is unchanged, and
     * the file claimed again.
     */
    async claim(id) {
        const { files, clock, pid } = this.ports;
        const claim = { ticket: id, pid, expiresAt: new Date(clock.now() + ADMIT_TTL_MS).toISOString() };
        const text = JSON.stringify(claim);
        for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
            if (await files.createExclusive(this.path, text)) {
                return text;
            }
            const seen = await files.read(this.path);
            if (seen !== undefined) {
                const other = parseClaim(seen);
                if (other !== undefined && this.isLive(other)) {
                    return undefined;
                }
                await this.removeWhile(seen);
            }
        }
        return undefined;
    }
    /** Releases the claim written as `text`; one another admission wrote since (once this one ran out) stays. */
    async release(text) {
        await this.removeWhile(text);
    }
    isLive(claim) {
        return Date.parse(claim.expiresAt) > this.ports.clock.now() && this.ports.alive(claim.pid);
    }
    async removeWhile(text) {
        const { files } = this.ports;
        if ((await files.read(this.path)) === text) {
            await files.remove(this.path);
        }
    }
}
