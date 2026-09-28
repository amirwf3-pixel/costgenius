/**
 * Shared result-status vocabulary of the CostGenius business-calculation layer (S2/S3/S4).
 *
 * These are *calculation* statuses, distinct from the pricebook verification statuses
 * (`PricebookStatus`): a row's verification status records what the 1404 source establishes;
 * a calculation status records whether this computation could be completed. The mapping is
 * mechanical and one-directional — a verified row with a price prices COMPLETE; anything
 * external, unspecified or incomplete stays exactly that. Nothing here turns a pending
 * condition into a value.
 */
export type CalculationStatus = 'COMPLETE' | 'INCOMPLETE' | 'EXTERNAL_DEPENDENCY' | 'NOT_SPECIFIED';

/**
 * Aggregates statuses with the precedence external > unspecified > incomplete.
 * A single external dependency keeps the whole result EXTERNAL_DEPENDENCY; an empty list is
 * COMPLETE. The aggregation never upgrades a status.
 */
export function aggregateCalculationStatus(
  statuses: readonly CalculationStatus[],
): CalculationStatus {
  let sawIncomplete = false;
  let sawNotSpecified = false;
  for (const status of statuses) {
    if (status === 'EXTERNAL_DEPENDENCY') return 'EXTERNAL_DEPENDENCY';
    if (status === 'NOT_SPECIFIED') sawNotSpecified = true;
    if (status === 'INCOMPLETE') sawIncomplete = true;
  }
  if (sawNotSpecified) return 'NOT_SPECIFIED';
  if (sawIncomplete) return 'INCOMPLETE';
  return 'COMPLETE';
}

/** Human-readable statement of a source rule a stage applied, for traces and reports. */
export interface AppliedRule {
  readonly id: string;
  readonly sourceReference: string;
}
