import { DESIGN_LABEL_SPEC } from './design-label.ts';
import type { LabelNaming, LabelSpec } from './host.ts';
import { STATUS_LABEL_SPECS } from './status-push.ts';

/**
 * Every label teamrig makes in a repository that lacks it: the status push's five and the design label. github/gh.ts
 * allows the create of these and no other, word for word, so teamrig never makes a label the docs do not name.
 */
export const MANAGED_LABEL_SPECS: readonly LabelSpec[] = [...STATUS_LABEL_SPECS, DESIGN_LABEL_SPEC];

/** The spec teamrig makes `name` with, or undefined for a label teamrig does not manage. */
export function managedLabel(name: string): LabelSpec | undefined {
  return MANAGED_LABEL_SPECS.find((spec) => spec.name === name);
}

/**
 * The one of `specs` the tracker holds as `name`, under that name, or undefined when it holds none of them so.
 * `labelName` is the tracker's Labels.labelName: a label read from it, or named through it, is found by the name it
 * has there, and made under it.
 */
export function specHeldAs(specs: readonly LabelSpec[], name: string, labelName: LabelNaming): LabelSpec | undefined {
  const spec = specs.find((one) => labelName(one.name) === name);
  return spec === undefined ? undefined : { ...spec, name };
}

/** The colour every area label is made in (github.areaOwners): one look for every area, as the label file's areas. */
export const AREA_LABEL_COLOR = 'c5def5';

/** The description every area label is made with: what teamrig does with an issue that carries one. */
export const AREA_LABEL_DESCRIPTION = 'Area: teamrig gives an issue with this label to the session of its area';

/**
 * The spec teamrig makes the area label `name` with, one the team's github.areaOwners names that a repository lacks
 * (issues/write.ts): the one area look under that name, so a new area needs no colour or description picked.
 */
export function areaLabelSpec(name: string): LabelSpec {
  return { name, color: AREA_LABEL_COLOR, description: AREA_LABEL_DESCRIPTION };
}
