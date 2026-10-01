# Specifications: how they are used

| Spec                                                                  | Status                                                                                                                                                                        | Governs                                                                                                                                                        |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `REFERENCE_CALCULATION_SPEC.md` (`CG-RCS@0.1.0`) + `reference-cases/` | **Implemented** (Phase 2), frozen                                                                                                                                             | Generic quantity engine `calculateQuantities`                                                                                                                  |
| `CG-IR-MEASUREMENT-SPEC@0.2.0.md` + `ir-measurement-cases/`           | **Implemented** (D-016 Phase 1: `calculateTakeoff`; supersedes 0.1.0)                                                                                                         | The S1 engine contract for `calculateTakeoff`: documents, sheets, lines, floor/similar counts, references, expressions, explicit rounding, item/sheet totals   |
| `CG-IR-MEASUREMENT-SPEC@0.1.0.md`                                     | Superseded history (Phase 3)                                                                                                                                                  | The original 0.1.0 text, normative content unchanged (status line annotated)                                                                                   |
| `../../projects/spec/CG-FT-TAKEOFF-SPEC@0.2.0.md`                     | **Implemented** (D-016 Phases 0–6 + D-017 Phase-7 list & draft preview)                                                                                                       | Full Takeoff product contracts: lifecycle, persistence, mutation/concurrency, BOQ transfer, reporting, provenance, API errors                                  |
| `../../projects/spec/CG-FT-TAKEOFF-SPEC@0.1.0.md`                     | Superseded history (D-016 Phases 0–6; superseded by 0.2.0)                                                                                                                    | Full Takeoff product contracts of the shipped Phases 0–6 (status line annotated)                                                                               |
| `../../pricebook/spec/CG-IR-PRICEBOOK-SPEC@0.1.0.md`                  | Specification only (Phase 3); the official 1404 ابنیه edition ships as a verified, hash-bound staged dataset — the edition import/approval pipeline itself is not implemented | Editions, Item Master, import pipeline, edition concepts C1–C9                                                                                                 |
| `../../apps/api/spec/CG-GOV-SPEC@0.1.0.md`                            | **Contract only — NOT implemented** (P8-A S0, D-018, 2026-09-28; implementation pending a separate execution order)                                                           | Phase-8 Governance & Trust: authentication/sessions, the five-role authorization matrix, append-only audit with its event inventory, minimal reviewer sign-off |

## Next implementation phase

> **Status note (2026-09, updated after D-016 Phases 0–6):** as written, this plan
> predates the shipped vertical slice. Items 3 and 4 are already satisfied by the
> repository through other packages: the real 1404 ابنیه edition is imported,
> hash-bound and expert-verified in `packages/pricebook`, and S2/S3/S4 are implemented
> in `packages/cost-calculation` (used by the production API). Item 1
> (`calculateTakeoff`) is complete: the engine contract
> `CG-IR-MEASUREMENT-SPEC@0.2.0` is implemented (D-016 Phase 1, beside the frozen
> `calculateQuantities`/CG-RCS@0.1.0), and the Full Takeoff product contracts of
> `../../projects/spec/CG-FT-TAKEOFF-SPEC@0.2.0.md` are implemented through D-016
> Phase 6 (persistence, lifecycle, API, UI, BOQ transfer, reporting) and its Phase-7
> follow-through (D-017: the §15 list and the §16 stateless draft preview). Item 2 (the
> price-book staging/validation/approval pipeline) remains unimplemented. The original
> plan text below is preserved as history.

1. Implement `calculateTakeoff` in `calc-engine` **beside** `calculateQuantities`. It will reuse domain `Qty` and
   must pass every `IRM-*` case unchanged. CG-RCS behaviour and cases stay frozen.
2. Implement the price-book staging/validation/approval pipeline against the synthetic fixture only.
3. Import the real 1404 ابنیه edition only after its source file is stored and hashed, and its metadata, units, C1–C9 content and
   measurement rules have been verified by a domain expert. Until then every Iranian-specific record stays
   `unverified` and changes no number.
4. S2 mapping, S3 raw amount and S4 coefficients come after that, in that order.

The test-only evaluators in `test/` cross-check the expected values in the spec data. Production code must not import them (enforced by lint).
