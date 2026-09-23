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

## 5. Non-negotiable quality requirements

1. **Determinism**: same inputs + same data versions ⇒ byte-identical numeric results.
2. **Exact arithmetic**: decimal arithmetic; no binary floating point in money or quantities.
3. **Traceability**: every number in a report traces to formula inputs, price source/edition, and overrides.
4. **No fabrication**: AI never creates quantities, prices, regulations, or BOQ items that enter calculations without explicit user acceptance; accepted values record AI provenance.
5. **Reproducibility**: locked estimate versions can be re-rendered identically years later.
6. **Export fidelity**: Excel totals equal app totals exactly; Excel contains formulas, not just values.
7. **Data residency/availability**: deployable on Iranian hosting or on-premise; must operate without dependence on foreign services (AI features degrade gracefully when unavailable).

## 6. Success criteria (v1)

- An estimator can complete takeoff + official-price estimate for a mid-size building and export an Excel/PDF package acceptable for submission, with reviewer sign-off and full audit trail.
- Golden-file test suite reproduces reference estimates prepared manually by domain experts.

## 7. Open questions (require domain-expert input)

- ~~V1 disciplines~~ — resolved: ابنیه only (DECISIONS D-015).
- Canonical formats of official price-book source files available to us, and licensing/redistribution terms.
- Required report layouts (organization-specific templates vs. standard layout).
- Coefficient rules per edition must be transcribed from official documents and verified by an expert — not inferred.
