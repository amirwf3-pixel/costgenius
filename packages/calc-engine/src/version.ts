/** Specification this engine conforms to. */
export const SPEC_VERSION = '0.1.0';
/**
 * Specification implemented by `calculateTakeoff` (D-016, CG-IR-MEASUREMENT-SPEC@0.2.0).
 * The CG-RCS `SPEC_VERSION` above stays frozen for `calculateQuantities`.
 */
export const TAKEOFF_SPEC_VERSION = '0.2.0';
/**
 * Engine implementation version; bump on any behaviour change (DECISIONS.md D-003).
 * 0.2.0: `calculateTakeoff` added beside the unchanged `calculateQuantities`
 * (D-016 Phase 1). No CG-RCS behaviour changed.
 */
export const ENGINE_VERSION = '0.2.0';
