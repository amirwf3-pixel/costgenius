# @costgenius/calc-engine

Pure, deterministic calculation engine (ARCHITECTURE.md §4.1). Conforms to `CG-RCS@0.1.0`.

**Implemented:** the S1 quantity stage `calculateQuantities(input) → result + trace` (CG-RCS §4, §5, §7, §8; frozen)
and its D-016 sibling `calculateTakeoff(input) → TakeoffResult` — Full Takeoff documents: sheets, references,
expressions, floorCount/similarCount, explicit rounding (line / reference-term / item-total / sheet-total),
item/sheet totals from exact values, and traces (CG-IR-MEAS@0.2.0 §4–§8).
**Not implemented:** S2 item mapping, S3 pricing, S4 estimation, and every Full Takeoff product concern
(persistence, API, BOQ transfer, reporting — CG-FT-TAKEOFF-SPEC).

```ts
import { calculateQuantities, calculateTakeoff, canonicalJson } from '@costgenius/calc-engine';
const quantities = calculateQuantities({ items: [/* QuantityItemInput */] });
const takeoff = calculateTakeoff({
  sheets: [/* TakeoffSheetInput */],
  rounding: [/* RoundingRuleEntry */],
});
```

- Depends only on `@costgenius/domain` (exact decimals via `Qty`). No I/O, clock, randomness, floats or `eval`.
- Results are deeply frozen and stamped with `specVersion` and `engineVersion`.
- The CG-RCS spec is in [`spec/REFERENCE_CALCULATION_SPEC.md`](spec/REFERENCE_CALCULATION_SPEC.md) with reference cases in
  [`spec/reference-cases/quantity.v0.1.0.json`](spec/reference-cases/quantity.v0.1.0.json); the takeoff engine contract is
  [`spec/CG-IR-MEASUREMENT-SPEC@0.2.0.md`](spec/CG-IR-MEASUREMENT-SPEC@0.2.0.md) with cases in
  [`spec/ir-measurement-cases/`](spec/ir-measurement-cases/) (both versions; the 0.1.0 set stays normative under 0.2.0).
- Tests: `engine-reference.test.ts` runs all reference cases through the engine. `engine-contract.test.ts` covers
  the public contract. `reference-cases.test.ts` validates the spec data against `reference-oracle.ts`, which is
  test-only; lint blocks production code from importing it.
