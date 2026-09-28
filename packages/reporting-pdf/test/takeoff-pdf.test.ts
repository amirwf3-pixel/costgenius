import { describe, expect, it } from 'vitest';
import { buildTakeoffReportModel, type TakeoffReportSource } from '@costgenius/reporting';
import {
  buildTakeoffPdfDocumentModel,
  normalizePresentationForms,
  renderTakeoffReportToPdf,
  ReportingPdfError,
  shapeArabicPersian,
} from '../src/index.js';

// -------------------------------------------------------------------------------------------------
// A hand-written, engine-faithful FINALIZED snapshot (the same fixture shape the reporting
// package tests use — renderer tests keep their own copy by repo convention). Every value
// is exactly what the engine persists; nothing here is recalculated.
// -------------------------------------------------------------------------------------------------

const T0 = '2026-01-01T00:00:00Z';
const T2 = '2026-01-03T00:00:00Z';
const RULE_ID = 'CG-IR-MEASUREMENT-SPEC@0.2.0#multiply';

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
              itemCode: null,
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
        },
      ],
    },
    result: {
      specId: 'CG-IR-MEAS',
      specVersion: '0.2.0',
      engineVersion: '0.2.0',
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
          trace: { op: 'multiply', value: '14.45', unit: 'm2', ruleId: RULE_ID, inputs: [] },
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
          trace: { op: 'multiply', value: '7.225', unit: 'm2', ruleId: RULE_ID, inputs: [] },
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
          trace: { op: 'round', value: '5.3465', unit: 'm3', ruleId: RULE_ID, inputs: [] },
        },
      ],
      itemTotals: [
        {
          itemCode: '280101',
          unit: 'm2',
          exactQty: '14.45',
          qty: '14.45',
          lineIds: ['ln-1'],
        },
        { itemCode: null, unit: 'm2', exactQty: '7.225', qty: '7.225', lineIds: ['ln-3'] },
        {
          itemCode: '410202',
          unit: 'm3',
          exactQty: '5.3465',
          roundedQty: '5.3',
          qty: '5.3',
          lineIds: ['ln-4'],
        },
      ],
      sheetTotals: [
        {
          sheetId: 'sh-a',
          byItem: [
            { itemCode: '280101', unit: 'm2', exactQty: '14.45', qty: '14.45', lineIds: ['ln-1'] },
            { itemCode: null, unit: 'm2', exactQty: '7.225', qty: '7.225', lineIds: ['ln-3'] },
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
          ],
        },
      ],
    },
  };
}

function takeoffReport() {
  return buildTakeoffReportModel({ source: finalizedSource(), projectTitle: 'برج مسکونی' });
}

// ---- pdfjs read-back (real parse, not a bytes sniff) --------------------------------------------

interface ParsedPdf {
  readonly numPages: number;
  readonly pagesText: readonly string[];
  readonly pageWidths: readonly number[];
  readonly pageHeights: readonly number[];
  readonly info: {
    readonly Title?: unknown;
    readonly Creator?: unknown;
    readonly Producer?: unknown;
  };
}

interface PdfDocumentProxy {
  readonly numPages: number;
  getMetadata(): Promise<{ info: Record<string, unknown> }>;
  getPage(pageNumber: number): Promise<{
    getViewport(options: { scale: number }): { width: number; height: number };
    getTextContent(): Promise<{ items: readonly { str?: string }[] }>;
  }>;
}

async function parsePdf(bytes: Uint8Array): Promise<ParsedPdf> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as unknown as {
    getDocument: (options: {
      data: Uint8Array;
      isEvalSupported: boolean;
      useSystemFonts: boolean;
    }) => { promise: Promise<PdfDocumentProxy> };
  };
  const doc = await pdfjs.getDocument({
    data: bytes,
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  const pagesText: string[] = [];
  const pageWidths: number[] = [];
  const pageHeights: number[] = [];
  const { info } = await doc.getMetadata();
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pagesText.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
    pageWidths.push(viewport.width);
    pageHeights.push(viewport.height);
  }
  return { numPages: doc.numPages, pagesText, pageWidths, pageHeights, info };
}

function containsPersianWord(extracted: string, word: string): boolean {
  const normalized = normalizePresentationForms(extracted);
  const shaped = shapeArabicPersian(word);
  const forward = normalizePresentationForms(shaped);
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- verify reversed shaped code points
  const backward = [...forward].reverse().join('');
  return normalized.includes(forward) || normalized.includes(backward);
}

function containsIgnoringSpaces(haystack: string, needle: string): boolean {
  return haystack.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''));
}

// ---- document model -----------------------------------------------------------------------------

describe('takeoff PDF document model', () => {
  it('fails loudly on a structurally invalid model (nothing is repaired)', () => {
    // The built model is deeply frozen (verified in the reporting package), so the
    // invalid copy is made through structuredClone — an unfrozen deep copy.
    const report = structuredClone(takeoffReport());
    (report.metadata as { status: string }).status = 'draft';
    expect(() => buildTakeoffPdfDocumentModel(report)).toThrowError(ReportingPdfError);
    expect(() => buildTakeoffPdfDocumentModel(report)).toThrowError(
      /failed the renderer structural validation/,
    );
    const orphan = structuredClone(takeoffReport()) as unknown as {
      sheets: { lines: unknown[] }[];
    };
    const firstSheet = orphan.sheets[0];
    if (firstSheet === undefined) throw new Error('fixture has no sheets');
    firstSheet.lines = firstSheet.lines.slice(0, 1); // line without result
    expect(() => buildTakeoffPdfDocumentModel(orphan as never)).toThrowError(ReportingPdfError);
  });

  it('builds the fixed V1 section order: خلاصه (portrait) → متره تفصیلی (landscape) → جمع‌ها (portrait)', () => {
    const model = buildTakeoffPdfDocumentModel(takeoffReport());
    expect(model.sections.map((section) => section.orientation)).toEqual([
      'portrait',
      'landscape',
      'portrait',
    ]);
    const allText = JSON.stringify(model.sections);
    expect(allText).toContain('گزارش صورت‌برداشت — ریز متره فاز یک');
    expect(allText).toContain('متره تفصیلی');
    expect(allText).toContain('جمع آیتم‌ها');
    expect(allText).toContain('برگهٔ 1 — برگه الف');
    expect(allText).toContain('برگهٔ 2 — برگه ب');
    expect(allText).toContain('مقدار دقیق');
    expect(allText).toContain('مقدار گردشده');
    expect(allText).toContain('مقدار مؤثر (انتقال)');
  });

  it('renders the uncoded label «بدون کد» — never an invented code, never a dropped row', () => {
    const model = buildTakeoffPdfDocumentModel(takeoffReport());
    const allText = JSON.stringify(model.sections);
    expect(allText).toContain('بدون کد');
    expect(allText).not.toContain('"itemCode":"UNKNOWN');
  });

  it('shows rounded next to exact — the exact value is never replaced', () => {
    const model = buildTakeoffPdfDocumentModel(takeoffReport());
    const allText = JSON.stringify(model.sections);
    expect(allText).toContain('5.3465'); // exact survives
    expect(allText).toContain('5.35'); // line rounded
    expect(allText).toContain('5.3'); // item-total rounded
    expect(allText).toContain('14.45');
  });

  it('never invents a document total (no such aggregation exists in S1)', () => {
    const model = buildTakeoffPdfDocumentModel(takeoffReport());
    const text = JSON.stringify(model.sections);
    // The only totals are itemTotals and per-sheet byItem; a document total would need
    // cross-unit addition, which the spec forbids.
    expect(text).not.toContain('جمع کل سند');
    expect(text).not.toContain('جمع کل گزارش');
  });
});

// ---- rendered PDF (S: structure, T: tables) ------------------------------------------------------

describe('takeoff PDF render', () => {
  it('produces a real, parsable PDF with A4 pages (magic + pdfjs read-back)', async () => {
    const bytes = await renderTakeoffReportToPdf(takeoffReport());
    expect(bytes.length).toBeGreaterThan(1000);
    const magic = Buffer.from(bytes.slice(0, 5)).toString('latin1');
    expect(magic).toBe('%PDF-');
    const parsed = await parsePdf(bytes);
    expect(parsed.numPages).toBeGreaterThanOrEqual(3);
    for (const [index, width] of parsed.pageWidths.entries()) {
      const height = parsed.pageHeights[index] ?? 0;
      const isA4Portrait = Math.abs(width - 595.28) < 1 && Math.abs(height - 841.89) < 1;
      const isA4Landscape = Math.abs(width - 841.89) < 1 && Math.abs(height - 595.28) < 1;
      expect(isA4Portrait || isA4Landscape).toBe(true);
    }
  });

  it('carries the header contract: identity, document number, status, finalization, spec, engine', async () => {
    const parsed = await parsePdf(await renderTakeoffReportToPdf(takeoffReport()));
    const text = parsed.pagesText.join('\n');
    expect(parsed.info.Creator).toBe('CostGenius'); // the brand lives in the info dictionary
    expect(parsed.info.Producer).toBe('CostGenius');
    expect(String(parsed.info.Title)).toContain('گزارش صورت‌برداشت');
    expect(text).toContain('doc-r1');
    expect(text).toContain('tk-doc-r1');
    // Persian title words survive as real shaped glyphs (base-normalized, order-robust)
    for (const word of ['گزارش', 'صورت‌برداشت', 'ریز', 'متره', 'فاز']) {
      expect(containsPersianWord(text, word)).toBe(true);
    }
    expect(text).toContain('3'); // documentNumber
    expect(containsPersianWord(text, 'نهایی‌شده')).toBe(true);
    expect(text).toContain(T2);
    expect(text).toContain('CG-IR-MEAS@0.2.0');
    expect(text).toContain('proj-1');
    // project title words (when supplied) survive as shaped glyphs
    expect(containsPersianWord(text, 'برج')).toBe(true);
    expect(containsPersianWord(text, 'مسکونی')).toBe(true);
  });

  it('carries per-line detail: formula (§6.3), exact, rounded, signed, unit, kind', async () => {
    const text = (await parsePdf(await renderTakeoffReportToPdf(takeoffReport()))).pagesText.join(
      '\n',
    );
    expect(containsIgnoringSpaces(text, 'round((4.25 × 3.4 × 0.37), 2, HALF_UP)')).toBe(true);
    expect(containsIgnoringSpaces(text, '(4.25 × 3.4)')).toBe(true);
    expect(containsIgnoringSpaces(text, '(0.5 × #ln-1)')).toBe(true);
    expect(text).toContain('14.45');
    expect(text).toContain('7.225');
    expect(text).toContain('5.3465');
    expect(text).toContain('5.35');
    expect(text).toContain('ln-1');
    expect(text).toContain('ln-4');
    expect(text).toContain('m2');
    expect(text).toContain('m3');
    expect(containsPersianWord(text, 'افزایش')).toBe(true);
    expect(containsPersianWord(text, 'کف')).toBe(true); // description words survive shaping
    expect(containsPersianWord(text, 'دال')).toBe(true);
  });

  it('carries totals with provenance lineIds and the uncoded label (E/H)', async () => {
    const text = (await parsePdf(await renderTakeoffReportToPdf(takeoffReport()))).pagesText.join(
      '\n',
    );
    // Item totals: exact + rounded + effective side by side, contributing lineIds joined.
    expect(text).toContain('5.3465');
    expect(text).toContain('5.35');
    expect(text).toContain('5.3');
    expect(containsIgnoringSpaces(text, 'ln-1، ln-2')).toBe(false); // this fixture has single-line groups…
    expect(containsIgnoringSpaces(text, 'ln-4')).toBe(true); // …and single contributing ids stay visible
    // Uncoded items stay visible with the fixed label.
    expect(containsPersianWord(text, 'بدون')).toBe(true);
    expect(containsPersianWord(text, 'کد')).toBe(true);
    // Sheet names appear in the sheet-total section too.
    expect(containsPersianWord(text, 'برگه')).toBe(true);
    expect(containsPersianWord(text, 'جمع')).toBe(true);
  });

  it('explains the exact/rounded/effective semantics in the summary section', async () => {
    const text = (await parsePdf(await renderTakeoffReportToPdf(takeoffReport()))).pagesText.join(
      '\n',
    );
    expect(containsPersianWord(text, 'مرجع')).toBe(true);
    expect(containsPersianWord(text, 'گردشده')).toBe(true);
    expect(containsPersianWord(text, 'مؤثر')).toBe(true);
  });

  it('is byte-deterministic: two renders of the same model are identical', async () => {
    const first = await renderTakeoffReportToPdf(takeoffReport());
    const second = await renderTakeoffReportToPdf(takeoffReport());
    expect(Buffer.from(first).equals(Buffer.from(second))).toBe(true);
  });
});
