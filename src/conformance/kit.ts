import type { FeatureSide } from '../plugin-api/index.ts';
import type { ContractOutline } from './choice.ts';
import { bind, runCases, type CaseResult, type Contract } from './contract.ts';

/** One contract as the kit lists it, its port and world types closed over so one list holds every port's. */
export interface KitEntry extends ContractOutline {
  readonly cases: readonly { readonly id: string; readonly features: readonly string[] }[];
  /** Every case run against each liar of the contract: one list of results a liar, in the contract's order. */
  readonly againstLiars: () => Promise<readonly (readonly CaseResult[])[]>;
}

export function entryOf<Port, World, Side extends FeatureSide>(contract: Contract<Port, World, Side>): KitEntry {
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

function repeated(values: readonly string[]): readonly string[] {
  return [...new Set(values.filter((value, at) => values.indexOf(value) !== at))];
}

function isCaseId(port: string, id: string): boolean {
  return id.startsWith(`${port}.`) && WORDS.test(id.slice(port.length + 1));
}

function shapeProblems(entry: KitEntry): readonly string[] {
  return [
    ...(PORT.test(entry.port) ? [] : [`${entry.port}: a port is lower-case words joined by -`]),
    ...(entry.cases.length === 0 ? [`${entry.port} has no case`] : []),
    ...entry.cases.filter((one) => !isCaseId(entry.port, one.id)).map((one) => `${one.id}: a case of ${entry.port} is named ${entry.port}.<lower-case words joined by ->`),
    ...repeated(entry.cases.map((one) => one.id)).map((id) => `${id} names two cases`),
    ...entry.cases.filter((one) => one.features.length === 0).map((one) => `${one.id} names no feature`),
  ];
}

/** The features a liar passes every case of: nothing in the contract tells that liar from a real adapter there. */
function passedBy(entry: KitEntry, results: readonly CaseResult[]): readonly string[] {
  return entry.features.filter((feature) => !results.some((result) => result.features.includes(feature) && result.outcome.kind === 'failed'));
}

async function liarProblems(entry: KitEntry): Promise<readonly string[]> {
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
export async function kitProblems(entries: readonly KitEntry[]): Promise<readonly string[]> {
  const perEntry = await Promise.all(entries.map(async (entry) => [...shapeProblems(entry), ...(await liarProblems(entry))]));
  return [...repeated(entries.map((entry) => entry.port)).map((port) => `${port} names two contracts`), ...perEntry.flat()];
}
