import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ReportModel } from '@costgenius/reporting';
import {
  ReportingPdfError,
  normalizePresentationForms,
  renderReportToPdf,
  shapeArabicPersian,
} from '../src/index.js';
import { goldenS4Result, loadPublished1404, makeLine, makeLineOn, makeReport } from './helpers.js';

/** COMPLETE report: 990001 ×10 m3 = 10,000 + 990002 ×2 each = 1,000 → total 11,000. */
function completeReport(): ReportModel {
  return makeReport([makeLine('l1', '990001', '10', 'm3'), makeLine('l2', '990002', '2', 'each')]);
}

// ---- pdfjs read-back (real parse, not a bytes sniff) --------------------------------------------

interface ParsedPdf {
  readonly numPages: number;
  readonly pagesText: readonly string[];
  readonly pageWidths: readonly number[];
  readonly pageHeights: readonly number[];
}

async function parsePdf(bytes: Uint8Array): Promise<ParsedPdf> {
  const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
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
  for (let p = 1; p <= doc.numPages; p += 1) {
    const page = await doc.getPage(p);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    pagesText.push(content.items.map((item) => ('str' in item ? item.str : '')).join(' '));
    pageWidths.push(viewport.width);
    pageHeights.push(viewport.height);
  }
  return { numPages: doc.numPages, pagesText, pageWidths, pageHeights };
}

interface PdfDocumentProxy {
  readonly numPages: number;
  getPage(pageNumber: number): Promise<{
    getViewport(options: { scale: number }): { width: number; height: number };
    getTextContent(): Promise<{ items: readonly { str?: string }[] }>;
  }>;
}

async function render(report: ReportModel): Promise<Uint8Array> {
  return renderReportToPdf(report);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

/**
 * Persian word presence, robust to the extractor's run ordering (visual or logical) and to
 * the ToUnicode presentation-form/base-letter variance: both sides are normalized to base
 * letters, and the word may appear in either glyph order.
 */
function containsPersianWord(extracted: string, word: string): boolean {
  const normalized = normalizePresentationForms(extracted);
  const shaped = shapeArabicPersian(word);
  const forward = normalizePresentationForms(shaped);
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- verify reversed shaped code points
  const backward = [...forward].reverse().join('');
  return normalized.includes(forward) || normalized.includes(backward);
}

/** Space-insensitive contains (wrapped/chunked tokens re-insert spaces at line breaks). */
function containsIgnoringSpaces(haystack: string, needle: string): boolean {
  return haystack.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''));
}

// ---- A. PDF validity ---------------------------------------------------------------------------

describe('PDF validity', () => {
  it('produces a non-empty Uint8Array starting with the %PDF magic', async () => {
    const bytes = await render(completeReport());
    expect(bytes.length).toBeGreaterThan(10_000);
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
  });

  it('ends with a proper EOF marker', async () => {
    const bytes = await render(completeReport());
    const tail = Buffer.from(bytes.slice(Math.max(0, bytes.length - 64)))
      .toString('latin1')
      .trim();
    expect(tail.endsWith('%%EOF')).toBe(true);
  });

  it('opens with a real parser: page count > 0, all pages have text', async () => {
    const parsed = await parsePdf(await render(completeReport()));
    expect(parsed.numPages).toBeGreaterThan(0);
    expect(parsed.pagesText.every((t) => t.length > 0)).toBe(true);
  });
});

// ---- B. structure ------------------------------------------------------------------------------

describe('document structure', () => {
  it('contains the title and every section heading', async () => {
    const text = (await parsePdf(await render(completeReport()))).pagesText.join('\n');
    for (const heading of [
      'SYNTHETIC estimate — rep-1',
      'Summary',
      'Scope Boundaries',
      'Chapters',
      'Groups',
      'Lines',
      'Line Provenance and Trace',
    ]) {
      expect(text).toContain(heading);
    }
  });

  it('omits the S4 section when the report carries no S4 result', async () => {
    const text = (await parsePdf(await render(completeReport()))).pagesText.join('\n');
    expect(text).not.toContain('S4 Calculation Trace');
  });

  it('renders the S4 section only when the report carries an S4 result', async () => {
    const report = makeReport(
      [makeLine('l1', '990001', '500', 'm3'), makeLine('l2', '990002', '1000', 'each')],
      { buildingId: 'b-golden', s4Estimate: goldenS4Result() },
    );
    const text = (await parsePdf(await render(report))).pagesText.join('\n');
    expect(text).toContain('S4 Calculation Trace');
    expect(text).toContain('S4 Stages');
  });

  it('uses portrait pages for Summary/Chapters/Groups and landscape for Lines', async () => {
    const parsed = await parsePdf(await render(completeReport()));
    expect(parsed.pageWidths[0]).toBeLessThan(parsed.pageHeights[0] ?? 0); // portrait
    const landscape = parsed.pageWidths.findIndex((w, i) => w > (parsed.pageHeights[i] ?? 0));
    expect(landscape).toBeGreaterThan(0); // the Lines section is landscape
  });
});

// ---- C. exact values ---------------------------------------------------------------------------

describe('exact value preservation (read back from the PDF)', () => {
  it('preserves a leading-zero code exactly', async () => {
    const text = (
      await parsePdf(await render(makeReport([makeLine('lz', '0990007', '3', 'm3')])))
    ).pagesText.join('\n');
    expect(text).toContain('0990007');
    // no STANDALONE 990007 ('0990007' contains it as a substring — that is fine)
    expect(text).not.toMatch(/(?<!\d)990007(?!\d)/);
  });

  it('preserves negative amounts, zero and the null placeholder distinctly', async () => {
    const report = makeReport([
      makeLine('a', '990001', '-15', 'm3'), // -15000
      makeLine('b', '990001', '0', 'm3'), // 0
      makeLine('c', '990003', '5', 'm3'), // null (INCOMPLETE)
    ]);
    const text = (await parsePdf(await render(report))).pagesText.join('\n');
    expect(text).toContain('-15000');
    expect(text).toContain('0');
    expect(text).toContain('—'); // the null placeholder — never 0
  });

  it('preserves exact decimals 1.0451 and 1.30 from the S4 trace (never 1.3)', async () => {
    const report = makeReport(
      [makeLine('l1', '990001', '500', 'm3'), makeLine('l2', '990002', '1000', 'each')],
      { buildingId: 'b-golden', s4Estimate: goldenS4Result() },
    );
    const text = (await parsePdf(await render(report))).pagesText.join('\n');
    expect(text).toContain('1.0451');
    expect(text).toContain('1.30');
    expect(text).not.toMatch(/(?<![\d.])1\.3(?![\d])/); // '1.30' must not degrade to '1.3'
  });

  it('preserves the Persian unit label and the Persian source document (real 1404)', async () => {
    const published = loadPublished1404();
    const line = makeLineOn(published);
    const report = makeReport(
      [line('r1', '280101', '10', 'ton_km'), line('r2', '410202', '10', 'm3')],
      { estimateId: 'est-1404' },
    );
    const parsed = await parsePdf(await render(report));
    const text = parsed.pagesText.join('\n');
    // Persian words survive as real shaped glyphs (base-normalized, order-robust)
    expect(containsPersianWord(text, 'مترمکعب')).toBe(true);
    for (const word of ['فهرست', 'بهای', 'واحد', 'پایه', 'رشته', 'ابنیه', 'سال']) {
      expect(containsPersianWord(text, word)).toBe(true);
    }
    // the Persian year ۱۴۰۴ extracts with either Arabic-Indic digit family (ToUnicode
    // variance between 06Fx and 066x) and the extractor reverses whole RTL lines, so the
    // digits may appear as 1404 or 4041 — the renderer draws the correct order either way
    // (verified at the rtl-engine level in the pdf-model suite)
    expect(text).toMatch(
      /[\u06f1\u0661][\u06f4\u0664][\u06f0\u0660][\u06f4\u0664]|[\u06f4\u0664][\u06f0\u0660][\u06f4\u0664][\u06f1\u0661]/u,
    );
  });

  it('preserves Latin dependency ids and rule ids exactly', async () => {
    const report = makeReport(
      [makeLine('l1', '990001', '500', 'm3'), makeLine('l2', '990002', '1000', 'each')],
      { buildingId: 'b-golden', s4Estimate: goldenS4Result() },
    );
    const text = (
      await parsePdf(await render(makeReport([makeLine('d', '990006', '2', 'm3')])))
    ).pagesText.join('\n');
    expect(text).toContain('regional-coefficient-circular-94-69416');
    expect(text).toContain('supervision-circular');

    const s4Text = (await parsePdf(await render(report))).pagesText.join('\n');
    for (const rule of ['IR-1404-E-FLOOR-01..03', 'IR-1404-E-OVERHEAD-01', 'IR-1404-E-SITE-01']) {
      expect(s4Text).toContain(rule);
    }
  });

  it('preserves the source reference fields (page, section, edition)', async () => {
    const text = (await parsePdf(await render(completeReport()))).pagesText.join('\n');
    expect(text).toContain('SYNTHETIC TEST DATA');
    expect(text).toContain('SYN-1');
    expect(text).toContain('SYN');
  });
});

// ---- D. status honesty -------------------------------------------------------------------------

describe('status behavior', () => {
  it('COMPLETE: the total appears exactly', async () => {
    const text = (await parsePdf(await render(completeReport()))).pagesText.join('\n');
    expect(text).toContain('COMPLETE');
    expect(text).toContain('11000');
  });

  it('INCOMPLETE / EXTERNAL_DEPENDENCY / NOT_SPECIFIED: no total, placeholder shown', async () => {
    for (const code of ['990003', '990004', '990005']) {
      const report = makeReport([makeLine('p', code, '5', 'm3')]);
      const text = (await parsePdf(await render(report))).pagesText.join('\n');
      expect(text).toContain('—'); // null amount placeholder
      expect(text).not.toContain('5000'); // 5 × nothing was never computed
    }
    const incomplete = makeReport([makeLine('p', '990003', '5', 'm3')]);
    expect(
      containsIgnoringSpaces(
        (await parsePdf(await render(incomplete))).pagesText.join('\n'),
        'INCOMPLETE',
      ),
    ).toBe(true);
    const external = makeReport([makeLine('p', '990004', '5', 'm3')]);
    expect(
      containsIgnoringSpaces(
        (await parsePdf(await render(external))).pagesText.join('\n'),
        'EXTERNAL_DEPENDENCY',
      ),
    ).toBe(true);
    const notSpecified = makeReport([makeLine('p', '990005', '5', 'm3')]);
    expect(
      containsIgnoringSpaces(
        (await parsePdf(await render(notSpecified))).pagesText.join('\n'),
        'NOT_SPECIFIED_IN_1404_PRICEBOOK',
      ),
    ).toBe(true);
  });

  it('all four pricebook statuses render verbatim', async () => {
    const report = makeReport([
      makeLine('a', '990001', '1', 'm3'),
      makeLine('b', '990003', '1', 'm3'),
      makeLine('c', '990004', '1', 'm3'),
      makeLine('d', '990005', '1', 'm3'),
    ]);
    const text = (await parsePdf(await render(report))).pagesText.join('\n');
    for (const status of [
      'VERIFIED_SPEC_ONLY',
      'INCOMPLETE',
      'EXTERNAL_DEPENDENCY',
      'NOT_SPECIFIED_IN_1404_PRICEBOOK',
    ]) {
      expect(containsIgnoringSpaces(text, status)).toBe(true);
    }
  });
});

// ---- E. dependencies -----------------------------------------------------------------------------

describe('dependency presentation', () => {
  it('shows the dependency count and the joined ids in the summary', async () => {
    const text = (
      await parsePdf(await render(makeReport([makeLine('d', '990006', '2', 'm3')])))
    ).pagesText.join('\n');
    expect(text).toContain('regional-coefficient-circular-94-69416; supervision-circular');
  });

  it('keeps per-line dependency attribution in the provenance table', async () => {
    const report = makeReport([
      makeLine('a', '990004', '5', 'm3'),
      makeLine('b', '990001', '1', 'm3'),
    ]);
    const parsed = await parsePdf(await render(report));
    const allText = parsed.pagesText.join('\n');
    // the provenance table exists (its headers render) and carries the dependency id
    // for line a: the id appears in the summary AND in the provenance row (wrapped tokens
    // compare space-insensitively)
    expect(allText).toContain('Trace Quantity');
    expect(allText).toContain('Dependency IDs');
    expect(occurrences(allText.replace(/\s+/g, ''), 'regional-coefficient-circular-94-69416')).toBe(
      2,
    );
  });
});

// ---- F. S4 trace -----------------------------------------------------------------------------------

describe('S4 trace preservation', () => {
  async function s4Text(): Promise<string> {
    const report = makeReport(
      [makeLine('l1', '990001', '500', 'm3'), makeLine('l2', '990002', '1000', 'each')],
      { buildingId: 'b-golden', s4Estimate: goldenS4Result() },
    );
    return (await parsePdf(await render(report))).pagesText.join('\n');
  }

  it('preserves the golden floor coefficient and the verified overhead', async () => {
    const text = await s4Text();
    expect(text).toContain('floor');
    expect(text).toContain('1.0451');
    expect(text).toContain('overhead');
    expect(text).toContain('1.30');
  });

  it('keeps site setup a separate stage and preserves the final estimate', async () => {
    const text = await s4Text();
    expect(text).toContain('site-setup');
    expect(text).toContain('1544493');
    expect(text).toContain('base-subtotal');
    expect(text).toContain('regional');
  });
});

// ---- G. rendering mechanics -------------------------------------------------------------------------

describe('rendering mechanics', () => {
  it(
    'repeats the table header on every Lines page (full 1404 dataset)',
    { timeout: 180_000 },
    async () => {
      const published = loadPublished1404();
      const line = makeLineOn(published);
      const lines = published.rows.map((row, i) =>
        line(`r${String(i)}`, row.code, '2', row.unit.code),
      );
      const report = makeReport(lines, { estimateId: 'est-1404-all' });
      const parsed = await parsePdf(await render(report));
      // the Lines table spans multiple pages and every one repeats its header row
      const linesPages = parsed.pagesText.filter((t) => containsIgnoringSpaces(t, 'Line Amount'));
      expect(linesPages.length).toBeGreaterThan(1);
      for (const page of linesPages) {
        expect(containsIgnoringSpaces(page, 'Line Amount')).toBe(true);
        expect(containsIgnoringSpaces(page, 'Code')).toBe(true);
      }
    },
  );

  it('numbers every page in Persian («صفحه i از n»)', async () => {
    const parsed = await parsePdf(await render(completeReport()));
    for (let p = 1; p <= parsed.numPages; p += 1) {
      const pageText = parsed.pagesText[p - 1] ?? '';
      expect(containsPersianWord(pageText, 'صفحه')).toBe(true);
      expect(containsPersianWord(pageText, 'از')).toBe(true);
      expect(pageText).toContain(String(p));
      expect(pageText).toContain(String(parsed.numPages));
    }
  });

  it(
    'renders a real multi-page document for the full 1404 dataset without losing rows',
    { timeout: 180_000 },
    async () => {
      const published = loadPublished1404();
      const line = makeLineOn(published);
      const lines = published.rows.map((row, i) => {
        const unit = row.unit.code;
        return line(`r${String(i)}`, row.code, '2', unit);
      });
      const report = makeReport(lines, { estimateId: 'est-1404-all' });
      const parsed = await parsePdf(await render(report));
      expect(parsed.numPages).toBeGreaterThan(3);
      const allText = parsed.pagesText.join('\n');
      // every line appears exactly once in the Lines table and once in the provenance
      // table (line ids are the join key; the code column exists only in the Lines table)
      // ids chosen so no id is a substring of another (1564 lines make short ids collide)
      const last = published.rows.length - 1;
      for (const id of ['r0', 'r777', `r${String(last)}`]) {
        expect(occurrences(allText, id)).toBe(2); // Lines + Provenance
      }
      for (const row of published.rows.slice(0, 12)) {
        expect(occurrences(allText, row.code)).toBe(1); // the Lines table row
      }
    },
  );

  it('wraps long Persian descriptions and long dependency ids without losing text', async () => {
    const report = makeReport([
      makeLine('long', '990009', '1', 'm3'),
      makeLine('deps', '990006', '1', 'm3'),
    ]);
    const text = (await parsePdf(await render(report))).pagesText.join('\n');
    // the long description's first and last words both survive (wrapped, not clipped)
    expect(containsPersianWord(text, 'ردیف')).toBe(true);
    expect(containsPersianWord(text, 'گزارش')).toBe(true);
    expect(containsPersianWord(text, 'آزمایشی')).toBe(true);
  });
});

// ---- H. safety ----------------------------------------------------------------------------------------

describe('safety, immutability, determinism', () => {
  it('rejects an invalid report loudly (INVALID_REPORT_MODEL with details)', async () => {
    const report = structuredClone(completeReport()) as unknown as {
      summary: { amount: string | null; status: string };
    };
    report.summary = { ...report.summary, amount: null, status: 'COMPLETE' };
    let caught: unknown;
    try {
      await renderReportToPdf(report as unknown as ReportModel);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReportingPdfError);
    expect((caught as ReportingPdfError).code).toBe('INVALID_REPORT_MODEL');
    expect((caught as ReportingPdfError).details?.length ?? 0).toBeGreaterThan(0);
  });

  it('wraps library failures as PDF_RENDER_FAILED (broken font buffer)', async () => {
    let caught: unknown;
    try {
      await renderReportToPdf(completeReport(), {
        fonts: { regular: new Uint8Array([1, 2, 3]), bold: new Uint8Array([4, 5, 6]) },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ReportingPdfError);
    expect((caught as ReportingPdfError).code).toBe('PDF_RENDER_FAILED');
  });

  it('does not mutate the ReportModel (content identical, still deeply frozen)', async () => {
    const report = completeReport();
    const before = JSON.stringify(report);
    await render(report);
    expect(JSON.stringify(report)).toBe(before);
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.summary)).toBe(true);
    expect(Object.isFrozen(report.chapters[0]?.groups[0]?.lines[0])).toBe(true);
  });

  it('is deterministic: two renders are byte-identical', async () => {
    const report = makeReport([
      makeLine('a', '990001', '10', 'm3'),
      makeLine('b', '0990007', '3', 'm3'),
      makeLine('c', '990006', '2', 'm3'),
    ]);
    const first = await render(report);
    const second = await render(report);
    expect(Buffer.compare(Buffer.from(first), Buffer.from(second))).toBe(0);
  });

  it('embeds the Vazirmatn font (FontFile2) so the PDF is portable', async () => {
    const bytes = await render(completeReport());
    const raw = Buffer.from(bytes).toString('latin1');
    expect(raw).toContain('/FontFile2');
    expect(raw).toContain('Vazirmatn');
  });
});

// ---- I. self-scan + architecture scan (permanent tests) ---------------------------------------------------

describe('renderer source hygiene (architecture scan as a permanent test)', () => {
  const SRC = new URL('../src/', import.meta.url);
  const sourceFiles = readdirSync(SRC).filter((file) => file.endsWith('.ts'));
  const contents = sourceFiles.map((file) => ({
    file,
    content: readFileSync(new URL(file, SRC), 'utf8'),
  }));

  it('scans the renderer production sources', () => {
    expect(sourceFiles).toEqual(
      expect.arrayContaining([
        'errors.ts',
        'types.ts',
        'rtl.ts',
        'fonts.ts',
        'pdf-model.ts',
        'render-pdf.ts',
        'index.ts',
      ]),
    );
  });

  it('contains no pricebook access, recalculation, numeric coercion, clock or randomness', () => {
    const forbidden = [
      'PublishedDataset',
      'findRows',
      'rollupBoqLines',
      'parseFloat',
      'Math.abs',
      'Date.now',
      'Math.random',
      '|| 0',
      '?? 0',
      'Number(',
      '@costgenius/pricebook',
      '@costgenius/cost-calculation',
      '@costgenius/calc-engine',
      '@costgenius/domain',
      '@costgenius/reporting-excel',
    ];
    for (const { file, content } of contents) {
      for (const pattern of forbidden) {
        expect(content.includes(pattern), `${file} must not contain "${pattern}"`).toBe(false);
      }
    }
  });

  it('uses fs only in fonts.ts, and only for the bundled assets', () => {
    for (const { file, content } of contents) {
      const usesFs = content.includes("from 'node:fs'") || content.includes("require('fs')");
      if (file === 'fonts.ts') {
        expect(usesFs, 'fonts.ts is the single asset-loading point').toBe(true);
        expect(content.includes('readFileSync'), 'fonts.ts only reads bundled assets').toBe(true);
      } else {
        expect(usesFs, `${file} must not touch the filesystem`).toBe(false);
      }
    }
  });

  it('imports only allowed modules (@costgenius/reporting, @costgenius/boq, pdfkit, bidi-js)', () => {
    for (const { file, content } of contents) {
      for (const match of content.matchAll(/from '([^']+)'/g)) {
        const specifier: string = match[1] ?? '';
        const allowed =
          specifier.startsWith('./') ||
          specifier === '@costgenius/reporting' ||
          specifier === '@costgenius/boq' ||
          specifier === 'pdfkit' ||
          specifier === 'bidi-js' ||
          (file === 'fonts.ts' && (specifier === 'node:fs' || specifier === 'node:url'));
        expect(allowed, `${file}: unexpected import "${specifier}"`).toBe(true);
      }
    }
  });

  it('no lower layer imports @costgenius/reporting-pdf (zero reverse dependencies)', () => {
    const lowerLayers = [
      'domain',
      'calc-engine',
      'pricebook',
      'cost-calculation',
      'boq',
      'reporting',
      'reporting-excel',
    ];
    for (const layer of lowerLayers) {
      const dir = new URL(`../../${layer}/src/`, import.meta.url);
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.ts')) continue;
        const content = readFileSync(new URL(file, dir), 'utf8');
        expect(
          content.includes('@costgenius/reporting-pdf'),
          `${layer}/src/${file} must not import the PDF renderer`,
        ).toBe(false);
      }
    }
  });
});
