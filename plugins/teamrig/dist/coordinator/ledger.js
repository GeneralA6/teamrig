import { formatUtcMinute } from "../core/time.js";
/** The ledger's file name in the coordinator's folder: one JSON record a line, appended. */
export const LEDGER_FILE = 'ledger.jsonl';
/** The people's ledger beside it: one line a deploy, appended. */
export const LEDGER_MD_FILE = 'ledger.md';
/** The first line of a ledger.md teamrig starts. */
export const LEDGER_MD_HEADER = '# Deploy ledger: one line a deploy: rolled at (UTC) | session | repo | range | what | kind | note';
function short(sha) {
    return sha.slice(0, 8);
}
/** The landed commits as the ledger names them: `<first>..<last>` by 8-character sha, or the one commit. */
export function rangeText(commits, fallback) {
    const first = commits[0];
    const last = commits[commits.length - 1];
    if (first === undefined || last === undefined) {
        return short(fallback);
    }
    return first === last ? short(first) : `${short(first)}..${short(last)}`;
}
/** Appends one record as one line, in one write. */
export async function appendHeavy(files, ledger, record) {
    await files.append(ledger, `${JSON.stringify(record)}\n`);
}
/** A deploy's ledger.md line, `- <rolled at> | session | repo | range | what | kind | note`; a `|` or line break in a field becomes `/`. */
export function ledgerLine(record) {
    const fields = [record.session, record.repo, record.range, record.what, record.kind, record.note].map((field) => field.replace(/[|\r\n]/g, '/'));
    return `- ${formatUtcMinute(new Date(record.rolledAt))} | ${fields.join(' | ')}`;
}
/** Appends a deploy to the JSON ledger and its line to ledger.md, starting a missing ledger.md with its header. */
export async function appendDeploy(files, places, record) {
    await files.append(places.ledger, `${JSON.stringify(record)}\n`);
    await files.createExclusive(places.ledgerMd, `${LEDGER_MD_HEADER}\n`);
    await files.append(places.ledgerMd, `${ledgerLine(record)}\n`);
}
