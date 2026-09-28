/**
 * D-016 Phase 4 — the Takeoff → BOQ transfer (G2=B, CG-FT-TAKEOFF-SPEC §8).
 *
 * Pinned here against the REAL published 1404 dataset (no fabricated codes/prices):
 * - ONE BOQ line per priced itemCode/itemTotal: multiple Takeoff lines collapse into the
 *   engine's own itemTotal (never re-aggregated here), uncoded itemTotals are skipped and
 *   reported, and the whole batch is all-or-nothing;
 * - R2=C: the BOQ quantity is the itemTotal's effective `qty` VERBATIM (rounded iff an
 *   item-total rule matched, otherwise the exact aggregate) — exact decimal strings, no
 *   second rounding anywhere downstream (S2/S3/S4 arithmetic untouched);
 * - provenance: every transferred line carries `trace.takeoffDocument` (§8.1) answering
 *   "which Takeoff lines produced this BOQ line?", separate from D-015's `trace.takeoff`;
 * - repeat protection (`ALREADY_TRANSFERRED`), the existing S2 rejections
 *   (PRICEBOOK_ROW_NOT_FOUND / UNIT_MISMATCH) surfacing verbatim in the failures, target
 *   lifecycle (VERSION_FINALIZED / VERSION_NOT_FOUND), and the coexistence contract with
 *   unrelated manual lines;
 * - full S2/S3/S4 parity: a transferred line is byte-identical to its manually-entered
 *   equivalent (s4Result + rollup + reportModel modulo identity and `trace.takeoffDocument`
 *   — the same parity doctrine D-015 established for `trace.takeoff`).
 */
import { describe, expect, it } from 'vitest';
import { BoqError, finalizeEstimateVersion, type BoqLine, type Estimate } from '@costgenius/boq';
import { canonicalJson } from '@costgenius/calc-engine';
import {
  addEstimateLines,
  calculateEstimateVersion,
  createEstimateForProject,
  createFollowUpTakeoffDocument,
  createProject,
  createTakeoffDocument,
  finalizeTakeoffDocument,
  saveTakeoffDocumentDraft,
  startEstimateVersion,
  transferTakeoffToVersion,
  type FinalizedTakeoff,
  type RoundingRuleSet,
  type TakeoffDocumentSheet,
} from '../src/index.js';
import {
  BUILDING_ID,
  ESTIMATE_ID,
  PROJECT_ID,
  goldenCoefficients,
  loadPublished1404,
} from './helpers.js';

const dataset = loadPublished1404();
const T0 = '2026-01-01T00:00:00Z';
const T2 = '2026-01-03T00:00:00Z';

/** A dimensional line (L×W) — the exact-quantity workhorse. */
function dimLine(
  lineId: string,
  itemCode: string,
  length: string,
  width: string,
  unit = 'm2',
): TakeoffDocumentSheet['lines'][number] {
  return {
    lineId,
    rowNo: 1,
    description: `خط ${lineId}`,
    itemCode,
    kind: 'addition',
    unit,
    quantity: { type: 'dimensional', profile: 'LW', length, width },
  };
}

/**
 * Builds a FINALIZED takeoff whose content is the given sheets (through the real domain:
 * create → save → finalize — the engine runs, so itemTotals are the engine's own).
 */
function finalizedTakeoff(
  documentId: string,
  sheets: readonly TakeoffDocumentSheet[],
  rounding: RoundingRuleSet = [],
): FinalizedTakeoff {
  const project = createProject({ projectId: PROJECT_ID, title: 'پروژه', createdAt: T0 });
  const draft = saveTakeoffDocumentDraft(
    createTakeoffDocument(project, {
      documentId,
      takeoffId: `tk-${documentId}`,
      title: 'ریز متره',
      createdAt: T0,
    }),
    { title: 'ریز متره', sheets, rounding },
  );
  return finalizeTakeoffDocument(draft, { finalizedAt: T2 });
}

function newEstimate(estimateId = ESTIMATE_ID): Estimate {
  const project = createProject({ projectId: PROJECT_ID, title: 'پروژه', createdAt: T0 });
  const estimate = createEstimateForProject(project, { estimateId, title: 'برآورد' });
  return startEstimateVersion(dataset, estimate, {
    createdAt: T0,
    buildingId: BUILDING_ID,
    versionId: `${estimateId}-v1`,
  });
}

const versionIdOf = (estimateId = ESTIMATE_ID): string => `${estimateId}-v1`;

describe('takeoff → BOQ transfer (G2=B): aggregation and line creation', () => {
  it('creates ONE BOQ line per itemCode itemTotal; multiple lines collapse (D/E)', () => {
    // The golden example: 010101 lines 4.2 + 2.8 → ONE BOQ line 010101 = 7.
    const finalized = finalizedTakeoff('doc-t1', [
      {
        sheetId: 'S1',
        name: 'برگه',
        lines: [
          { ...dimLine('A', '010101', '2.1', '2'), rowNo: 1 },
          { ...dimLine('B', '010101', '1.4', '2'), rowNo: 2 },
          { ...dimLine('C', '270101', '10', '12', 'kg'), rowNo: 3 },
        ],
      },
    ]);
    const estimate = newEstimate();
    const result = transferTakeoffToVersion(dataset, finalized, estimate, versionIdOf());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    // one line per itemCode — never one per TakeoffLine
    expect(result.lines).toHaveLength(2);
    expect(result.transferred.map((t) => t.itemCode)).toEqual(['010101', '270101']);
    const line = result.lines.find((l) => l.pricebookCode === '010101');
    if (line === undefined) throw new Error('010101 line missing');
    expect(line.quantity).toBe('7'); // 4.2 + 2.8 — the engine's own itemTotal
    expect(line.unit.code).toBe('m2');
    expect(line.lineId).toBe('tk-doc-t1-010101'); // deterministic identity, NOT a takeoff lineId
    // the returned estimate carries the appended lines; the input estimate is untouched
    expect(result.estimate.versions[0]?.lines).toHaveLength(2);
    expect(estimate.versions[0]?.lines).toHaveLength(0);
  });

  it('preserves full G2=B provenance on every transferred line (F/G)', () => {
    const finalized = finalizedTakeoff('doc-t1', [
      {
        sheetId: 'S1',
        name: 'برگه',
        lines: [
          { ...dimLine('A', '010101', '2.1', '2'), rowNo: 1 },
          { ...dimLine('B', '010101', '1.4', '2'), rowNo: 2 },
        ],
      },
    ]);
    const result = transferTakeoffToVersion(dataset, finalized, newEstimate(), versionIdOf());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const line = result.lines[0];
    if (line === undefined) throw new Error('line missing');
    // §8.1: everything needed to answer "which Takeoff lines produced this BOQ line?"
    expect(line.trace.takeoffDocument).toEqual({
      takeoffDocumentId: 'doc-t1',
      takeoffId: 'tk-doc-t1',
      documentNumber: 1,
      itemCode: '010101',
      unit: 'm2',
      lineIds: ['A', 'B'], // the contributing Takeoff lines
      exactQty: '7',
      qty: '7', // no rule matched → the exact aggregate
      specVersion: '0.2.0',
      engineVersion: finalized.result.engineVersion,
    });
    // D-015's quick-entry provenance stays reserved: never both on one line
    expect(line.trace.takeoff).toBeUndefined();
  });

  it('skips uncoded itemTotals explicitly — they are never BOQ lines (H)', () => {
    const finalized = finalizedTakeoff('doc-t1', [
      {
        sheetId: 'S1',
        name: 'برگه',
        lines: [
          { ...dimLine('A', '010101', '2.1', '2'), rowNo: 1 },
          {
            lineId: 'U',
            rowNo: 2,
            description: 'بدون کد',
            kind: 'addition',
            unit: 'm',
            quantity: { type: 'manual', value: '5', justification: 'برآورد دستی' },
          },
        ],
      },
    ]);
    const result = transferTakeoffToVersion(dataset, finalized, newEstimate(), versionIdOf());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.lines).toHaveLength(1); // only the coded itemTotal became a line
    expect(result.skipped).toEqual([
      { itemCode: null, unit: 'm', lineIds: ['U'], exactQty: '5', qty: '5' },
    ]);
    // the skipped item never became a blank-code BOQ line
    expect(result.lines.every((l) => l.pricebookCode.length > 0)).toBe(true);
  });

  it('rejects an unknown itemCode atomically with the existing S2 code (I/R)', () => {
    const finalized = finalizedTakeoff('doc-t1', [
      {
        sheetId: 'S1',
        name: 'برگه',
        lines: [
          { ...dimLine('A', '010101', '2.1', '2'), rowNo: 1 },
          { ...dimLine('X', '999999', '1', '1'), rowNo: 2 },
        ],
      },
    ]);
    const estimate = newEstimate();
    const result = transferTakeoffToVersion(dataset, finalized, estimate, versionIdOf());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('TAKEOFF_TRANSFER_REJECTED');
    const failure = result.failures.find((f) => f.itemCode === '999999');
    expect(failure?.errors.map((e) => e.code)).toContain('PRICEBOOK_ROW_NOT_FOUND');
    // atomic: the estimate is untouched — no 010101 line was created either
    expect(estimate.versions[0]?.lines).toHaveLength(0);
  });

  it('rejects a unit mismatch atomically with the existing S2 code (J)', () => {
    // 010101 is an m2 row; the takeoff measures it in m3 — no conversion ever happens.
    const finalized = finalizedTakeoff('doc-t1', [
      {
        sheetId: 'S1',
        name: 'برگه',
        lines: [
          {
            lineId: 'A',
            rowNo: 1,
            description: 'واحد ناسازگار',
            itemCode: '010101',
            kind: 'addition',
            unit: 'm3',
            quantity: {
              type: 'dimensional',
              profile: 'LWH',
              length: '2',
              width: '3',
              height: '1',
            },
          },
        ],
      },
    ]);
    const result = transferTakeoffToVersion(dataset, finalized, newEstimate(), versionIdOf());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.failures[0]?.errors.map((e) => e.code)).toContain('UNIT_MISMATCH');
  });
});

describe('takeoff → BOQ transfer: R2=C and exact quantities', () => {
  it('carries the rounded itemTotal when a rule matched — never a second rounding (L/M)', () => {
    // 2 × 4 × 1.005 = 8.04 exact; an item-total rule (scale 0) rounds ONCE at the target
    // → roundedQty 8, qty 8. The BOQ line carries qty ("8"); provenance keeps both.
    const finalized = finalizedTakeoff(
      'doc-t1',
      [
        {
          sheetId: 'S1',
          name: 'برگه',
          lines: [
            {
              lineId: 'A',
              rowNo: 1,
              description: 'دقت اعشار',
              itemCode: '010101',
              kind: 'addition',
              unit: 'm2',
              quantity: {
                type: 'dimensional',
                profile: 'LWH',
                length: '2',
                width: '4',
                height: '1.005',
              },
            },
          ],
        },
      ],
      [
        {
          target: 'item-total',
          selector: { itemCode: '010101' },
          scale: 0,
          mode: 'HALF_UP',
          sourceStatus: 'design',
        },
      ],
    );
    const total = finalized.result.itemTotals.find((t) => t.itemCode === '010101');
    expect(total?.exactQty).toBe('8.04');
    expect(total?.roundedQty).toBe('8');
    expect(total?.qty).toBe('8');
    const result = transferTakeoffToVersion(dataset, finalized, newEstimate(), versionIdOf());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const line = result.lines[0];
    if (line === undefined) throw new Error('line missing');
    expect(line.quantity).toBe('8'); // R2=C: the itemTotal's effective qty, verbatim
    expect(line.trace.takeoffDocument).toMatchObject({
      exactQty: '8.04', // exact always retained in provenance
      roundedQty: '8',
      qty: '8',
    });
    // no second rounding: S3 prices exactly this quantity (the trace repeats it verbatim)
    expect(line.trace.quantity).toBe('8');
    expect(line.lineAmount).toBe(line.trace.lineAmount);
  });

  it('preserves exact fractional decimals end to end when no rule matched (K)', () => {
    // 2.01 × 2 = 4.02 + 1.4 × 2 = 2.8 → 6.82 — never a JavaScript number, never rounded.
    const finalized = finalizedTakeoff('doc-t1', [
      {
        sheetId: 'S1',
        name: 'برگه',
        lines: [
          { ...dimLine('A', '270101', '2.01', '2', 'kg'), rowNo: 1 },
          { ...dimLine('B', '270101', '1.4', '2', 'kg'), rowNo: 2 },
        ],
      },
    ]);
    const result = transferTakeoffToVersion(dataset, finalized, newEstimate(), versionIdOf());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    const line = result.lines.find((l) => l.pricebookCode === '270101');
    expect(line?.quantity).toBe('6.82');
    expect(line?.trace.takeoffDocument).toMatchObject({ exactQty: '6.82', qty: '6.82' });
    // S3 multiplies THIS quantity by the row's exact base price (299000 × 6.82 = 2039180)
    expect(line?.lineAmount).toBe('2039180');
  });
});

describe('takeoff → BOQ transfer: idempotency, conflicts and coexistence', () => {
  const GOLDEN_SHEETS: readonly TakeoffDocumentSheet[] = [
    {
      sheetId: 'S1',
      name: 'برگه',
      lines: [
        { ...dimLine('A', '010101', '2.1', '2'), rowNo: 1 },
        { ...dimLine('B', '010101', '1.4', '2'), rowNo: 2 },
      ],
    },
  ];

  it('rejects a second transfer of the same source with ALREADY_TRANSFERRED (S/T)', () => {
    const finalized = finalizedTakeoff('doc-t1', GOLDEN_SHEETS);
    const first = transferTakeoffToVersion(dataset, finalized, newEstimate(), versionIdOf());
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    const second = transferTakeoffToVersion(dataset, finalized, first.estimate, versionIdOf());
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.code).toBe('TAKEOFF_TRANSFER_REJECTED');
    expect(second.failures[0]?.errors.map((e) => e.code)).toContain('ALREADY_TRANSFERRED');
    // and the rejected attempt appended nothing
    expect(first.estimate.versions[0]?.lines).toHaveLength(1);
  });

  it('never merges or overwrites unrelated manual lines (U)', () => {
    const finalized = finalizedTakeoff('doc-t1', GOLDEN_SHEETS);
    // a manual line with the SAME itemCode exists first — different identity, coexists
    const manual = addEstimateLines(dataset, newEstimate(), versionIdOf(), [
      { lineId: 'manual-1', pricebookCode: '010101', quantity: '100', unit: 'm2' },
    ]);
    if (!manual.ok) throw new Error('manual line failed to bind');
    const result = transferTakeoffToVersion(dataset, finalized, manual.estimate, versionIdOf());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.estimate.versions[0]?.lines.map((l) => l.lineId)).toEqual([
      'manual-1',
      'tk-doc-t1-010101',
    ]);
    const manualLine = result.estimate.versions[0]?.lines.find((l) => l.lineId === 'manual-1');
    expect(manualLine?.quantity).toBe('100'); // untouched
    expect(manualLine?.trace.takeoffDocument).toBeUndefined(); // not takeoff-derived
  });

  it('a different finalized source (a real follow-up) may transfer into the same version', () => {
    const source = finalizedTakeoff('doc-t1', GOLDEN_SHEETS);
    const first = transferTakeoffToVersion(dataset, source, newEstimate(), versionIdOf());
    if (!first.ok) throw new Error('first transfer failed');
    // the real follow-up revision: verbatim copy, documentNumber 2, own documentId
    const followUpDraft = createFollowUpTakeoffDocument(source.document, {
      documentId: 'doc-t2',
      createdAt: T0,
    });
    const followUp = finalizeTakeoffDocument(followUpDraft, { finalizedAt: T2 });
    const follow = transferTakeoffToVersion(dataset, followUp, first.estimate, versionIdOf());
    expect(follow.ok).toBe(true);
    if (!follow.ok) throw new Error('unreachable');
    expect(follow.estimate.versions[0]?.lines.map((l) => l.lineId)).toEqual([
      'tk-doc-t1-010101',
      'tk-doc-t2-010101',
    ]);
  });

  it('rejects a finalized target with the existing VERSION_FINALIZED code', () => {
    const finalized = finalizedTakeoff('doc-t1', GOLDEN_SHEETS);
    const finalizedEstimate = finalizeEstimateVersion(newEstimate(), versionIdOf());
    expect(() =>
      transferTakeoffToVersion(dataset, finalized, finalizedEstimate, versionIdOf()),
    ).toThrowError(BoqError);
  });

  it('rejects an unknown target version with the existing VERSION_NOT_FOUND code', () => {
    const finalized = finalizedTakeoff('doc-t1', GOLDEN_SHEETS);
    expect(() =>
      transferTakeoffToVersion(dataset, finalized, newEstimate(), 'no-such-version'),
    ).toThrowError(/no version/);
  });
});

describe('takeoff → BOQ transfer: S2/S3/S4 parity (the golden case)', () => {
  /** Removes every `takeoffDocument` key (deep) — the D-016 provenance difference. */
  function stripTakeoffDocument(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stripTakeoffDocument);
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value)) {
        if (key === 'takeoffDocument') continue;
        out[key] = stripTakeoffDocument(entry);
      }
      return out;
    }
    return value;
  }

  it('a transferred line is priced and estimated exactly like its manual equivalent (N/O/P/Q)', () => {
    // The golden case: 010101 = 4.2 + 2.8 = 7 transferred, vs a manual 010101 line of 7.
    const finalized = finalizedTakeoff('doc-t1', [
      {
        sheetId: 'S1',
        name: 'برگه',
        lines: [
          { ...dimLine('A', '010101', '2.1', '2'), rowNo: 1 },
          { ...dimLine('B', '010101', '1.4', '2'), rowNo: 2 },
        ],
      },
    ]);
    const transferred = transferTakeoffToVersion(
      dataset,
      finalized,
      newEstimate('est-transfer'),
      versionIdOf('est-transfer'),
    );
    if (!transferred.ok) throw new Error('transfer failed');
    const manual = addEstimateLines(dataset, newEstimate('est-manual'), versionIdOf('est-manual'), [
      { lineId: 'l1', pricebookCode: '010101', quantity: '7', unit: 'm2' },
    ]);
    if (!manual.ok) throw new Error('manual lines failed');

    // S2/S3 parity: same binding and price, identical modulo lineId + provenance
    const transferredLine = transferred.lines[0];
    const manualLine = manual.lines[0];
    if (transferredLine === undefined || manualLine === undefined) throw new Error('missing');
    const comparable = (line: BoqLine): Record<string, unknown> => ({
      pricebookCode: line.pricebookCode,
      chapter: line.chapter,
      group: line.group,
      description: line.description,
      unit: line.unit,
      quantity: line.quantity,
      basePrice: line.basePrice,
      lineAmount: line.lineAmount,
      pricebookStatus: line.pricebookStatus,
      calculationStatus: line.calculationStatus,
      edition: line.edition,
      externalDependencies: line.externalDependencies,
      notes: line.notes,
    });
    expect(canonicalJson(comparable(transferredLine))).toBe(canonicalJson(comparable(manualLine)));
    expect(transferredLine.trace.takeoffDocument?.qty).toBe(manualLine.quantity);

    // S4 parity: the full estimation chain is byte-identical (s4Result + rollup)
    const coefficients = goldenCoefficients('1.1', '51828473.788', '12000000');
    const transferredCalc = calculateEstimateVersion(
      transferred.estimate,
      versionIdOf('est-transfer'),
      coefficients,
      { reportId: 'r', generatedAt: T2 },
    );
    const manualCalc = calculateEstimateVersion(
      manual.estimate,
      versionIdOf('est-manual'),
      coefficients,
      { reportId: 'r', generatedAt: T2 },
    );
    // (s4Result carries the estimate identity — normalize it like the D-015 parity test)
    expect(canonicalJson(transferredCalc.s4Result).replaceAll('est-transfer', 'est-manual')).toBe(
      canonicalJson(manualCalc.s4Result),
    );
    expect(canonicalJson(transferredCalc.rollup).replaceAll('est-transfer', 'est-manual')).toBe(
      canonicalJson(manualCalc.rollup),
    );
    // reportModel identical modulo identity and trace.takeoffDocument (documented difference)
    const normalize = (value: unknown): string =>
      canonicalJson(stripTakeoffDocument(value))
        .replaceAll('est-transfer', 'est-manual')
        .replaceAll('tk-doc-t1-010101', 'l1');
    expect(normalize(transferredCalc.reportModel)).toBe(canonicalJson(manualCalc.reportModel));
  });
});
