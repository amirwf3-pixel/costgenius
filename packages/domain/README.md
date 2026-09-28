# @costgenius/domain

Pure domain primitives shared by every other package. No I/O, clock, randomness or framework code.

- `Money` — exact IRR amounts (decimal.js), explicit rounding only.
- `Qty` — exact quantities bound to a `UnitCode`; unit mismatch is an error, never a silent conversion.
- `RoundingMode` / `RoundingRule` — explicit rounding vocabulary.
- Branded identifiers (UUID-validated) and `Instant` (UTC ISO-8601 timestamps).
- `DomainError` with stable error codes.
