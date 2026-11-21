import { bind, runCases } from "./contract.js";
export function entryOf(contract) {
    return {
        port: contract.port,
        side: contract.side,
        features: [...new Set(contract.cases.flatMap((one) => one.features))],
        cases: contract.cases.map((one) => ({ id: one.id, features: one.features })),
        againstLiars: () => Promise.all(contract.liars.map((liar) => runCases(bind({ contract, make: liar }).cases))),
    };
}
const PORT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const WORDS = /^[a-z0-9]+(-[a-z0-9]+)*$/;
function repeated(values) {
    return [...new Set(values.filter((value, at) => values.indexOf(value) !== at))];
}
function isCaseId(port, id) {
    return id.startsWith(`${port}.`) && WORDS.test(id.slice(port.length + 1));
}
function shapeProblems(entry) {
    return [
        ...(PORT.test(entry.port) ? [] : [`${entry.port}: a port is lower-case words joined by -`]),
        ...(entry.cases.length === 0 ? [`${entry.port} has no case`] : []),
        ...entry.cases.filter((one) => !isCaseId(entry.port, one.id)).map((one) => `${one.id}: a case of ${entry.port} is named ${entry.port}.<lower-case words joined by ->`),
        ...repeated(entry.cases.map((one) => one.id)).map((id) => `${id} names two cases`),
        ...entry.cases.filter((one) => one.features.length === 0).map((one) => `${one.id} names no feature`),
    ];
}
/** The features a liar passes every case of: nothing in the contract tells that liar from a real adapter there. */
function passedBy(entry, results) {
    return entry.features.filter((feature) => !results.some((result) => result.features.includes(feature) && result.outcome.kind === 'failed'));
}
async function liarProblems(entry) {
    const runs = await entry.againstLiars();
    if (runs.length === 0) {
        return [`${entry.port} has no liar`];
    }
    return runs.flatMap((results, at) => passedBy(entry, results).map((feature) => `${entry.port}: liar ${at + 1} passes every case of ${feature}`));
}
/**
 * What is wrong with the kit's contracts; empty when each can hold an adapter to its word. A contract a liar passes
 * a feature of is incomplete: an adapter that says `supported` and does nothing would pass it too.
 */
export async function kitProblems(entries) {
    const perEntry = await Promise.all(entries.map(async (entry) => [...shapeProblems(entry), ...(await liarProblems(entry))]));
    return [...repeated(entries.map((entry) => entry.port)).map((port) => `${port} names two contracts`), ...perEntry.flat()];
}
