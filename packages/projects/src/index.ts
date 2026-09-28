/**
 * @costgenius/projects — the application/orchestration layer of the estimate workflow.
 *
 * Phase 13 vertical slice: Project → Estimate → EstimateVersion → BOQ lines (exact 1404
 * pricebook binding) → S4 calculation → BOQ rollup → ReportModel → Excel/PDF rendering.
 *
 * This layer orchestrates the pure stack (`pricebook` → `cost-calculation` → `boq` →
 * `reporting` → renderers) and owns no formula, no formatting and no rule: every number
 * still comes from the engine layers, every layout from the renderers. It is itself pure —
 * no I/O, no clock, no randomness: datasets, identities and instants are injected by the
 * caller (apps/tests), which makes the whole workflow deterministic and replayable.
 */
export { ProjectsError, type ProjectsErrorCode } from './errors.js';
// The orchestrated D-016 engine capability (re-exported so dependants — e.g. @costgenius/db
// tests and the future API layer — never need a direct calc-engine dependency).
export { calculateTakeoff } from '@costgenius/calc-engine';
export type {
  ExpressionNode,
  ExpressionQuantity,
  DimensionalQuantity,
  ManualQuantity,
  ReferenceQuantity,
  ReferenceTerm,
  RoundingRuleEntry,
  RoundingRuleSet,
  RoundingSelector,
  RoundingSourceStatus,
  RoundingTarget,
  SourceRef,
  TakeoffCalculationInput,
  TakeoffError,
  TakeoffItemTotal,
  TakeoffLineInput,
  TakeoffLineResult,
  TakeoffResult,
  TakeoffSheetItemTotal,
  TakeoffSheetTotal,
  TakeoffTraceNode,
} from '@costgenius/calc-engine';
export { createProject, type CreateProjectInput, type Project } from './project.js';
export {
  archiveTakeoffDocument,
  createFollowUpTakeoffDocument,
  createTakeoffDocument,
  finalizeTakeoffDocument,
  previewTakeoffDocumentCalculation,
  saveTakeoffDocumentDraft,
  takeoffCalculationInputOf,
  unarchiveTakeoffDocument,
  type CreateTakeoffDocumentInput,
  type FinalizeTakeoffOptions,
  type FinalizedTakeoff,
  type FollowUpTakeoffInput,
  type TakeoffDocument,
  type TakeoffDocumentContent,
  type TakeoffDocumentLine,
  type TakeoffDocumentSheet,
  type TakeoffDocumentStatus,
} from './takeoff-document.js';
export {
  transferTakeoffToVersion,
  takeoffTransferLineId,
  type SkippedItemTotal,
  type TakeoffTransferFailure,
  type TakeoffTransferResult,
  type TransferredItemTotal,
} from './takeoff-transfer.js';
export {
  datasetEditionOf,
  createEstimateForProject,
  startEstimateVersion,
  addEstimateLines,
  currentVersionOf,
  type AddLinesResult,
  type CreateEstimateForProjectInput,
  type StartVersionInput,
} from './estimate-workflow.js';
export {
  resolveEstimateLines,
  type EstimateLineInput,
  type LineInputError,
  type LineResolutionFailure,
  type LineResolutionResult,
} from './estimate-lines.js';
export {
  computeTakeoffQuantities,
  takeoffInputOf,
  type TakeoffFactors,
  type TakeoffProvenance,
  type TakeoffQuantity,
  type TakeoffQuantitiesResult,
} from './takeoff-quantities.js';
export {
  calculateEstimateVersion,
  finalizeEstimate,
  type CalculateVersionOptions,
  type EstimateCalculation,
  type EstimateCoefficientInputs,
  type FinalizeVersionOptions,
  type FinalizedEstimate,
} from './estimate-calculation.js';
export {
  renderEstimateExcel,
  renderEstimatePdf,
  renderTakeoffExcel,
  renderTakeoffPdf,
  type RenderTakeoffOptions,
} from './rendering.js';
export {
  InMemoryEstimateRepository,
  InMemoryFinalizedEstimateRepository,
  InMemoryFinalizedTakeoffRepository,
  InMemoryProjectRepository,
  InMemoryTakeoffDocumentRepository,
  type EstimateRepository,
  type FinalizedEstimateRepository,
  type FinalizedTakeoffRepository,
  type ProjectRepository,
  type TakeoffDocumentRepository,
} from './persistence.js';
export {
  USER_ROLES,
  type SessionRecord,
  type SessionStore,
  type User,
  type UserRole,
  type UserStore,
} from './users.js';
