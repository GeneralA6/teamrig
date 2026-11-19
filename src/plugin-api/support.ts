import { isRecord, type JsonRecord } from '../core/guards.ts';
import { featuresOf, type FeatureIdOf, type FeatureSide } from '../features/registry.ts';

/** The operating systems a live proof is made on. */
export const OSES = ['windows', 'linux', 'macos'] as const;
export type Os = (typeof OSES)[number];

export function isOs(value: unknown): value is Os {
  return OSES.some((os) => os === value);
}

/**
 * One live proof that a feature works: a run on a real install of the tool. The manifest row holding it names the
 * adapter and the feature, so the proof does not repeat them.
 */
export interface ProofRef {
  readonly os: Os;
  /** The version of the tool the proof ran on. */
  readonly toolVersion: string;
  /** The day it ran, `YYYY-MM-DD`. */
  readonly date: string;
  /** Where its record is kept. */
  readonly evidence: string;
}

/**
 * What an adapter says of one feature. A row counts as proved on an operating system only with a proof made
 * there; `partial` says what is missing, and `partial` and `unsupported` carry the notice a person reads.
 */
export type Support =
  | { readonly kind: 'supported'; readonly proofs: readonly ProofRef[] }
  | { readonly kind: 'partial'; readonly missing: string; readonly notice: string; readonly proofs: readonly ProofRef[] }
  | { readonly kind: 'unsupported'; readonly notice: string };

/** One adapter's answer for every feature of its side: an adapter missing a row does not compile. */
export type Manifest<Side extends FeatureSide> = { readonly [Id in FeatureIdOf<Side>]: Support };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

function hasText(record: JsonRecord, key: string): boolean {
  const value = record[key];
  return typeof value === 'string' && value.trim() !== '';
}

export function isProofRef(value: unknown): value is ProofRef {
  if (!isRecord(value)) {
    return false;
  }
  const date = value['date'];
  return isOs(value['os']) && hasText(value, 'toolVersion') && typeof date === 'string' && DAY.test(date) && hasText(value, 'evidence');
}

function proofsProblem(row: JsonRecord): string | undefined {
  const proofs: unknown = row['proofs'];
  return Array.isArray(proofs) && proofs.every(isProofRef) ? undefined : 'its proofs must be a list of { os, toolVersion, date, evidence }';
}

function partialProblem(row: JsonRecord): string | undefined {
  if (!hasText(row, 'missing')) {
    return 'a partial row says what is missing';
  }
  return hasText(row, 'notice') ? proofsProblem(row) : 'a partial row needs a notice';
}

/** What is wrong with one manifest row; undefined when it is a `Support`. */
export function supportProblem(value: unknown): string | undefined {
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

export function isSupport(value: unknown): value is Support {
  return supportProblem(value) === undefined;
}

/**
 * What stops `value` from being the manifest of one side: a feature with no row, a row that is no `Support`, or
 * a row for an id the registry does not hold. Empty when it is one.
 */
export function manifestProblems(side: FeatureSide, value: unknown): readonly string[] {
  if (!isRecord(value)) {
    return ['its manifest is not an object'];
  }
  const rows = featuresOf(side);
  const known = new Set<string>(rows.map((row) => row.id));
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

export function isManifest<Side extends FeatureSide>(side: Side, value: unknown): value is Manifest<Side> {
  return manifestProblems(side, value).length === 0;
}

/** The operating systems a row has a live proof on, in the order of `OSES`; none for an unsupported row. */
export function provedOn(support: Support): readonly Os[] {
  if (support.kind === 'unsupported') {
    return [];
  }
  return OSES.filter((os) => support.proofs.some((proof) => proof.os === os));
}
