import { isRecord, type JsonRecord } from '../core/guards.ts';
import { resolvedNode } from './settings.ts';

/**
 * A setting's value less every key its schema does not name. `teamrig read` serves a value to a reader outside the
 * team's sessions, and a key nobody described carries a meaning nobody decided to serve: it is left out whatever
 * it holds, so what leaves the machine is what the schema's own text stands behind.
 *
 * `node` is the value's own schema node and `definitions` the schema's `$defs`. An object keeps a key its
 * `properties` name, or one its `additionalProperties` give a schema for (a map of the team's own names); an
 * `additionalProperties` of `true` describes nothing, so its keys go too. An array keeps every element, walked by
 * `items`. Where the schema offers shapes (`anyOf`), a key any of them names stays.
 */
export function namedOnly(value: unknown, node: JsonRecord, definitions: JsonRecord): unknown {
  return walked(value, candidatesOf([node], definitions), definitions);
}

function walked(value: unknown, nodes: readonly JsonRecord[], definitions: JsonRecord): unknown {
  if (Array.isArray(value)) {
    const items = candidatesOf(
      nodes.map((node) => node['items']),
      definitions,
    );
    return value.map((element: unknown) => walked(element, items, definitions));
  }
  if (!isRecord(value)) {
    return value;
  }
  const kept: [string, unknown][] = [];
  for (const [key, child] of Object.entries(value)) {
    const schemas = schemasFor(key, nodes);
    if (schemas !== undefined) {
      kept.push([key, walked(child, candidatesOf(schemas, definitions), definitions)]);
    }
  }
  // fromEntries defines each key as the object's own, so a key spelled `__proto__` stays data.
  return Object.fromEntries(kept);
}

/** The schemas the nodes give the key; undefined when none of them names it. */
function schemasFor(key: string, nodes: readonly JsonRecord[]): readonly unknown[] | undefined {
  const schemas: unknown[] = [];
  let named = false;
  for (const node of nodes) {
    const properties = node['properties'];
    // Own keys only: a key such as `constructor` is on every object, and no schema named it.
    if (isRecord(properties) && Object.hasOwn(properties, key)) {
      named = true;
      schemas.push(properties[key]);
      continue;
    }
    const others = node['additionalProperties'];
    if (isRecord(others)) {
      named = true;
      schemas.push(others);
    }
  }
  return named ? schemas : undefined;
}

/** Each schema with its `$ref` resolved, and with it every shape its `anyOf` offers. */
function candidatesOf(schemas: readonly unknown[], definitions: JsonRecord): readonly JsonRecord[] {
  const candidates: JsonRecord[] = [];
  // By the schema's own objects, so a definition whose `anyOf` leads back to itself is walked once.
  const seen = new Set<unknown>();
  const add = (schema: unknown): void => {
    const node = resolvedNode(schema, definitions);
    if (node === undefined || seen.has(schema)) {
      return;
    }
    seen.add(schema);
    candidates.push(node);
    const shapes = node['anyOf'];
    if (Array.isArray(shapes)) {
      shapes.forEach((shape: unknown) => add(shape));
    }
  };
  schemas.forEach(add);
  return candidates;
}
