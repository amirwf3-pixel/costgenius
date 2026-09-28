import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { normalizePresentationForms, shapeArabicPersian } from '@costgenius/reporting-pdf';
import {
  addEstimateLines,
  createEstimateForProject,
  createProject,
  finalizeEstimate,
  renderEstimateExcel,
  renderEstimatePdf,
  startEstimateVersion,
} from '../src/index.js';
import {
  BUILDING_ID,
  COMPLETE_LINE_INPUTS,
  COMPLETE_S4_EXPECTED,
  ESTIMATE_ID,
  FIXED_INSTANT,
  OFFICIAL_SOURCE_HASH,
  PROJECT_ID,
  goldenCoefficients,
  loadPublished1404,
} from './helpers.js';

const dataset = loadPublished1404();

function finalizedWorkflow() {
  const project = createProject({ projectId: PROJECT_ID, title: 'p', createdAt: FIXED_INSTANT });
  const estimate = createEstimateForProject(project, { estimateId: ESTIMATE_ID, title: 't' });
  const started = startEstimateVersion(dataset, estimate, {
    createdAt: FIXED_INSTANT,
    buildingId: BUILDING_ID,
  });
  const added = addEstimateLines(dataset, started, `${ESTIMATE_ID}-v1`, COMPLETE_LINE_INPUTS);
  if (!added.ok) throw new Error('fixture lines must resolve');
  return finalizeEstimate(
    added.estimate,
    `${ESTIMATE_ID}-v1`,
    goldenCoefficients('1.1', COMPLETE_S4_EXPECTED.afterOverhead, '12000000'),
    {
      reportId: 'rep-prov',
      generatedAt: FIXED_INSTANT,
      finalizedAt: FIXED_INSTANT,
    },
  );
}

describe('R/S. source provenance survives the whole chain', () => {
  it('Pricebook → S2/S3 → BOQ line → ReportModel: every sourceRef field is intact', () => {
    const finalized = finalizedWorkflow();
    const l1 = finalized.calculation.reportModel.chapters
      .find((c) => c.chapter === 'chapter-1')
      ?.groups.flatMap((g) => g.lines)
      .find((l) => l.lineId === 'l1');
    expect(l1).toBeDefined();
    expect(l1?.pricebookCode).toBe('010101');
    expect(l1?.sourceRef.sourceDocument).toBe('فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴');
    expect(l1?.sourceRef.edition).toBe('1404');
    expect(l1?.sourceRef.printedPage).toBe('11');
    expect(l1?.sourceRef.section).toBe('Chapter 1, Group 1');
    expect(l1?.sourceRef.sourceFileHash).toBe(OFFICIAL_SOURCE_HASH);
    expect(l1?.edition).toBe('1404');
    expect(l1?.pricebookStatus).toBe('VERIFIED_SPEC_ONLY');
  });

  it('the finalized estimate can be traced back: report → version → line → pricebook row → source', () => {
    const finalized = finalizedWorkflow();
    // report → version
    const version = finalized.estimate.versions.find((v) => v.versionId === finalized.versionId);
    expect(version).toBeDefined();
    // version → line → pricebook row (still byte-identical to the published dataset)
    const line = version?.lines.find((l) => l.lineId === 'l1');
    const row = dataset.getRow(line?.pricebookCode ?? '');
    expect(row).toBeDefined();
    expect(line?.basePrice).toBe(row?.basePrice);
    expect(line?.sourceRef).toEqual(row?.sourceRef);
    expect(line?.description).toBe(row?.description);
    // line → calculation trace
    expect(line?.trace.operation).toBe('multiply');
    expect(line?.trace.unitPrice).toBe('2890');
  });

  it('Excel represents the provenance (document, edition, printed page, section, hash)', async () => {
    const finalized = finalizedWorkflow();
    const workbook = new ExcelJS.Workbook();
    const bytes = await renderEstimateExcel(finalized.calculation);
    await workbook.xlsx.load(bytes.slice().buffer);
    const ws = workbook.getWorksheet('Lines');
    if (ws === undefined) throw new Error('Lines sheet missing');
    const row = (() => {
      for (let i = 2; i <= ws.rowCount; i += 1) {
        if (ws.getRow(i).getCell(4).value === '010101') return ws.getRow(i).values as unknown[];
      }
      throw new Error('010101 row missing');
    })();
    expect(row[13]).toBe('فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴');
    expect(row[14]).toBe('1404');
    expect(row[15]).toBe('11');
    expect(row[16]).toBe('Chapter 1, Group 1');
    expect(row[17]).toBe(OFFICIAL_SOURCE_HASH);
    expect(row[4]).toBe('010101'); // leading zero intact in the rendered cell
  });

  it('PDF represents the provenance (printed page and source hash travel to the document)', async () => {
    const finalized = finalizedWorkflow();
    const bytes = await renderEstimatePdf(finalized.calculation);
    const pdfjs = (await import('pdfjs-dist/legacy/build/pdf.mjs')) as {
      getDocument: (options: { data: Uint8Array; isEvalSupported: boolean }) => {
        promise: Promise<{
          numPages: number;
          getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: unknown[] }> }>;
        }>;
      };
    };
    const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    let text = '';
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      text += `${content.items.map((item) => (item as { str?: string }).str ?? '').join(' ')}\n`;
    }
    const containsIgnoringSpaces = (haystack: string, needle: string): boolean =>
      haystack.replace(/\s+/g, '').includes(needle.replace(/\s+/g, ''));
    expect(containsIgnoringSpaces(text, OFFICIAL_SOURCE_HASH)).toBe(true);
    expect(text).toContain('010101');
    expect(containsIgnoringSpaces(text, 'Chapter 1, Group 1')).toBe(true);
    const containsPersianWord = (word: string): boolean => {
      const normalized = normalizePresentationForms(text);
      const forward = normalizePresentationForms(shapeArabicPersian(word));
      // eslint-disable-next-line @typescript-eslint/no-misused-spread -- verify reversed shaped code points
      const backward = [...forward].reverse().join('');
      return normalized.includes(forward) || normalized.includes(backward);
    };
    expect(containsPersianWord('فهرست')).toBe(true);
  }, 120_000);
});

describe('27. safety scan of the orchestration layer source', () => {
  it('projects src contains no coercion, clock, randomness or I/O', () => {
    const srcDir = new URL('../src/', import.meta.url);
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);
    const banned = [
      'Number(',
      'parseFloat(',
      'parseInt(',
      'Math.round(',
      'Math.abs(',
      'Math.random',
      'Date.now',
      '|| 0',
      '?? 0',
      "require('",
      "from 'node:",
    ];
    for (const file of files) {
      const source = readFileSync(new URL(file, srcDir), 'utf8');
      const codeOnly = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      for (const pattern of banned) {
        expect(codeOnly.includes(pattern), `${file} must not contain "${pattern}"`).toBe(false);
      }
    }
  });

  it('no fuzzy lookup exists: resolution goes through the exact-code S2 binding only', () => {
    const srcDir = new URL('../src/', import.meta.url);
    const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
    const sources = files.map((f) => ({
      file: f,
      source: readFileSync(new URL(f, srcDir), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, ''),
    }));
    for (const { file, source } of sources) {
      // no description search, no similarity, no nearest-code fallback
      expect(source.includes('findRows'), `${file} must not filter/search rows`).toBe(false);
      expect(source.includes('description.includes'), `${file} must not search descriptions`).toBe(
        false,
      );
      for (const word of ['nearest', 'similar', 'levenshtein', 'fuzzy']) {
        expect(source.includes(word), `${file} must not mention "${word}"`).toBe(false);
      }
    }
    // the only dataset access the line path performs is bindBoqLine (S2 exact getRow)
    const resolution = sources.find((s) => s.file === 'estimate-lines.ts');
    expect(resolution?.source.includes('bindBoqLine')).toBe(true);
    expect(resolution?.source.includes('dataset.getRow')).toBe(false);
  });
});
