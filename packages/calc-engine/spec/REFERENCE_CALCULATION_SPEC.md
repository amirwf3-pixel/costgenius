# CostGenius Reference Calculation Specification

| Field                  | Value                                                                          |
| ---------------------- | ------------------------------------------------------------------------------ |
| Spec ID                | `CG-RCS`                                                                       |
| Version                | `0.1.0`                                                                        |
| Status                 | Draft (Phase 1: specification only)                                            |
| Scope                  | Generic geometric quantity takeoff for building works (ابنیه)                  |
| Machine-readable cases | [`reference-cases/quantity.v0.1.0.json`](reference-cases/quantity.v0.1.0.json) |

This document is **implementation-independent**. Any engine that claims conformance to `CG-RCS@0.1.0`
must reproduce every reference case exactly. It relies on no Iranian regulation, coefficient,
price-book item or price. Where such a source will be needed later, it is listed in §9 and left unspecified.

## 1. Versioning

- Semantic versioning. **MAJOR**: a reference case's expected output changes, or a contract changes incompatibly.
  **MINOR**: new cases or new optional fields. **PATCH**: editorial changes only.
- Every calculation result records `specVersion` and `engineVersion`. A locked estimate is re-rendered with the
  spec/engine versions it was locked with (D-003, D-005).
- Reference cases are immutable once released. A correction is a new case ID, and the old case is marked `superseded`.

## 2. Separation of calculation stages

A number moves through four stages. Each stage has its own inputs, outputs and trace. A stage never reaches back
into an earlier stage's inputs.

| Stage               | Input                                                                | Output                                                 | Authoritative source needed              | In this version    |
| ------------------- | -------------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------- | ------------------ |
| **S1 Quantity**     | measurement lines (dimensions, counts, kind)                         | `Qty` per line and per takeoff item                    | No. Pure geometry/arithmetic             | **Specified**      |
| **S2 Item mapping** | takeoff item + published price-book edition                          | link `takeoffItem → priceBookItemId` (human-confirmed) | Yes: official edition                    | Contract only (§6) |
| **S3 Pricing**      | mapped quantity + resolved unit price (official / market / override) | line amount (`Money`)                                  | Yes: edition prices, market observations | Contract only (§6) |
| **S4 Estimation**   | priced lines + coefficient set + rounding policy                     | chapter subtotals, totals                              | Yes: coefficient rules per edition       | Contract only (§6) |

## 3. Numeric model (applies to all stages)

1. All values are **exact decimals**, exchanged as canonical strings matching `^-?\d+(\.\d+)?$`: no exponent,
   no thousands separators, no Persian/Arabic-Indic digits (digit localisation is presentation only).
2. Canonical output form: no trailing fractional zeros, no trailing `.`, and never `-0`. For example, `11.220` is written `11.22`, and `0.000` is written `0`.
3. Addition, subtraction and multiplication are exact. Division is not used in S1.
4. **No implicit rounding.** Rounding happens only where a `RoundingPolicy` explicitly asks for it (§5).
5. Binary floating point must never be used for intermediate values.

## 4. S1 Quantity calculation contract

### 4.1 Input

```
QuantityItemInput {
  itemKey: string                 // stable caller key, unique within a calculation
  unit: "m" | "m2" | "m3" | "each"   // S1 units (subset of domain UnitCode)
  rounding?: RoundingPolicy       // absent ⇒ no rounding
  lines: QuantityLineInput[]      // ≥ 1, order is significant for the trace only
}
QuantityLineInput {
  lineKey: string                 // unique within the item
  kind: "addition" | "deduction"
  unit: UnitCode                  // declared unit of this line
  count: DecimalString            // integer ≥ 0 (see Q-2)
  length?: DecimalString          // metres, ≥ 0
  width?:  DecimalString          // metres, ≥ 0
  height?: DecimalString          // metres, ≥ 0 (also used for depth/thickness)
  location?: string               // free-text location reference (zone/floor/axis). Not interpreted
  note?: string                   // not interpreted
}
```

### 4.2 Rules

- **R1 Dimensionality.** The number of dimensions provided must match the line unit:
  `each` → 0, `m` → 1 (`length`), `m2` → 2 (`length`, `width`), `m3` → 3 (`length`, `width`, `height`).
  Otherwise the line fails with `DIMENSION_UNIT_MISMATCH`. Dimensions are not inferred, padded or reordered.
- **R2 Line quantity.** `lineQty = count × Π(provided dimensions)`, computed exactly.
- **R3 Sign.** `signedQty = lineQty` for `addition` and `−lineQty` for `deduction`. All inputs must be ≥ 0. A negative
  input fails with `NEGATIVE_INPUT`, because deductions are expressed only through `kind`.
- **R4 Unit agreement.** Each line's `unit` must equal the item's `unit`. Otherwise the calculation fails with
  `UNIT_MISMATCH`. There is no unit conversion.
- **R5 Item total.** `itemQty = Σ signedQty` over all lines, exact and independent of line order.
- **R6 Negative net.** If `itemQty < 0`, the calculation fails with `NEGATIVE_NET_QUANTITY`. A zero net is valid.
- **R7 Zero.** Zero counts or dimensions are valid. The line stays in the result and in the trace with quantity `0`.
- **R8 Atomicity.** If any validation fails, no partial result is returned. Errors list _every_ failing line
  (not just the first), ordered by input order.
- **R9 Determinism.** Identical input (after canonicalising decimals) must produce a byte-identical canonical result.
  Permuting lines must not change `itemQty`. It changes only the trace order, which follows input order.

### 4.3 Error codes

`INVALID_DECIMAL`, `NEGATIVE_INPUT`, `NON_INTEGER_COUNT`, `DIMENSION_UNIT_MISMATCH`, `UNIT_MISMATCH`,
`NEGATIVE_NET_QUANTITY`, `EMPTY_ITEM`, `DUPLICATE_KEY`, `INVALID_ROUNDING_POLICY`.
Each error = `{ code, itemKey, lineKey?, field?, message }`.

## 5. Rounding policy

```
RoundingPolicy {
  stage: "line" | "item"          // where rounding is applied
  scale: integer 0..20            // fractional digits
  mode: "HALF_UP" | "HALF_EVEN" | "DOWN" | "UP" | "FLOOR" | "CEIL"
}
```

- `stage: "line"`: each `lineQty` is rounded (applied to the magnitude, before the sign), then summed.
  The sum is not rounded again.
- `stage: "item"`: lines stay exact and only `itemQty` is rounded.
- `HALF_UP` rounds ties away from zero. `HALF_EVEN` rounds ties to the even digit. Modes follow the domain `RoundingMode`.
- The trace records both the exact and the rounded value at every point where rounding was applied.
- Which stage, scale and mode are correct for a given practice is **not** decided here (Q-1). The policy is always an explicit input.

## 6. Contracts for later stages (S2–S4). Structure only, no rules

- **S2 Item mapping**: `{ takeoffItemKey, priceBookEditionId, priceBookItemId, mappedBy, mappedAt, origin: "user" | "ai-accepted" }`.
  S2 requires `takeoffItem.unit` to equal the published item's unit (after the edition's unit-label mapping has been
  approved at import). A mismatch is rejected and never converted.
- **S3 Pricing**: `amount = itemQty × resolvedUnitPrice`, exact and unrounded unless a policy says otherwise. `resolvedUnitPrice` carries
  `{ source: "pricebook" | "market" | "override", sourceRef, value, unit, effectiveAt }`. An override keeps
  the original value and a mandatory reason (D-006).
- **S4 Estimation**: applying coefficients and rounding totals. Its rules come entirely from approved
  edition data (D-004). Nothing is specified until those sources are available (§9).

## 7. Result structure

```
QuantityCalculationResult {
  specVersion: "0.1.0"
  engineVersion: string
  status: "ok" | "error"
  items: QuantityItemResult[]     // empty when status = "error"
  errors: CalculationError[]      // empty when status = "ok"
}
QuantityItemResult {
  itemKey, unit,
  exactQty: DecimalString         // Σ signed exact line quantities
  roundedQty?: DecimalString      // present only if a rounding policy exists
  qty: DecimalString              // authoritative value = roundedQty ?? exactQty (for stage "line", Σ rounded lines)
  lines: QuantityLineResult[]     // same order as input
  trace: TraceNode
}
QuantityLineResult {
  lineKey, kind, unit,
  factors: { name: "count" | "length" | "width" | "height", value: DecimalString }[]  // input order: count, length, width, height
  exactQty: DecimalString         // unsigned
  roundedQty?: DecimalString      // unsigned, stage "line" only
  signedQty: DecimalString        // signed contribution to item
}
```

## 8. Calculation trace

The trace is a tree that can explain every output number back to its inputs.

```
TraceNode {
  op: "input" | "multiply" | "negate" | "sum" | "round"
  label: string                   // e.g. "item:wall-A", "line:L1", "count"
  value: DecimalString            // canonical output of this node
  unit?: UnitCode | null          // null for dimensionless (count)
  rule?: string                   // spec rule id applied, e.g. "R2", "R5", "RND"
  rounding?: RoundingPolicy       // op = "round" only
  inputs: TraceNode[]             // ordered; empty for op = "input"
  ref?: { itemKey: string, lineKey?: string, field?: string }
}
```

Trace requirements:

- **T1** Every numeric input appears as an `input` node with its `ref`.
- **T2** Each line produces a `multiply` node (rule `R2`). A deduction wraps it in `negate` (rule `R3`).
  With line-stage rounding, a `round` node sits between `multiply` and `negate`.
- **T3** Each item root is a `sum` node (rule `R5`) whose inputs are its lines in input order. With item-stage
  rounding, the root is a `round` node wrapping the `sum`.
- **T4** Re-evaluating the tree from its inputs reproduces every node value exactly (self-verifying trace).
- **T5** The trace is serialisable to canonical JSON (keys sorted, no whitespace), so it can be hashed for locking.

## 9. Calculations requiring authoritative Iranian sources (not specified)

None of the following may be implemented until the source is imported through the approved pipeline
(source → staging → validation → human approval → published edition) and verified by a domain expert.

| Topic                                                                                                                      | Required source                                                                    | Status                          |
| -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------- |
| Measurement conventions per item (e.g. when openings are deducted, overlap handling, measurement lines for walls/finishes) | Official price-book chapter notes (شرح فصل / مقدمه) for the relevant ابنیه edition | `requires-authoritative-source` |
| Unit label mapping (Persian unit labels → `UnitCode`)                                                                      | Official edition files                                                             | `requires-authoritative-source` |
| Rebar and steel weights (kg per metre for each diameter/section)                                                           | National standard / edition tables                                                 | `requires-authoritative-source` |
| Waste/overlap allowances                                                                                                   | Edition notes, or explicit contract terms                                          | `requires-authoritative-source` |
| Regional, height, working-condition and other coefficients                                                                 | Edition coefficient definitions                                                    | `requires-authoritative-source` |
| Overhead/profit (بالاسری) and total rounding rules                                                                         | Edition / governing instructions                                                   | `requires-authoritative-source` |
| Star items (اقلام ستاره‌دار) pricing analysis rules                                                                        | Edition / governing instructions                                                   | `requires-authoritative-source` |
| Quantity and total rounding practice                                                                                       | Domain expert and organisation policy                                              | `requires-domain-decision`      |

## 10. Reference case format

Each case in the JSON file has: `id`, `title`, `stage`, `category`, `input`, `expected` (either `result` or `errors`),
`formula`, `rounding` (policy or `null`), `traceRequirements`, `assumptions`, `source` (`{ status, reference }`,
where status ∈ `synthetic-generic` | `requires-authoritative-source` | `superseded`), and optional `repeat`
(a determinism check: the number of runs and the permutations that must give identical results).

All values are **synthetic**. None represents a real project, price, item code or regulation.
