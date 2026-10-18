/** The ledger's file name in the coordinator's folder: one JSON record a line, appended. */
export const LEDGER_FILE = 'ledger.jsonl';
/** Appends one record as one line, in one write. */
export async function appendHeavy(files, ledger, record) {
    await files.append(ledger, `${JSON.stringify(record)}\n`);
}
