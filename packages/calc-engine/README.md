# @costgenius/calc-engine

The pure, deterministic calculation engine (ARCHITECTURE.md §4.1).

**Status:** specification only. The engine itself is not implemented.

- [`spec/REFERENCE_CALCULATION_SPEC.md`](spec/REFERENCE_CALCULATION_SPEC.md) contains the versioned contract (`CG-RCS@0.1.0`).
- [`spec/reference-cases/quantity.v0.1.0.json`](spec/reference-cases/quantity.v0.1.0.json) holds the synthetic reference cases.
- `test/` validates the specification data. `test/reference-oracle.ts` is a test-only cross-check of the expected
  values and must never be imported by production code.

A future engine must pass every reference case exactly.
