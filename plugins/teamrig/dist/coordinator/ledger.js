import { formatUtcMinute } from "../core/time.js";
/** The ledger's file name in the coordinator's folder: one JSON record a line, appended. */
export const LEDGER_FILE = 'ledger.jsonl';
/** The people's ledger beside it: one line a deploy, appended. */
export const LEDGER_MD_FILE = 'ledger.md';
/** The first line of a ledger.md teamrig starts. */
export const LEDGER_MD_HEADER = '# Deploy ledger: one line a deploy: rolled at (UTC) | session | repo | range | what | kind | note';
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
