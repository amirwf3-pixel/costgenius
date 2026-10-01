# CG-IR-MEASUREMENT-SPEC@0.2.0: Iranian Building Takeoff (متره) Measurement Specification

| Field             | Value                                                                                                                                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Spec ID           | `CG-IR-MEAS`                                                                                                                                                                                                                                                                                     |
| Version           | `0.2.0`                                                                                                                                                                                                                                                                                          |
| Status            | The S1 engine contract for `calculateTakeoff`, **implemented** (D-016 Phase 1, 2026-09; engine version 0.2.0). Supersedes `0.1.0` (changelog below). The product wiring is implemented through D-016 Phase 6: persistence, lifecycle, API, Full Takeoff UI, BOQ transfer and PDF/Excel reporting |     |
| Scope             | Building works (ابنیه) takeoff lines, references and quantity expressions (stage S1)                                                                                                                                                                                                             |
| Builds on         | `CG-RCS@0.1.0` (unchanged; its engine behaviour is frozen)                                                                                                                                                                                                                                       |
| Supersedes        | `CG-IR-MEAS@0.1.0` — the 0.1.0 file is preserved as history; its normative content carries into 0.2.0 per the changelog below                                                                                                                                                                    |
| Product contracts | [`CG-FT-TAKEOFF-SPEC@0.1.0`](../../../projects/spec/CG-FT-TAKEOFF-SPEC@0.1.0.md) — lifecycle, persistence, draft mutation, BOQ transfer, reporting, provenance, API errors                                                                                                                       |
| Synthetic cases   | [`ir-measurement-cases/ir-measurement.v0.1.0.json`](ir-measurement-cases/ir-measurement.v0.1.0.json)                                                                                                                                                                                             |

## Changelog

### 0.2.0 (D-016 Phase 0, 2026-09)

1. **Status**: specification-only → implementation-ready (D-016; see DECISIONS.md).
2. **§5 — NEW V13** (aggregation unit homogeneity; error `AGGREGATION_UNIT_MISMATCH`):
   all lines sharing one `itemCode` must declare the same `unit`. Rationale (D-016
   G2/N2): `itemTotals` are keyed by `itemCode` with a single `unit`; incompatible units
   are a deterministic error — never silently converted, never split. Uncoded lines
   aggregate **per unit** under `null` (one `itemTotals` entry per `(null, unit)`,
   first-appearance order), refining 0.1.0's "aggregate under `null`" so no uncoded
   entry is ever ill-defined.
3. **§7.4 — normative** (resolves a 0.1.0 ambiguity; D-016 R1/N6): item and sheet totals
   aggregate the lines' EXACT values; a matching total rule then rounds once. Rounded
   line values never feed aggregation. No accumulate-rounded mode exists in 0.2.0.
4. **§8**: `qty` is defined explicitly as the effective value (`roundedQty` when present,
   otherwise `exactQty`).
5. **§6**: D-016 V1 authoring restriction recorded (the product authors only
   `sourceStatus: "design"` rules in V1; the engine enum is unchanged).
6. **Phase-1 clarifications** (2026-09, with the `calculateTakeoff` implementation): the §2
   `specVersion` literal is `0.2.0`; §8 `byItem` entries carry `unit`, `exactQty`, `roundedQty?`,
   `qty` and `lineIds` (provenance parity with `itemTotals`); §4.3's inline `rule` is the domain
   `RoundingRule {scale, mode}`; the engine consumes `sheets` + `rounding` only; and §6's
   "narrowest match wins" is formalized as selector scoring — `lineIds` membership 4,
   `itemCode` 2, `unit` 1, AND-combined, highest score applies, equal top scores are
   `INVALID_ROUNDING_POLICY`. A `reference-term` rule's selector picks the REFERENCING
   (consuming) line, and the matched rule rounds every term that line consumes (normative
   0.1.0 case IRM-006); a `lineIds` selector on `item-total`/`sheet-total` is invalid.

No 0.1.0 case, rule or behavior is invalidated; the `ir-measurement.v0.1.0.json` case
set remains normative under 0.2.0. V13/aggregation cases are added as
`ir-measurement-cases/ir-measurement.v0.2.0.json` together with the Phase 1 engine
implementation.

## 0. Source policy (normative)

1. The **generic mechanics** in this document (line structure, references, expressions, validation, rounding, trace)
   are CostGenius design decisions. They are _not_ Iranian rules, and they carry `sourceStatus: "design"`.
2. **Iranian-specific rules** (what to measure, what to deduct, measurement lines, units per item, rounding
   practice) may only enter as `MeasurementRule` records with a verified source reference (§9). **This version
   contains no implemented Iranian rule.** §9.1 records verified informational principles and §9.3 verified rules
   (`VERIFIED_SPEC_ONLY`, not implemented); every other
   placeholder is `sourceStatus: "unverified"`.
3. The legacy sample takeoff workbook reviewed with the product owner is a **workflow/structure benchmark only**.
   It is based on an older price-book edition and is **not** a source for any 1404 rule, unit, price or coefficient.
   No value from it is reproduced here. In particular, prices from the sample 1385 workbook are never 1404 data.
4. Quantities are never produced or completed by AI (D-008). AI may propose lines, and each one needs human acceptance.

## 1. Separation of concerns (normative)

```
Takeoff Quantity (S1, this spec) → Item Master (S2) → Price Book (S3) → Raw Amount (S3)
  → Estimate / Coefficients (S4) → Final Estimate (S4)
```

- A takeoff line may carry an `itemCode`, but only as an **opaque reference**. S1 never looks up, validates or
  prices it. Checking the code against a published edition and its unit is an S2 concern (see the price-book spec).
- S1 must not read prices, coefficients (floor, regional or other), overhead items or site-setup items.
- The generic engine (`calculateQuantities`, CG-RCS) stays unchanged. This spec defines an **additional** S1
  contract (`calculateTakeoff`, §8) that D-016 implements beside it. The product
  contracts (lifecycle, persistence, transfer, reporting, API errors) live in
  `CG-FT-TAKEOFF-SPEC@0.1.0` (`packages/projects/spec/`).

## 2. Domain objects

```
TakeoffDocument {
  documentId, projectRef, title
  sheets: TakeoffSheet[]                 // e.g. one per trade / building part. Order is presentation only
  rounding: RoundingRuleSet              // explicit (§6). May be empty
  specVersion: "0.2.0"
}
TakeoffSheet {
  sheetId: string                        // stable, unique in document (not the display name)
  name: string                           // display name, e.g. a Persian sheet title
  lines: TakeoffLine[]
}
TakeoffLine {
  lineId: string                         // stable, unique in DOCUMENT; references use this (never row numbers)
  rowNo: integer ≥ 1                     // display row number (ردیف); unique within the sheet; may be renumbered
  description: string                    // شرح
  location?: string                      // محل / axis / floor label; free text in 0.1.0
  itemCode?: string | null               // opaque price-book/Item Master code; not interpreted in S1
  kind: "addition" | "deduction"         // اضافه / کسر
  unit: UnitCode                         // declared unit of the line result
  quantity: QuantityExpression           // §4
  notes?: string                         // توضیحات
  origin: "user" | "import" | "ai-accepted"
  ruleRefs?: MeasurementRuleId[]         // Iranian rules the estimator claims to apply (§9); advisory in 0.1.0
}
```

### 2.1 Count factors: `floorCount` and `similarCount` are distinct (normative)

The benchmark workflow shows two separate multipliers:

- `similarCount` (تعداد مشابه): how many identical elements occur within one repetition unit.
- `floorCount` (تعداد طبقات): how many times the repetition unit repeats over floors.

Both are integers ≥ 1 when present. **An absent factor means 1 and is recorded as absent in the trace, not as `1`.** They are
never merged into one `count` field, because reports and audits show them in separate columns.
Whether a floor coefficient (price adjustment) applies is an S4 matter and is unrelated to `floorCount`.

## 3. Units and dimensions

- `UnitCode` comes from `@costgenius/domain`. The dimension **profile** is declared explicitly on the dimensional
  expression (§4.1); it is not inferred from the unit, because real items (e.g. kg or a lump sum) do not follow L×W×H.
- The mapping between an Iranian price-book unit label (e.g. متر مربع, کیلوگرم) and a `UnitCode` is defined per edition by the
  price-book spec (§6 there), **not** here.
- There is no implicit unit conversion. A mixed-unit combination is an error (`UNIT_MISMATCH`).

## 4. Quantity expressions (deterministic, no `eval`)

`QuantityExpression` is a closed, typed tree. Text formulas (e.g. imported Excel formulas) must be parsed at the edge
into this tree, and anything unparseable is rejected. The engine never evaluates strings.

### 4.1 `dimensional`

```
{ type: "dimensional",
  profile: "L" | "LW" | "LWH" | "count",
  similarCount?: DecimalString, floorCount?: DecimalString,
  length?: DecimalString, width?: DecimalString, height?: DecimalString }
```

`value = floorCount × similarCount × Π(profile dimensions)`. The dimensions present must equal the profile exactly.
All inputs must be ≥ 0, and the sign comes only from `kind`. `profile: "count"` means `value = floorCount × similarCount`.

### 4.2 `reference`

```
{ type: "reference", terms: { lineId: string, factor: DecimalString, use: "signed" | "magnitude" }[] }
```

`value = Σ factor_i × ref_i`, where `ref_i` is the referenced line's **resolved** value (signed, or its magnitude). This covers
"same as row X", "row X + row Y", and deduction lines that reuse another line's quantity. A negative `factor` is allowed (e.g. "row X − row Y"),
but the resolved magnitude must stay ≥ 0 (§5 V9); a deduction is expressed only by `kind`. Cross-sheet references
are allowed because `lineId` is document-unique.

### 4.3 `expression`

A restricted arithmetic tree for layouts that are not rectangular:

```
Node = { op: "const", value: DecimalString }
     | { op: "ref", lineId, use: "signed" | "magnitude" }
     | { op: "add" | "mul", args: Node[] (≥2) }
     | { op: "sub", args: [Node, Node] }
     | { op: "round", arg: Node, rule: RoundingRule }     // explicit, auditable; `RoundingRule` is the domain `{scale, mode}` (§6 target/selector semantics do not apply inline)
```

- Division, powers, trigonometry and functions such as π are **not** in 0.1.0 (Q-IR-4). Adding them requires a spec version bump
  and defined exactness/precision rules.
- `const` values are plain decimal strings, and the dimension semantics are the author's responsibility. The line `unit` is declared,
  and the engine only checks that referenced lines share that unit. A mixed-unit tree is rejected unless every referenced line has the
  line's unit (0.1.0 does no dimensional analysis on constants).

### 4.4 `manual`

`{ type: "manual", value: DecimalString, justification: string }`: a directly entered quantity with a mandatory
justification. It is audited like an override.

## 5. Validation (all errors collected in input order; atomic, no partial result)

| ID  | Rule                                                                                                        | Error code                                                        |
| --- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| V1  | `lineId` unique in document; `sheetId` unique; `rowNo` unique in sheet                                      | `DUPLICATE_KEY`                                                   |
| V2  | Decimal strings match `^-?\d+(\.\d+)?$`; `floorCount`/`similarCount` integers ≥ 1                           | `INVALID_DECIMAL`, `NON_INTEGER_COUNT`                            |
| V3  | Dimensional inputs ≥ 0                                                                                      | `NEGATIVE_INPUT`                                                  |
| V4  | Dimensions present = profile                                                                                | `DIMENSION_PROFILE_MISMATCH`                                      |
| V5  | Referenced `lineId` exists                                                                                  | `UNKNOWN_REFERENCE`                                               |
| V6  | Reference graph is acyclic (self-reference included)                                                        | `CIRCULAR_REFERENCE` (lists the cycle, lexicographically rotated) |
| V7  | Referenced line unit = referencing line unit                                                                | `UNIT_MISMATCH`                                                   |
| V8  | `manual` has a non-empty justification                                                                      | `MISSING_JUSTIFICATION`                                           |
| V9  | Resolved line magnitude ≥ 0 before `kind` is applied (a deduction is expressed only by `kind`)              | `NEGATIVE_LINE_MAGNITUDE`                                         |
| V10 | Rounding rules valid (scale 0..20, known mode, known target)                                                | `INVALID_ROUNDING_POLICY`                                         |
| V11 | Per-`itemCode` net total checked on the **exact** value ≥ 0 (same principle as CG-RCS R6 after Phase 2 fix) | `NEGATIVE_NET_QUANTITY`                                           |
| V12 | `itemCode` is **not** validated in S1                                                                       | (S2: `UNKNOWN_ITEM_CODE`, `ITEM_UNIT_MISMATCH`)                   |
| V13 | All lines sharing one `itemCode` declare the same `unit` (aggregation homogeneity)                          | `AGGREGATION_UNIT_MISMATCH`                                       |

V13 is aggregation-scoped: it protects the single `unit` of each `itemTotals` entry.
Coded groups are never split — the same `itemCode` with two units is always an error.
Lines without an `itemCode` never merge across units: they aggregate per unit under
`null` (one entry per `(null, unit)`, first-appearance order), so an uncoded `m` line and
an uncoded `kg` line never combine and never error. There is no unit conversion (§3).

## 6. Rounding: always explicit, never universal (normative)

The benchmark workbook rounds some formulas and not others, so **no default rounding exists**.

```
RoundingRuleSet = RoundingRuleEntry[]
RoundingRuleEntry {
  target: "line" | "reference-term" | "item-total" | "sheet-total"
  selector?: { itemCode?: string, unit?: UnitCode, lineIds?: string[] }  // narrowest match wins; ties = error
  scale: 0..20, mode: RoundingMode
  sourceStatus: "design" | "organization-policy" | "verified" | "unverified"
  source?: SourceRef                                                     // required when sourceStatus = "verified"
}
```

- Rounding is applied at the declared target only. **References consume the referenced line's exact value** unless a
  `reference-term` rule explicitly rounds it — such a rule's selector picks the referencing (consuming) line, and it
  rounds each term that line consumes (IRM-006). The trace records exact and rounded values.
- Negative checks (V9, V11) always use exact values, before any rounding.
- Which rules match Iranian practice or a given organisation's practice is unresolved (Q-1, Q-IR-5).
- D-016 V1 (R3): the product authors only `sourceStatus: "design"` rules; the other enum
  values stay reserved for future, separately sourced policies. The engine validates the
  full enum exactly as in 0.1.0.

## 7. Resolution order and determinism

1. Validate everything (§5).
2. Topologically sort lines by reference, breaking ties by `(sheet order, rowNo, lineId)`.
3. Evaluate each line exactly, apply `line` rounding if a rule matches, then apply the sign from `kind`.
4. Aggregate per `itemCode` (lines without a code aggregate per unit under `null`) and per
   sheet — **always from the lines' exact values**: `itemTotal.exactQty = Σ exactValue(line)`
   (signed). If an `item-total` rule matches the group, `itemTotal.roundedQty =
round(exactQty)` — exactly one rounding, applied at the target; sheet totals follow the
   same rule from their lines' exact values. Rounded line values (the output of a `line`
   rule) are NEVER aggregation inputs: no accumulate-rounded mode exists in 0.2.0, and the
   D-016 V1 phrase "unless a rule says otherwise" introduces no behavior.
5. Identical canonical input gives a byte-identical canonical result. Renumbering `rowNo` or reordering sheets does not change any value.

## 8. Result and trace contract

```
TakeoffResult {
  specId: "CG-IR-MEAS", specVersion, engineVersion, status, errors[]
  lines: { lineId, sheetId, rowNo, itemCode, unit, kind,
           exactMagnitude, roundedMagnitude?, signedValue, trace: TraceNode }[]
  itemTotals: { itemCode: string | null, unit, exactQty, roundedQty?, qty, lineIds[] }[]
  sheetTotals: { sheetId, byItem: { itemCode: string | null, unit, exactQty, roundedQty?, qty, lineIds[] }[] }[]
}

The engine input is the document's computational content — `sheets` plus the document-level
`rounding` rule set; document metadata (`documentId`, `projectRef`, `title`) is a product-layer
concern (CG-FT-TAKEOFF-SPEC) and not an engine input. Each `byItem` entry carries the exact
subtotal, the rounded subtotal when a `sheet-total` rule matched, and its contributing `lineIds`.
```

- `TraceNode` extends CG-RCS §8 with the ops `ref` (label `ref:<lineId>`, with the input being the referenced line's trace root,
  shared by id rather than duplicated: `{ op: "ref", lineId, value }`), `sub`, `const`, `manual`, and factor labels
  `floorCount` and `similarCount`.
- Every node carries `ruleId` (e.g. `IR-MEAS/V9`, `IR-MEAS/4.1`). A `round` node produced by a §6
  rule-set entry carries the full entry (`roundingRule`) for provenance, beside the `{scale, mode}`
  instruction; a line that claims `ruleRefs` echoes them on its root node (`measurementRuleIds`).
- Traces are self-verifying (T4), and canonical JSON is hashable (T5).
- `qty` is the effective value: `roundedQty` when a rule produced one, otherwise
  `exactQty`. Downstream consumers (BOQ transfer — CG-FT-TAKEOFF §8) consume `qty` and
  never round again.

## 9. Iranian measurement rules registry

```
MeasurementRule {
  id: string                    // e.g. "IR-ABNIYE-1404/<chapter>/<n>"; assigned at import
  title, text                   // verbatim or faithful paraphrase of the source
  appliesTo: { chapter?: string, itemCodes?: string[] }
  effect: "informational" | "validation" | "expression-template"
  sourceStatus: "unverified" | "verified" | "superseded"
  source: SourceRef
  verifiedBy?: userId, verifiedAt?: Instant
}
SourceRef { sourceDocument: string | null, edition: string | null,
            page: string | null, section: string | null, sourceFileHash?: string }
```

A rule with `sourceStatus ≠ "verified"` must never change a number. At most it can show a note.

### 9.1 Verified informational principles (effect: `informational`; they change no number)

> Pages are printed page numbers of the official 1404 document, verified manually by the product owner (see price-book spec §3.2).

| ID                   | Principle                                                                                                                              | sourceDocument                           | edition | page | section                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ------- | ---- | ------------------------------- |
| IR-ABNIYE-1404/AI/F2 | For cost estimation, quantities are calculated from drawings and technical specifications                                              | فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴ | 1404    | 2    | clause 2-8                      |
| IR-ABNIYE-1404/GR/F7 | Measurement is based on dimensions shown in drawings/execution documents, subject to the general requirements and chapter requirements | فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴ | 1404    | 5    | General Requirements, clause 14 |

Consequence for this spec: every `TakeoffLine` should be traceable to its drawing/execution document (`location`,
`notes`, and a future `drawingRef`). General and chapter requirements can override plain dimensions, but their content is
unverified (§9.2), so the engine applies none of them. The takeoff row's item number, description, unit and quantity
correspond to the verified estimate/BOQ row (price-book spec §3.2 F3). Unit price and amount are **not** takeoff fields.

### 9.2 Candidate rule areas that need verification before they have any effect:

| Area                                                                                                                           | sourceDocument                           | edition | page | section | Status     |
| ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------- | ---- | ------- | ---------- |
| Chapter requirements affecting measurement, incl. opening rules of chapters other than Chapter 8 (see §9.3)                    | فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴ | 1404    | null | null    | unverified |
| General requirements affecting measurement (content beyond §9.1)                                                               | same                                     | 1404    | null | null    | unverified |
| Units per item                                                                                                                 | same (item tables)                       | 1404    | null | null    | unverified |
| Reinforcement/steel weight: tolerance value in the standard tables (not printed in the price list; rule is IR-1404-M-REBAR-01) | same                                     | null    | null | null    | unverified |
| Waste/overlap allowances                                                                                                       | null                                     | null    | null | null    | unverified |
| Rounding practice (not stated in the verified facts)                                                                           | null (organisation/expert)               | null    | null | null    | unverified |

### 9.3 Verified Iranian Rules — 1404 (measurement)

Rule statements are the product owner's verified summaries of the official text. A verbatim Persian transcription is still
pending for every rule (column "unverified parts"). `VERIFIED_SPEC_ONLY` means the rule is recorded and sourced but **not
implemented**: it changes no number in any engine until a later phase implements it with its own reference cases.
Where OCR or the summary leaves a numeric value (threshold, tolerance, weighting, rounding digit) uncertain, only that
part is marked unverified; no value is guessed. Sample-workbook values are never used as 1404 rules.

| ruleId             | sourceDocument                           | edition | printedPage | clause/group                                                                        | rule statement                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | applicability                                                                                                         | unverified parts                                                                                                                                                                                                            | implementationStatus |
| ------------------ | ---------------------------------------- | ------- | ----------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- |
| IR-1404-M-REBAR-01 | فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴ | 1404    | 56          | Chapter 7 (کارهای فولادی با میلگرد), General Requirements (الزامات عمومی), clause 2 | For rows whose unit of measurement is by weight, the work weight is calculated from the dimensions in the drawings or instructions, using standard tables or the manufacturer's tables. If the calculated theoretical unit weight differs from the unit weight weighed on site, the weighed unit weight (وزن واحد توزین شده) is the basis, provided it is not more than the calculated theoretical unit weight taking into account the maximum tolerance of the standard tables (حداکثر رواداری جدول‌های استاندارد). The clause is a quantity-measurement rule; it prints no tolerance number and does not mention wastage or lap/splice. | Chapter 7 rows measured by weight only                                                                                | Tolerance value: not printed in the 1404 price list; it is whatever the standard tables specify (external, unverified); verbatim text                                                                                       | VERIFIED_SPEC_ONLY   |
| IR-1404-M-CONC-01  | فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴ | 1404    | 61          | Chapter 8, General Requirements, clause 4                                           | The concrete rules state that execution losses and handling are included (not measured separately), as stated in the clause.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Chapter 8 concrete items only; not generalised to other chapters                                                      | Exact scope of the included losses/handling; verbatim text                                                                                                                                                                  | VERIFIED_SPEC_ONLY   |
| IR-1404-M-CONC-02  | فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴ | 1404    | 61          | Chapter 8 (بتن درجا), General Requirements (الزامات عمومی), clause 6                | The volume of voids formed in concrete (حجم حفره‌های تعبیه شده در بتن), each of which is 0.05 cubic metre (مترمکعب) or less, is not deducted from the concrete volume in measurement. Threshold: 0.05 m³ per individual void, inclusive (≤).                                                                                                                                                                                                                                                                                                                                                                                              | Chapter 8 concrete items only; per individual void; measurement of concrete volume; not generalised to other chapters | Larger-void treatment is not specified in the 1404 pricebook provision reviewed (whole PDF searched; no other provision addresses voids larger than 0.05 m³; neither deduction nor non-deduction is assumed); verbatim text | VERIFIED_SPEC_ONLY   |
| IR-1404-M-OPEN-00  | فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴ | 1404    | null        | per chapter/group                                                                   | Opening/void measurement rules are specific to item/chapter/group. There is **no** universal opening-deduction rule; each discovered rule is recorded separately with its own source (currently only IR-1404-M-CONC-02).                                                                                                                                                                                                                                                                                                                                                                                                                  | All chapters (structural principle)                                                                                   | Opening rules of all other chapters                                                                                                                                                                                         | VERIFIED_SPEC_ONLY   |

Engine consequences (specification only):

- Rebar (IR-1404-M-REBAR-01) needs a future `unitWeightSource: "standard-table" | "manufacturer-table" | "site-weighed"`
  on weight lines, with the tolerance check. The table values themselves come only from sourced records. None exist yet.
- Concrete (IR-1404-M-CONC-01/02) is a **chapter-8-scoped** rule attached through `MeasurementRule.appliesTo.chapter`.
  The generic takeoff mechanics are unchanged; there is no global `openingDeduction` flag.
- Floor, regional, overhead, site setup/removal and new-works rules are estimation (S4) concerns. They are recorded in the
  price-book spec §11 and never enter takeoff (S1).
- Rounding: the generic engine rounding rules (CG-RCS §5, this spec §6) stay separate from Iranian source rounding rules.
  Only the floor coefficient has a verified source rounding rule so far (price-book spec IR-1404-E-FLOOR-02), and it applies
  to the coefficient, not to quantities. No global Iranian rounding policy exists.

## 10. Synthetic cases

The companion JSON contains **generic, synthetic** cases (item codes like `SYN-0001`, clearly fictitious):
floor × similar counts, a cross-sheet reference, a combined reference with deduction, explicit rounding on a reference
term vs. no rounding, a cycle rejection, an unknown reference, a negative line magnitude, and profile mismatch. Expected values
are exact arithmetic and are checked by tests. They represent no Iranian rule.

Under 0.2.0 the `ir-measurement.v0.1.0.json` case set remains normative, unchanged; the
0.2.0 additions (V13, normative exact aggregation) invalidate no existing case. V13 and
aggregation cases ship as `ir-measurement-cases/ir-measurement.v0.2.0.json` together with
the Phase 1 engine implementation.
