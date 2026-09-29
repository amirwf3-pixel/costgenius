# CostGenius — Project Scope

## 1. Product statement

CostGenius is a professional quantity-takeoff (متره) and cost-estimation (برآورد) application for **building construction in Iran**, used by contractors, consulting engineers, cost estimators and employer-side technical offices. It produces auditable quantities, priced BOQs based on the official price book and/or market prices, and editable Excel/PDF deliverables.

## 2. In scope

- **Building construction only**: residential, commercial, office, and public buildings (structure, architecture, finishes, and building services where covered by the relevant official price books).
- **Quantity takeoff**: structured, formula-based measurement sheets (ریز متره) with dimensions, counts, deductions, and per-line traceability to drawings/locations.
- **Official price-book pricing**: import and versioned storage of the annually published unit-price lists (فهرست بهای واحد پایه) for building disciplines, including chapters, items, units, descriptions, and applicable coefficients — **only from official source files supplied/imported by users or administrators**.
- **Market-price pricing**: user-maintained and imported market prices for materials, labor and equipment, with source, date, region and validity.
- **Estimation**: summary sheets (خلاصه برآورد), chapter summaries, coefficients (regional, height, and other factors _as defined in the imported price-book edition_), non-listed items (اقلام ستاره‌دار), and comparisons between official vs. market pricing.
- **Manual overrides**: any price or coefficient may be overridden with mandatory reason, author, and timestamp.
- **Audit trail**: full history of who changed what, when, from which source.
- **Reporting/export**: Excel (editable, with live formulas) and PDF (print-ready, RTL, Persian) as first-class features.
- **AI assistance** (strictly advisory): parsing drawings/PDF/spreadsheet inputs into _proposed_ takeoff lines, suggesting price-book item matches, explaining calculations. All AI output requires human confirmation.
- **Localization**: Persian (fa-IR) primary, RTL UI, Jalali calendar, Rial/Toman display, Persian digits optional in output.
- **Multi-user organizations** with roles.

## 3. Out of scope

- Infrastructure, road, dam, pipeline, industrial plant, or any non-building discipline.
- Structural/MEP design or code-compliance checking. The app does not certify compliance with مقررات ملی ساختمان.
- Tender management, contract administration, payment certificates (صورت‌وضعیت) and price-escalation (تعدیل) calculations — **deferred**, possible later phases; the data model must not preclude them.
- Scheduling, ERP, accounting, procurement.
- Any bundled/"guessed" price-book or market data. The system ships with no price data it did not obtain from a traceable source.

## 4. Users & roles

| Role         | Capabilities                                        |
| ------------ | --------------------------------------------------- |
| Org Admin    | Users, roles, org settings, price-book imports      |
| Estimator    | Create/edit takeoffs and estimates                  |
| Reviewer     | Review, comment, approve/lock versions              |
| Viewer       | Read-only, export                                   |
| Data Steward | Manage market-price sources and price-book editions |

> **Status note (2026-09-28, D-018 / P8-A S0):** this five-role model is
> **contract-closed** for Phase 8 (the proposed V1.1) in
> `apps/api/spec/CG-GOV-SPEC@0.1.0.md` — single organization, global roles, a frozen
> route-authorization matrix, plus authentication, audit and minimal sign-off
> contracts. None of it is implemented yet: the current system is single-user with no
> authentication. The historical table above is preserved unchanged.

## 5. Non-negotiable quality requirements

1. **Determinism**: same inputs + same data versions ⇒ byte-identical numeric results.
2. **Exact arithmetic**: decimal arithmetic; no binary floating point in money or quantities.
3. **Traceability**: every number in a report traces to formula inputs, price source/edition, and overrides.
4. **No fabrication**: AI never creates quantities, prices, regulations, or BOQ items that enter calculations without explicit user acceptance; accepted values record AI provenance.
5. **Reproducibility**: locked estimate versions can be re-rendered identically years later.
6. **Export fidelity**: Excel totals equal app totals exactly; Excel contains formulas, not just values.
7. **Data residency/availability**: deployable on Iranian hosting or on-premise; must operate without dependence on foreign services (AI features degrade gracefully when unavailable).

> **Status note (2026-09, D-017 / D-V1=A):** of requirement 6, the first clause (Excel
> totals equal app totals exactly) is implemented and test-enforced; the live-formulas
> clause is **deferred beyond V1** (the standing D-010 deferral, recorded in
> DECISIONS.md D-017). The historical requirement text above is preserved unchanged.

## 6. Success criteria (v1)

- An estimator can complete takeoff + official-price estimate for a mid-size building and export an Excel/PDF package acceptable for submission, with reviewer sign-off and full audit trail.
- Golden-file test suite reproduces reference estimates prepared manually by domain experts.

> **Status note (2026-09, D-017 / D-V1=A):** V1 is defined as the implemented slice —
> the estimation vertical (Project → Estimate → BOQ → official 1404 ابنیه pricebook →
> S2/S3/S4 → immutable finalized snapshot → PDF/Excel reporting), D-015 dimensional quick
> entry, and D-016 Full Takeoff Phases 0–6 (see DECISIONS.md D-017 for the full list).
> The reviewer sign-off and full audit trail clause of the first criterion is **deferred
> beyond V1** (single-user V1; D-007 not implemented). The golden-file criterion is met
> by the shipped golden suites (engine reference cases, E2E goldens, production-smoke
> golden). The historical requirement text above is preserved unchanged.
>
> **Status note (2026-09-28, D-018):** Phase 8 (P8-A, the proposed V1.1) closes the
> governance contracts for exactly that deferred clause — authentication, the five
> roles, actor-stamped append-only audit and minimal reviewer sign-off
> (`apps/api/spec/CG-GOV-SPEC@0.1.0.md`). Implemented and verified in stages under
> the owner's execution orders — S0..S4 COMPLETE (2026-09-28/29; see the
> implementation-status table in the spec).

## 7. Open questions (require domain-expert input)

- ~~V1 disciplines~~ — resolved: ابنیه only (an earlier owner scope decision; not D-015, which is the dimensional quantity-entry decision).
- Canonical formats of official price-book source files available to us, and licensing/redistribution terms.
- Required report layouts (organization-specific templates vs. standard layout).
- Coefficient rules per edition must be transcribed from official documents and verified by an expert — not inferred.
