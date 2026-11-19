import { featuresOf, type FeatureIdOf, type FeatureSide, type Manifest, type Support, type Toggle } from '../plugin-api/index.ts';

/** The toggles a team asks for, by feature id as its config writes them: an id the registry lacks is refused, not dropped. */
export type AskedToggles = Readonly<Record<string, Toggle>>;

/** Whether each feature of one side runs on an adapter, or every reason the asked toggles cannot hold on it. */
export type Toggles<Side extends FeatureSide> =
  | { readonly kind: 'resolved'; readonly toggles: ReadonlyMap<FeatureIdOf<Side>, Toggle> }
  | { readonly kind: 'refused'; readonly notices: readonly string[] };

/**
 * A supported feature runs unless the team turns it off. One supported in part runs as the team asks, else as its
 * registry row says. An unsupported one never runs.
 */
function toggleOf(support: Support, asked: Toggle | undefined, byDefault: Toggle): Toggle {
  switch (support.kind) {
    case 'supported':
      return asked ?? 'on';
    case 'partial':
      return asked ?? byDefault;
    case 'unsupported':
      return 'off';
  }
}

/**
 * The toggle of every feature of `side` on the adapter whose manifest this is. Asking `on` for a feature the
 * adapter does not support is refused with the manifest's notice, so a team never believes a guard runs that
 * cannot; so is an id that is no feature of the side.
 */
export function resolveToggles<Side extends FeatureSide>(side: Side, manifest: Manifest<Side>, asked: AskedToggles): Toggles<Side> {
  const rows = featuresOf(side);
  const known = new Set<string>(rows.map((row) => row.id));
  const strays = Object.keys(asked)
    .filter((id) => !known.has(id))
    .map((id) => `${id} is no ${side} feature`);
  const unsupported = rows.flatMap((row) => {
    const support: Support = manifest[row.id];
    return support.kind === 'unsupported' && asked[row.id] === 'on' ? [`${row.id} cannot be on: ${support.notice}`] : [];
  });
  const notices = [...strays, ...unsupported];
  if (notices.length > 0) {
    return { kind: 'refused', notices };
  }
  return { kind: 'resolved', toggles: new Map(rows.map((row): [FeatureIdOf<Side>, Toggle] => [row.id, toggleOf(manifest[row.id], asked[row.id], row.byDefault)])) };
}
