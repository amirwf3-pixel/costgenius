import { describe, expect, it } from 'vitest';
import type { TakeoffReportSource } from '../src/index.js';
import {
  buildTakeoffReportModel,
  takeoffQuantityDisplay,
  type TakeoffReportModel,
} from '../src/index.js';
import { ReportingError } from '../src/errors.js';

// -------------------------------------------------------------------------------------------------
// A hand-written, engine-faithful FINALIZED snapshot: every value below is exactly what
// CG-IR-MEASUREMENT-SPEC@0.2.0's engine would persist for this input (the semantics were
// read from the engine source: signedValue = kind sign after line rounding; itemTotals
// aggregate exactSigned; qty = roundedQty ?? exactQty). Hand-written on purpose — the
// builder must copy VERBATIM, so the test controls the exact strings.
// -------------------------------------------------------------------------------------------------

const T0 = '2026-01-01T00:00:00Z';
const T2 = '2026-01-03T00:00:00Z';
const SPEC_ID = 'CG-IR-MEAS';
const SPEC_VERSION = '0.2.0';
const ENGINE_VERSION = '0.2.0';
const RULE_ID = 'CG-IR-MEASUREMENT-SPEC@0.2.0#multiply';

function traceNode(
  value: string,
  unit: string,
): { op: 'multiply'; label: string; value: string; unit: never; ruleId: string; inputs: [] } {
  return {
    op: 'multiply',
    label: 'line:x',
    value,
    unit: unit as never,
    ruleId: RULE_ID,
    inputs: [],
  };
}

/** The full snapshot: 2 sheets, 5 lines, all four quantity types, one uncoded + one deduction. */
function finalizedSource(): TakeoffReportSource {
  return {
    document: {
      documentId: 'doc-r1',
      takeoffId: 'tk-doc-r1',
      projectId: 'proj-1',
      title: 'ریز متره فاز یک',
      documentNumber: 3,
      status: 'finalized',
      revision: 2,
      createdAt: T0,
      finalizedAt: T2,
    },
    documentId: 'doc-r1',
    takeoffId: 'tk-doc-r1',
    documentNumber: 3,
    finalizedAt: T2,
    input: {
      sheets: [
        {
          sheetId: 'sh-a',
          name: 'برگه الف',
          lines: [
            // authored OUT of rowNo order on purpose: the model must sort by rowNo
            {
              lineId: 'ln-2',
              rowNo: 2,
              description: 'کف راهرو',
              location: 'طبقه اول',
              itemCode: '280101',
              kind: 'addition',
              unit: 'm2',
              quantity: {
                type: 'dimensional',
                profile: 'LW',
                floorCount: '2',
                length: '5.1',
                width: '2',
              },
            },
            {
              lineId: 'ln-1',
              rowNo: 1,
              description: 'کف سالن',
              location: 'طبقه اول',
              itemCode: '280101',
              kind: 'addition',
              unit: 'm2',
              quantity: { type: 'dimensional', profile: 'LW', length: '4.25', width: '3.4' },
            },
            {
              lineId: 'ln-3',
              rowNo: 3,
              description: 'سقف کاذب',
              kind: 'addition',
              unit: 'm2',
              quantity: {
                type: 'reference',
                terms: [{ lineId: 'ln-1', factor: '0.5', use: 'signed' }],
              },
            },
          ],
        },
        {
          sheetId: 'sh-b',
          name: 'برگه ب',
          lines: [
            {
              lineId: 'ln-4',
              rowNo: 1,
              description: 'دال بتنی',
              itemCode: '410202',
              kind: 'addition',
              unit: 'm3',
              quantity: {
                type: 'expression',
                node: {
                  op: 'round',
                  arg: {
                    op: 'mul',
                    args: [
                      { op: 'const', value: '4.25' },
                      { op: 'const', value: '3.4' },
                      { op: 'const', value: '0.37' },
                    ],
                  },
                  rule: { scale: 2, mode: 'HALF_UP' },
                },
              },
            },
            {
              lineId: 'ln-5',
              rowNo: 2,
              description: 'کانال تخلیه',
              kind: 'deduction',
              unit: 'm',
              notes: 'برش عرضی',
              quantity: { type: 'manual', value: '12.5', justification: 'برآورد اجرایی' },
            },
          ],
        },
      ],
      rounding: [
        {
          target: 'line',
          selector: { itemCode: '410202' },
          scale: 2,
          mode: 'HALF_UP',
          sourceStatus: 'design',
          source: {
            sourceDocument: 'دفترچه فنی',
            edition: '۱۴۰۴',
            page: '12',
            section: 'بند ۳',
          },
        },
        {
          target: 'item-total',
          selector: { unit: 'm3' },
          scale: 1,
          mode: 'HALF_UP',
          sourceStatus: 'design',
        },
      ],
    },
    result: {
      specId: SPEC_ID,
      specVersion: SPEC_VERSION,
      engineVersion: ENGINE_VERSION,
      status: 'ok',
      errors: [],
      lines: [
        {
          lineId: 'ln-1',
          sheetId: 'sh-a',
          rowNo: 1,
          itemCode: '280101',
          unit: 'm2',
          kind: 'addition',
          exactMagnitude: '14.45',
          signedValue: '14.45',
          trace: traceNode('14.45', 'm2'),
        },
        {
          lineId: 'ln-2',
          sheetId: 'sh-a',
          rowNo: 2,
          itemCode: '280101',
          unit: 'm2',
          kind: 'addition',
          exactMagnitude: '20.4',
          signedValue: '20.4',
          trace: traceNode('20.4', 'm2'),
        },
        {
          lineId: 'ln-3',
          sheetId: 'sh-a',
          rowNo: 3,
          itemCode: null,
          unit: 'm2',
          kind: 'addition',
          exactMagnitude: '7.225',
          signedValue: '7.225',
          trace: traceNode('7.225', 'm2'),
        },
        {
          lineId: 'ln-4',
          sheetId: 'sh-b',
          rowNo: 1,
          itemCode: '410202',
          unit: 'm3',
          kind: 'addition',
          exactMagnitude: '5.3465',
          roundedMagnitude: '5.35',
          signedValue: '5.35',
          trace: { ...traceNode('5.3465', 'm3'), op: 'round' },
        },
        {
          lineId: 'ln-5',
          sheetId: 'sh-b',
          rowNo: 2,
          itemCode: null,
          unit: 'm',
          kind: 'deduction',
          exactMagnitude: '12.5',
          signedValue: '-12.5',
          trace: { ...traceNode('12.5', 'm'), op: 'manual' },
        },
      ],
      itemTotals: [
        {
          itemCode: '280101',
          unit: 'm2',
          exactQty: '34.85',
          qty: '34.85',
          lineIds: ['ln-1', 'ln-2'],
        },
        {
          itemCode: null,
          unit: 'm2',
          exactQty: '7.225',
          qty: '7.225',
          lineIds: ['ln-3'],
        },
        {
          itemCode: '410202',
          unit: 'm3',
          exactQty: '5.3465',
          roundedQty: '5.3',
          qty: '5.3',
          lineIds: ['ln-4'],
        },
        {
          itemCode: null,
          unit: 'm',
          exactQty: '-12.5',
          qty: '-12.5',
          lineIds: ['ln-5'],
        },
      ],
      sheetTotals: [
        {
          sheetId: 'sh-a',
          byItem: [
            {
              itemCode: '280101',
              unit: 'm2',
              exactQty: '34.85',
              qty: '34.85',
              lineIds: ['ln-1', 'ln-2'],
            },
            {
              itemCode: null,
              unit: 'm2',
              exactQty: '7.225',
              qty: '7.225',
              lineIds: ['ln-3'],
            },
          ],
        },
        {
          sheetId: 'sh-b',
          byItem: [
            {
              itemCode: '410202',
              unit: 'm3',
              exactQty: '5.3465',
              qty: '5.3465',
              lineIds: ['ln-4'],
            },
            {
              itemCode: null,
              unit: 'm',
              exactQty: '-12.5',
              qty: '-12.5',
              lineIds: ['ln-5'],
            },
          ],
        },
      ],
    },
  };
}

describe('buildTakeoffReportModel: finalized-only guard (A/C)', () => {
  it('rejects a draft source (no report exists before finalization)', () => {
    const source = finalizedSource();
    (source.document as { status: string }).status = 'draft';
    expect(() => buildTakeoffReportModel({ source })).toThrowError(ReportingError);
    expect(() => buildTakeoffReportModel({ source })).toThrowError(/only a finalized takeoff/);
  });

  it('rejects an archived source', () => {
    const source = finalizedSource();
    (source.document as { status: string }).status = 'archived';
    expect(() => buildTakeoffReportModel({ source })).toThrowError(/only a finalized takeoff/);
  });

  it('rejects a non-ok engine result (a failed finalization has no report)', () => {
    const source = finalizedSource();
    (source.result as unknown as { status: string }).status = 'error';
    expect(() => buildTakeoffReportModel({ source })).toThrowError(/engine result is not ok/);
  });

  it('rejects a snapshot whose bundle identity does not mirror its document', () => {
    const source = finalizedSource();
    (source as { documentId: string }).documentId = 'doc-other';
    expect(() => buildTakeoffReportModel({ source })).toThrowError(/identity does not mirror/);
  });

  it('rejects an input line the engine result does not cover', () => {
    const source = finalizedSource();
    const sheet = source.input.sheets[0] as unknown as { lines: unknown[] };
    sheet.lines.push({
      lineId: 'ln-orphan',
      rowNo: 9,
      description: 'بی‌نتیجه',
      kind: 'addition',
      unit: 'm2',
      quantity: { type: 'manual', value: '1', justification: 'تست' },
    });
    expect(() => buildTakeoffReportModel({ source })).toThrowError(/has no result/);
  });

  it('rejects an engine result line the input does not author (orphan result)', () => {
    const source = finalizedSource();
    (source.result.lines as unknown[]).push({
      lineId: 'ln-ghost',
      sheetId: 'sh-a',
      rowNo: 9,
      itemCode: null,
      unit: 'm2',
      kind: 'addition',
      exactMagnitude: '1',
      signedValue: '1',
      trace: traceNode('1', 'm2'),
    });
    expect(() => buildTakeoffReportModel({ source })).toThrowError(/the snapshot input does not/);
  });

  it('rejects sheet totals referencing an unknown sheet', () => {
    const source = finalizedSource();
    const first = (source.result.sheetTotals as unknown as { sheetId: string }[])[0];
    if (first === undefined) throw new Error('fixture has no sheet totals');
    first.sheetId = 'sh-ghost';
    expect(() => buildTakeoffReportModel({ source })).toThrowError(/unknown sheet/);
  });
});

describe('buildTakeoffReportModel: verbatim copy from the snapshot (B/D/E/F/G/H/I)', () => {
  it('copies metadata verbatim; projectTitle is null unless supplied (never invented)', () => {
    const report = buildTakeoffReportModel({ source: finalizedSource() });
    expect(report.reportId).toBe('takeoff-report-doc-r1');
    expect(report.metadata).toMatchObject({
      reportId: 'takeoff-report-doc-r1',
      documentId: 'doc-r1',
      takeoffId: 'tk-doc-r1',
      projectId: 'proj-1',
      projectTitle: null,
      title: 'ریز متره فاز یک',
      documentNumber: 3,
      status: 'finalized',
      revision: 2,
      createdAt: T0,
      finalizedAt: T2,
      specId: SPEC_ID,
      specVersion: SPEC_VERSION,
      engineVersion: ENGINE_VERSION,
      sheetCount: 2,
      lineCount: 5,
      codedItemCount: 2,
      uncodedItemCount: 2,
    });
    const titled = buildTakeoffReportModel({
      source: finalizedSource(),
      projectTitle: 'برج مسکونی',
    });
    expect(titled.metadata.projectTitle).toBe('برج مسکونی');
    expect(titled.generatedFrom.projectTitle).toBe('برج مسکونی');
  });

  it('honors an explicit reportId (deterministic identity, no randomness inside)', () => {
    const report = buildTakeoffReportModel({
      source: finalizedSource(),
      reportId: 'takeoff-report-doc-r1-rev2',
    });
    expect(report.reportId).toBe('takeoff-report-doc-r1-rev2');
    expect(report.metadata.reportId).toBe('takeoff-report-doc-r1-rev2');
  });

  it('orders sheets in document order and lines by rowNo (§13), not input array order', () => {
    const report = buildTakeoffReportModel({ source: finalizedSource() });
    expect(report.sheets.map((sheet) => sheet.sheetId)).toEqual(['sh-a', 'sh-b']);
    expect(report.sheets[0]?.lines.map((line) => line.lineId)).toEqual(['ln-1', 'ln-2', 'ln-3']);
    expect(report.sheets.map((sheet) => sheet.sheetOrder)).toEqual([1, 2]);
    expect(report.sheets[0]?.lines.map((line) => line.rowNo)).toEqual([1, 2, 3]);
  });

  it('copies every line value verbatim: exact, rounded, signed, factors, notes, trace', () => {
    const report = buildTakeoffReportModel({ source: finalizedSource() });
    const byId = new Map(
      report.sheets.flatMap((sheet) => sheet.lines.map((line) => [line.lineId, line])),
    );
    expect(byId.get('ln-1')).toMatchObject({
      sheetId: 'sh-a',
      sheetName: 'برگه الف',
      sheetOrder: 1,
      rowNo: 1,
      description: 'کف سالن',
      location: 'طبقه اول',
      itemCode: '280101',
      kind: 'addition',
      quantityType: 'ابعادی',
      unit: 'm2',
      exactMagnitude: '14.45',
      roundedMagnitude: null, // no rule matched → null, never fabricated
      signedValue: '14.45',
      floorCount: null, // absent factors are null — never a hidden 1
      similarCount: null,
      manualJustification: null,
      notes: null,
      traceRuleId: RULE_ID,
    });
    expect(byId.get('ln-2')).toMatchObject({
      floorCount: '2',
      similarCount: null,
      exactMagnitude: '20.4',
    });
    expect(byId.get('ln-3')).toMatchObject({
      itemCode: null, // uncoded stays null — never an invented code
      quantityType: 'ارجاع',
      exactMagnitude: '7.225',
    });
    expect(byId.get('ln-4')).toMatchObject({
      quantityType: 'عبارت',
      exactMagnitude: '5.3465',
      roundedMagnitude: '5.35',
      signedValue: '5.35',
    });
    expect(byId.get('ln-5')).toMatchObject({
      kind: 'deduction',
      quantityType: 'دستی',
      exactMagnitude: '12.5',
      roundedMagnitude: null,
      signedValue: '-12.5',
      manualJustification: 'برآورد اجرایی',
      notes: 'برش عرضی',
    });
  });

  it('copies totals verbatim in engine order, with provenance lineIds (E/H)', () => {
    const report = buildTakeoffReportModel({ source: finalizedSource() });
    expect(report.itemTotals).toEqual([
      {
        itemCode: '280101',
        unit: 'm2',
        exactQty: '34.85',
        roundedQty: null,
        qty: '34.85',
        lineIds: ['ln-1', 'ln-2'],
      },
      {
        itemCode: null,
        unit: 'm2',
        exactQty: '7.225',
        roundedQty: null,
        qty: '7.225',
        lineIds: ['ln-3'],
      },
      {
        itemCode: '410202',
        unit: 'm3',
        exactQty: '5.3465',
        roundedQty: '5.3',
        qty: '5.3',
        lineIds: ['ln-4'],
      },
      {
        itemCode: null,
        unit: 'm',
        exactQty: '-12.5',
        roundedQty: null,
        qty: '-12.5',
        lineIds: ['ln-5'],
      },
    ]);
    expect(report.sheetTotals.map((total) => total.sheetId)).toEqual(['sh-a', 'sh-b']);
    expect(report.sheetTotals[0]?.byItem[0]).toMatchObject({
      itemCode: '280101',
      exactQty: '34.85',
      lineIds: ['ln-1', 'ln-2'],
    });
    expect(report.sheetTotals[1]?.byItem[0]).toMatchObject({
      itemCode: '410202',
      exactQty: '5.3465',
      roundedQty: null,
      qty: '5.3465',
    });
    // Rounded never replaces exact: both stay visible side by side.
    expect(report.itemTotals[2]?.exactQty).toBe('5.3465');
    expect(report.itemTotals[2]?.qty).toBe('5.3');
  });

  it('copies the rounding rule set verbatim with §6.3 selector/source rendering', () => {
    const report = buildTakeoffReportModel({ source: finalizedSource() });
    expect(report.rounding).toEqual([
      {
        target: 'line',
        selector: 'کد 410202',
        scale: 2,
        mode: 'HALF_UP',
        sourceStatus: 'design',
        source: 'دفترچه فنی، ۱۴۰۴، صفحه 12، بند ۳',
      },
      {
        target: 'item-total',
        selector: 'واحد m3',
        scale: 1,
        mode: 'HALF_UP',
        sourceStatus: 'design',
        source: null,
      },
    ]);
  });

  it('preserves the full snapshot provenance, detached from the caller (J)', () => {
    const source = finalizedSource();
    const report = buildTakeoffReportModel({ source });
    expect(report.generatedFrom.document.documentId).toBe('doc-r1');
    expect(report.generatedFrom.result.itemTotals).toEqual(source.result.itemTotals);
    expect(report.generatedFrom.input.sheets).toEqual(source.input.sheets);
    // Deep-cloned: later caller-side mutation cannot reach the report.
    (source.result.lines[0] as { exactMagnitude: string }).exactMagnitude = '999';
    expect(report.generatedFrom.result.lines[0]?.exactMagnitude).toBe('14.45');
  });
});

describe('buildTakeoffReportModel: exactness, immutability, determinism (K/M/N/O)', () => {
  it('keeps decimal strings as strings — no Number conversion anywhere (M)', () => {
    const report = buildTakeoffReportModel({ source: finalizedSource() });
    for (const line of report.sheets.flatMap((sheet) => sheet.lines)) {
      expect(typeof line.exactMagnitude).toBe('string');
      expect(typeof line.signedValue).toBe('string');
    }
    // A trailing-zero/long decimal survives verbatim (a Number round-trip would not).
    const source = finalizedSource();
    (source.result.lines[0] as { exactMagnitude: string }).exactMagnitude = '14.45000000000';
    const report2 = buildTakeoffReportModel({ source });
    expect(report2.sheets[0]?.lines[0]?.exactMagnitude).toBe('14.45000000000');
  });

  it('freezes the model deeply — rendering can never mutate it (N)', () => {
    const report = buildTakeoffReportModel({ source: finalizedSource() });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.metadata)).toBe(true);
    expect(Object.isFrozen(report.sheets[0])).toBe(true);
    expect(Object.isFrozen(report.sheets[0]?.lines[0])).toBe(true);
    expect(Object.isFrozen(report.itemTotals)).toBe(true);
    expect(() => {
      (report as unknown as { metadata: { title: string } }).metadata.title = 'دستکاری';
    }).toThrowError();
    expect(() => {
      (report.itemTotals as unknown as { push: (x: unknown) => void }).push({
        itemCode: 'X',
        unit: 'm',
        exactQty: '1',
        roundedQty: null,
        qty: '1',
        lineIds: [],
      });
    }).toThrowError();
  });

  it('is deterministic: the same snapshot builds the same model twice (K)', () => {
    const first = buildTakeoffReportModel({ source: finalizedSource() });
    const second = buildTakeoffReportModel({ source: finalizedSource() });
    expect(first).toEqual(second);
  });
});

describe('takeoffQuantityDisplay: the §6.3 canonical formula column (P)', () => {
  it('renders each quantity form exactly as the grammar prescribes', () => {
    expect(
      takeoffQuantityDisplay({ type: 'dimensional', profile: 'LW', length: '4.25', width: '3.4' }),
    ).toBe('(4.25 × 3.4)');
    // Present factors only: floorCount/similarCount appear when present, never as 1.
    expect(
      takeoffQuantityDisplay({
        type: 'dimensional',
        profile: 'LWH',
        floorCount: '2',
        similarCount: '3',
        length: '4',
        width: '5',
        height: '6',
      }),
    ).toBe('(2 × 3 × 4 × 5 × 6)');
    expect(takeoffQuantityDisplay({ type: 'dimensional', profile: 'count' })).toBe('()');
    expect(
      takeoffQuantityDisplay({
        type: 'reference',
        terms: [
          { lineId: 'ln-1', factor: '0.5', use: 'signed' },
          { lineId: 'ln-2', factor: '-1', use: 'magnitude' },
        ],
      }),
    ).toBe('(0.5 × #ln-1 + -1 × |#ln-2|)');
    expect(
      takeoffQuantityDisplay({
        type: 'expression',
        node: { op: 'const', value: '12.5' },
      }),
    ).toBe('12.5');
    expect(
      takeoffQuantityDisplay({
        type: 'expression',
        node: {
          op: 'sub',
          args: [
            { op: 'ref', lineId: 'ln-1', use: 'signed' },
            { op: 'const', value: '2' },
          ],
        },
      }),
    ).toBe('(#ln-1 - 2)');
    expect(
      takeoffQuantityDisplay({
        type: 'expression',
        node: {
          op: 'round',
          arg: {
            op: 'mul',
            args: [
              { op: 'const', value: '4.25' },
              { op: 'const', value: '3.4' },
              { op: 'const', value: '0.37' },
            ],
          },
          rule: { scale: 2, mode: 'HALF_UP' },
        },
      }),
    ).toBe('round((4.25 × 3.4 × 0.37), 2, HALF_UP)');
    expect(takeoffQuantityDisplay({ type: 'manual', value: '12.5', justification: 'x' })).toBe(
      '12.5',
    );
  });

  it('is the formula the report lines carry (one representation, never parsed back)', () => {
    const report = buildTakeoffReportModel({ source: finalizedSource() });
    const byId = new Map(
      report.sheets.flatMap((sheet) => sheet.lines.map((line) => [line.lineId, line])),
    );
    expect(byId.get('ln-1')?.formula).toBe('(4.25 × 3.4)');
    expect(byId.get('ln-2')?.formula).toBe('(2 × 5.1 × 2)');
    expect(byId.get('ln-3')?.formula).toBe('(0.5 × #ln-1)');
    expect(byId.get('ln-4')?.formula).toBe('round((4.25 × 3.4 × 0.37), 2, HALF_UP)');
    expect(byId.get('ln-5')?.formula).toBe('12.5');
  });
});

describe('takeoff report model type surface', () => {
  it('exposes the model through the package index', () => {
    const report: TakeoffReportModel = buildTakeoffReportModel({ source: finalizedSource() });
    expect(report.metadata.documentId).toBe('doc-r1');
  });
});
