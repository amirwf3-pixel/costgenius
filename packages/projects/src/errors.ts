/**
 * Application-layer error of the project/estimate workflow.
 *
 * The workflow layer orchestrates the pure stack (pricebook → cost-calculation → boq →
 * reporting); it performs no calculation of its own, so its errors are structural only:
 * invalid orchestration inputs and contract violations between the layers it composes.
 * Engine errors (BoqError, EstimateInputError, ReportingError, DomainError) propagate
 * unchanged — they are never swallowed and never repaired here.
 */
export type ProjectsErrorCode =
  | 'INVALID_PROJECT_INPUT'
  | 'INCONSISTENT_DATASET_EDITION'
  | 'EMPTY_DATASET'
  | 'VERSION_WITHOUT_BUILDING'
  | 'INVALID_LINE_UNIT'
  | 'INVALID_TAKEOFF_INPUT'
  | 'TAKEOFF_INVALID_TRANSITION'
  | 'TAKEOFF_CALCULATION_FAILED';

export class ProjectsError extends Error {
  constructor(
    readonly code: ProjectsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProjectsError';
  }
}
