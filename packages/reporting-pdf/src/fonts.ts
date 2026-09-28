/**
 * Bundled font assets — the single filesystem access point of this package.
 *
 * The renderer is presentation-only and touches no business data, but a PDF must EMBED a
 * real font to be portable. The Vazirmatn family (SIL OFL 1.1; license file alongside) is
 * bundled in `assets/fonts/` and covers Persian, Arabic, Latin, Persian and Latin digits
 * and punctuation — including the Arabic Presentation Forms codepoints the RTL shaping
 * engine emits (verified by glyph-id coverage tests).
 *
 * This module only reads the bundled asset files. All business values stay pure; callers
 * who want zero filesystem access can pass their own font buffers to
 * `renderReportToPdf(report, { fonts })`.
 */
import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

export interface PdfFonts {
  readonly regular: Uint8Array;
  readonly bold: Uint8Array;
}

const FONT_DIR = new URL('../assets/fonts/', import.meta.url);

/** Loads the bundled Vazirmatn fonts (Regular + Bold). Asset loading only — no business data. */
export function loadBundledFonts(): PdfFonts {
  return {
    regular: readFileSync(new URL('Vazirmatn-Regular.ttf', FONT_DIR)),
    bold: readFileSync(new URL('Vazirmatn-Bold.ttf', FONT_DIR)),
  };
}
