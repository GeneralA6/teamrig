import { isRecord } from "../core/guards.js";
import { featuresOf } from "../features/registry.js";
/** The operating systems a live proof is made on. */
export const OSES = ['windows', 'linux', 'macos'];
export function isOs(value) {
    return OSES.some((os) => os === value);
}
const DAY = /^\d{4}-\d{2}-\d{2}$/;
function hasText(record, key) {
    const value = record[key];
    return typeof value === 'string' && value.trim() !== '';
}
export function isProofRef(value) {
    if (!isRecord(value)) {
        return false;
    }
    const date = value['date'];
    return isOs(value['os']) && hasText(value, 'toolVersion') && typeof date === 'string' && DAY.test(date) && hasText(value, 'evidence');
}
function proofsProblem(row) {
    const proofs = row['proofs'];
    return Array.isArray(proofs) && proofs.every(isProofRef) ? undefined : 'its proofs must be a list of { os, toolVersion, date, evidence }';
}
function partialProblem(row) {
    if (!hasText(row, 'missing')) {
        return 'a partial row says what is missing';
    }
    return hasText(row, 'notice') ? proofsProblem(row) : 'a partial row needs a notice';
}
/** What is wrong with one manifest row; undefined when it is a `Support`. */
export function supportProblem(value) {
    if (!isRecord(value)) {
        return 'it is not a support value';
    }
    switch (value['kind']) {
        case 'supported':
            return proofsProblem(value);
        case 'partial':
            return partialProblem(value);
        case 'unsupported':
            return hasText(value, 'notice') ? undefined : 'an unsupported row needs a notice';
        default:
            return 'its kind must be supported, partial or unsupported';
    }
}
export function isSupport(value) {
    return supportProblem(value) === undefined;
}
/**
 * What stops `value` from being the manifest of one side: a feature with no row, a row that is no `Support`, or
 * a row for an id the registry does not hold. Empty when it is one.
 */
export function manifestProblems(side, value) {
    if (!isRecord(value)) {
        return ['its manifest is not an object'];
    }
    const rows = featuresOf(side);
    const known = new Set(rows.map((row) => row.id));
    const inRows = rows.flatMap(({ id }) => {
        if (!Object.hasOwn(value, id)) {
            return [`its manifest has no row for ${id}`];
        }
        const problem = supportProblem(value[id]);
        return problem === undefined ? [] : [`${id}: ${problem}`];
    });
    const strays = Object.keys(value)
        .filter((id) => !known.has(id))
        .map((id) => `its manifest names ${id}, which is no ${side} feature`);
    return [...inRows, ...strays];
}
export function isManifest(side, value) {
    return manifestProblems(side, value).length === 0;
}
/** The operating systems a row has a live proof on, in the order of `OSES`; none for an unsupported row. */
export function provedOn(support) {
    if (support.kind === 'unsupported') {
        return [];
    }
    return OSES.filter((os) => support.proofs.some((proof) => proof.os === os));
}
