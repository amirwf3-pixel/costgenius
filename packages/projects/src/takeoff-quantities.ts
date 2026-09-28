/**
 * The calc-engine integration adapter (D-015) — the smallest possible boundary between
 * the pure S1 quantity engine (`@costgenius/calc-engine`, frozen CG-RCS@0.1.0) and the
 * estimate workflow.
 *
 * Owner decisions (D-015, 2026-09): wire the FROZEN generic `calculateQuantities` for
 * single-line dimensional items (units m/m2/m3/each only); quantities stay EXACT (this
 * layer never constructs a rounding policy); deductions are engine-canonical (the sign
 * comes only from `kind`, factors are non-negative, item net ≥ 0); the provenance —
 * input, output and both engine versions — persists on the BOQ line's trace so any
 * persisted/finalized quantity can be replayed later.
 *
 * This adapter performs NO arithmetic, NO rounding, NO unit conversion and NO validation
 * of its own: everything is delegated to the engine, and its result is mapped
 * mechanically — `QuantityItemResult.qty` (the engine's canonical exact decimal) becomes
 * the line quantity verbatim. Engine error codes pass through unchanged for the API
 * boundary to translate (engine codes are never public — D-015/D5-A).
 */
import {
  calculateQuantities,
  type CalculationError,
  type QuantityCalculationInput,
} from '@costgenius/calc-engine';
import type { TakeoffProvenance } from '@costgenius/boq';

// The persisted provenance contract is owned by boq (the frozen line shape); re-exported
// here so callers of the adapter see one canonical type.
export type { TakeoffProvenance } from '@costgenius/boq';

/** The dimensional factors of one single-line takeoff item (the wire/UI shape). */
export interface TakeoffFactors {
  /** Stable item identity; becomes the engine's itemKey (the API uses the lineId). */
  readonly itemKey: string;
  /** Engine-canonical deduction semantics: the sign comes ONLY from the kind. */
  readonly kind: 'addition' | 'deduction';
  /** S1 quantity unit (m, m2, m3 or each); never converted. */
  readonly unit: string;
  /** Integer ≥ 0, as an exact decimal string. */
  readonly count: string;
  readonly length?: string;
  readonly width?: string;
  readonly height?: string;
}

/**
 * Builds the frozen engine input for single-line items. Mechanical shape mapping only —
 * no defaults: optional dimensions are carried exactly when present, exactly as supplied
 * (a missing dimension stays absent; the engine's R1 rules decide what is required).
 */
export function takeoffInputOf(factors: readonly TakeoffFactors[]): QuantityCalculationInput {
  return {
    items: factors.map((f) => ({
      itemKey: f.itemKey,
      unit: f.unit,
      lines: [
        {
          lineKey: f.itemKey,
          kind: f.kind,
          unit: f.unit,
          count: f.count,
          ...(f.length !== undefined ? { length: f.length } : {}),
          ...(f.width !== undefined ? { width: f.width } : {}),
          ...(f.height !== undefined ? { height: f.height } : {}),
        },
      ],
    })),
  };
}

/** One computed dimensional quantity, ready to become a BOQ line's quantity. */
export interface TakeoffQuantity {
  /** The caller's itemKey (the API layer uses the lineId). */
  readonly lineId: string;
  /** The engine's canonical exact decimal — verbatim, never reformatted. */
  readonly quantity: string;
  readonly unit: string;
  readonly takeoff: TakeoffProvenance;
}

export type TakeoffQuantitiesResult =
  | {
      readonly ok: true;
      readonly specVersion: string;
      readonly engineVersion: string;
      readonly items: readonly TakeoffQuantity[];
    }
  | { readonly ok: false; readonly errors: readonly CalculationError[] };

/**
 * Computes dimensional quantities through the frozen engine. Pure and deterministic
 * (same input ⇒ same result); atomic like the engine: any error yields `ok: false`
 * with every engine error and no items.
 */
export function computeTakeoffQuantities(input: QuantityCalculationInput): TakeoffQuantitiesResult {
  const result = calculateQuantities(input);
  if (result.status === 'error') {
    return { ok: false, errors: result.errors };
  }
  const inputsByKey = new Map(input.items.map((item) => [item.itemKey, item] as const));
  return {
    ok: true,
    specVersion: result.specVersion,
    engineVersion: result.engineVersion,
    items: result.items.map((item) => {
      const original = inputsByKey.get(item.itemKey);
      if (original === undefined) {
        // Unreachable: the engine echoes the caller's itemKeys, and duplicates already
        // failed atomically above.
        throw new Error(`the engine returned an unknown itemKey "${item.itemKey}"`);
      }
      return {
        lineId: item.itemKey,
        quantity: item.qty,
        unit: item.unit,
        takeoff: {
          input: original,
          output: item,
          specVersion: result.specVersion,
          engineVersion: result.engineVersion,
        },
      };
    }),
  };
}
