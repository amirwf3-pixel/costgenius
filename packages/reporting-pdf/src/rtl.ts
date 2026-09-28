/**
 * The RTL presentation engine — real Arabic/Persian shaping and Unicode bidi.
 *
 * Strategy (documented in the README): PDFKit draws glyphs left-to-right from the string
 * it is given and performs no Arabic shaping and no bidi. This module therefore prepares
 * every string in three honest, presentation-only steps:
 *
 * 1. SHAPING — the Arabic joining algorithm (Unicode joining classes) maps each Persian/
 *    Arabic letter to its contextual Arabic Presentation Form (isolated/final/initial/
 *    medial, incl. the mandatory Lam-Alef ligatures). This is real glyph shaping, not
 *    string reversal; the presentation-form codepoints exist in the embedded Vazirmatn
 *    font (verified by cmap glyph ids in the font pipeline tests).
 * 2. BIDI — `bidi-js` (a full UAX #9 implementation) computes embedding levels for the
 *    SHAPED string in an RTL base direction and yields the run segments to reorder into
 *    visual order. Mixed Persian/Latin/digit text is handled by the algorithm, not by
 *    hand: Latin tokens (`0990007`, `IR-1404-E-OVERHEAD-01`, dependency ids) stay intact.
 *    Signed decimal tokens (`-15000`) are isolated with explicit LTR embeddings
 *    (U+202A/U+202C) BEFORE bidi so the minus stays on the left; the invisible control
 *    characters are stripped after reordering.
 * 3. WRAPPING — logical text is wrapped to a pixel width by measuring each candidate
 *    line's SHAPED VISUAL form (`widthOf`), and over-long unbreakable tokens are chunked
 *    by measured width. Each wrapped line is then shaped+reordered independently, so
 *    multi-line cells read top-down correctly.
 *
 * No reversal is used as a substitute for shaping, no transliteration, no stripping of
 * Unicode, and no business value is ever converted to a number.
 */
import bidiFactoryImport from 'bidi-js';
import type { Bidi } from 'bidi-js';

// bidi-js ships ESM-style `export default` inside a CommonJS package, which NodeNext types
// as the module namespace; at runtime (Node CJS interop) the default import IS the factory.
const bidiFactory = bidiFactoryImport as unknown as () => Bidi;

const bidi = bidiFactory();

/** Joining class: dual-joining (connects both sides). */
const DUAL = new Set<number>([
  0x0626, 0x0628, 0x062a, 0x062b, 0x062c, 0x062d, 0x062e, 0x0633, 0x0634, 0x0635, 0x0636, 0x0637,
  0x0638, 0x0639, 0x063a, 0x0641, 0x0642, 0x0643, 0x0644, 0x0645, 0x0646, 0x0647, 0x064a, 0x067e,
  0x0686, 0x06a9, 0x06af, 0x06cc,
]);
/** Joining class: right-joining (connects only to the preceding letter). */
const RIGHT = new Set<number>([
  0x0622, 0x0623, 0x0624, 0x0625, 0x0627, 0x0629, 0x062f, 0x0630, 0x0631, 0x0632, 0x0648, 0x0649,
  0x0698,
]);
/** Joining class: transparent (combining marks — do not affect joining). */
const TRANSPARENT = new Set<number>(
  (() => {
    const marks: number[] = [];
    for (let cp = 0x064b; cp <= 0x065f; cp += 1) marks.push(cp);
    marks.push(0x0670);
    for (let cp = 0x06d6; cp <= 0x06ed; cp += 1) marks.push(cp);
    return marks;
  })(),
);
/** ZWNJ (0x200C) breaks joining; ZWJ (0x200D) joins both sides. Both render as nothing. */
const ZWNJ = 0x200c;
const ZWJ = 0x200d;

/** Presentation forms: base letter → [isolated, final, initial, medial]. */
const FORMS: Readonly<Record<number, readonly number[]>> = {
  0x0622: [0xfe81, 0xfe82],
  0x0623: [0xfe83, 0xfe84],
  0x0624: [0xfe85, 0xfe86],
  0x0625: [0xfe87, 0xfe88],
  0x0626: [0xfe89, 0xfe8a, 0xfe8b, 0xfe8c],
  0x0627: [0xfe8d, 0xfe8e],
  0x0628: [0xfe8f, 0xfe90, 0xfe91, 0xfe92],
  0x0629: [0xfe93, 0xfe94],
  0x062a: [0xfe95, 0xfe96, 0xfe97, 0xfe98],
  0x062b: [0xfe99, 0xfe9a, 0xfe9b, 0xfe9c],
  0x062c: [0xfe9d, 0xfe9e, 0xfe9f, 0xfea0],
  0x062d: [0xfea1, 0xfea2, 0xfea3, 0xfea4],
  0x062e: [0xfea5, 0xfea6, 0xfea7, 0xfea8],
  0x062f: [0xfea9, 0xfeaa],
  0x0630: [0xfeab, 0xfeac],
  0x0631: [0xfead, 0xfeae],
  0x0632: [0xfeaf, 0xfeb0],
  0x0633: [0xfeb1, 0xfeb2, 0xfeb3, 0xfeb4],
  0x0634: [0xfeb5, 0xfeb6, 0xfeb7, 0xfeb8],
  0x0635: [0xfeb9, 0xfeba, 0xfebb, 0xfebc],
  0x0636: [0xfebd, 0xfebe, 0xfebf, 0xfec0],
  0x0637: [0xfec1, 0xfec2, 0xfec3, 0xfec4],
  0x0638: [0xfec5, 0xfec6, 0xfec7, 0xfec8],
  0x0639: [0xfec9, 0xfeca, 0xfecb, 0xfecc],
  0x063a: [0xfecd, 0xfece, 0xfecf, 0xfed0],
  0x0641: [0xfed1, 0xfed2, 0xfed3, 0xfed4],
  0x0642: [0xfed5, 0xfed6, 0xfed7, 0xfed8],
  0x0643: [0xfed9, 0xfeda, 0xfedb, 0xfedc],
  0x0644: [0xfedd, 0xfede, 0xfedf, 0xfee0],
  0x0645: [0xfee1, 0xfee2, 0xfee3, 0xfee4],
  0x0646: [0xfee5, 0xfee6, 0xfee7, 0xfee8],
  0x0647: [0xfee9, 0xfeea, 0xfeeb, 0xfeec],
  0x0648: [0xfeed, 0xfeee],
  0x0649: [0xfeef, 0xfef0],
  0x064a: [0xfef1, 0xfef2, 0xfef3, 0xfef4],
  // Persian-specific letters (Arabic Presentation Forms-A)
  0x067e: [0xfb56, 0xfb57, 0xfb58, 0xfb59], // پ
  0x0686: [0xfb7a, 0xfb7b, 0xfb7c, 0xfb7d], // چ
  0x0698: [0xfb8a, 0xfb8b], // ژ
  0x06a9: [0xfb8e, 0xfb8f, 0xfb90, 0xfb91], // ک
  0x06af: [0xfb92, 0xfb93, 0xfb94, 0xfb95], // گ
  0x06cc: [0xfbfc, 0xfbfd, 0xfbfe, 0xfbff], // ی
};

/** Mandatory Lam-Alef ligatures: alef variant → [isolated, final] of the ligature. */
const LAM_ALEF: Readonly<Record<number, readonly [number, number]>> = {
  0x0622: [0xfef5, 0xfef6],
  0x0623: [0xfef7, 0xfef8],
  0x0625: [0xfef9, 0xfefa],
  0x0627: [0xfefb, 0xfefc],
};

const ISOLATED = 0;
const FINAL = 1;
const INITIAL = 2;
const MEDIAL = 3;

const joinsToNext = (cp: number): boolean => DUAL.has(cp) || cp === ZWJ || cp === 0x0640;
const joinsToPrevious = (cp: number): boolean =>
  DUAL.has(cp) || RIGHT.has(cp) || cp === ZWJ || cp === 0x0640;

/** Skips transparent marks (and ZWJ) when looking for a joining neighbor. */
const prevStrong = (cps: readonly number[], from: number): number => {
  let k = from;
  while (k >= 0) {
    const cp = cps[k];
    if (cp === undefined || (!TRANSPARENT.has(cp) && cp !== ZWJ)) break;
    k -= 1;
  }
  return k;
};
const nextStrong = (cps: readonly number[], from: number): number => {
  let m = from;
  while (m < cps.length) {
    const cp = cps[m];
    if (cp === undefined || (!TRANSPARENT.has(cp) && cp !== ZWJ)) break;
    m += 1;
  }
  return m;
};

/**
 * Shapes Arabic/Persian text into its presentation forms (the Arabic joining algorithm).
 * Latin text, digits, punctuation and unknown codepoints pass through unchanged; ZWNJ/ZWJ
 * are honored for joining and then removed (they render as nothing).
 */
export function shapeArabicPersian(text: string): string {
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code-point iteration is exactly the semantic Arabic shaping requires
  const cps = [...text].map((c) => {
    const cp = c.codePointAt(0);
    return cp === undefined ? 0 : cp;
  });
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += 1) {
    const cp = cps[i];
    if (cp === undefined || cp === ZWNJ || cp === ZWJ) continue;

    if (cp === 0x0644) {
      // LAM followed by an alef variant → mandatory ligature
      const a = nextStrong(cps, i + 1);
      const aCp = a < cps.length ? cps[a] : undefined;
      const ligature = aCp === undefined ? undefined : LAM_ALEF[aCp];
      if (ligature !== undefined) {
        const p = prevStrong(cps, i - 1);
        const pCp = p >= 0 ? cps[p] : undefined;
        const prevJoins = pCp !== undefined && joinsToNext(pCp);
        out.push(String.fromCodePoint(prevJoins ? ligature[FINAL] : ligature[ISOLATED]));
        i = a; // the alef is consumed by the ligature
        continue;
      }
    }

    const forms = FORMS[cp];
    if (forms === undefined) {
      out.push(String.fromCodePoint(cp));
      continue;
    }
    const p = prevStrong(cps, i - 1);
    const pCp = p >= 0 ? cps[p] : undefined;
    const prevJoins = pCp !== undefined && joinsToNext(pCp);
    const n = nextStrong(cps, i + 1);
    const nCp = n < cps.length ? cps[n] : undefined;
    const nextJoins = nCp !== undefined && joinsToPrevious(nCp) && joinsToNext(cp);
    const form = !prevJoins ? (nextJoins ? INITIAL : ISOLATED) : nextJoins ? MEDIAL : FINAL;
    const shaped = forms[Math.min(form, forms.length - 1)] ?? forms[0] ?? cp;
    out.push(String.fromCodePoint(shaped));
  }
  return out.join('');
}

const LRE = '\u202a'; // LEFT-TO-RIGHT EMBEDDING
const POP = '\u202c'; // POP DIRECTIONAL FORMATTING

/**
 * Isolates sign-leading decimal tokens as explicit LTR islands so the minus sign stays on
 * the LEFT of its digits in an RTL base direction. Plain digits and hyphens inside Latin
 * tokens (e.g. `IR-1404-E-OVERHEAD-01`) are already handled by bidi and are not touched.
 */
function isolateSignedNumbers(logical: string): string {
  return logical.replace(/-?\d+(?:\.\d+)?/g, (match, offset: number, full: string): string => {
    if (!match.startsWith('-')) return match;
    const prev = offset > 0 ? (full[offset - 1] ?? '') : '';
    if (/[A-Za-z0-9]/.test(prev)) return match;
    return LRE + match + POP;
  });
}

/** Strips the invisible bidi control characters after reordering. */
function stripBidiControls(text: string): string {
  return text.replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
}

/**
 * The full presentation pipeline for one line: shape → isolate signed numbers → bidi
 * (UAX #9, RTL base) → visual order. This is what gets drawn, in left-to-right drawing
 * order, on the page.
 */
/** Strong-LTR detection (Latin letters are what our Latin runs use). */
function isStrongLtr(cp: number): boolean {
  return (cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a) || (cp >= 0xc0 && cp <= 0x24f);
}

/** Arabic-script detection (Arabic, Arabic Supplement/Extended, presentation forms). */
function isArabicScript(cp: number): boolean {
  return (
    (cp >= 0x600 && cp <= 0x6ff) ||
    (cp >= 0x750 && cp <= 0x77f) ||
    (cp >= 0x8a0 && cp <= 0x8ff) ||
    (cp >= 0xfb50 && cp <= 0xfdff) ||
    (cp >= 0xfe70 && cp <= 0xfeff)
  );
}

/**
 * First-strong base direction: pure-Latin tokens (statuses, dependency ids, codes like
 * '0990007', 'EXTERNAL_DEPENDENCY') must lay out LTR, or trailing separators ('_','-')
 * migrate to the wrong end of the visual run. Only strings whose first strong character
 * is Arabic-script use the RTL base direction.
 */
function baseDirectionOf(text: string): 'ltr' | 'rtl' {
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === undefined) continue;
    if (isArabicScript(cp)) return 'rtl';
    if (isStrongLtr(cp)) return 'ltr';
  }
  return 'ltr';
}

export function toVisualString(logical: string): string {
  const prepared = isolateSignedNumbers(shapeArabicPersian(logical));
  const levels = bidi.getEmbeddingLevels(prepared, baseDirectionOf(prepared));
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code-point iteration is exactly the semantic Arabic shaping requires
  const arr = [...prepared];
  for (const [start, end] of bidi.getReorderSegments(prepared, levels)) {
    if (start === undefined || end === undefined) continue;
    const segment = arr.slice(start, end + 1).reverse();
    arr.splice(start, segment.length, ...segment);
  }
  return stripBidiControls(arr.join(''));
}

/** Word wrapper over LOGICAL text; measures each candidate line in its VISUAL form. */
export function wrapLogicalText(
  logical: string,
  width: number,
  widthOf: (text: string) => number,
): string[] {
  const words = logical.split(/(\s+)/).filter((w) => w.length > 0);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current + word;
    if (widthOf(toVisualString(candidate.trim())) <= width || current.trim() === '') {
      // still fits (or the line is empty) — but an over-long single word must be chunked
      if (widthOf(toVisualString(candidate.trim())) > width && current.trim() === '') {
        for (const chunk of breakOverlongWord(word.trim(), width, widthOf)) {
          lines.push(chunk);
        }
        current = '';
        continue;
      }
      current = candidate;
    } else {
      lines.push(current.trim());
      current = word.trim() === '' ? '' : word;
    }
  }
  if (current.trim() !== '') lines.push(current.trim());
  return lines.filter((l) => l !== '');
}

/** Break-friendly separators for over-long Latin tokens (ids, statuses, paths). */
const TOKEN_SEPARATORS = new Set(['-', '_', '/', '.']);

/** Chunks a single unbreakable token by measured width, preferring separator boundaries. */
export function breakOverlongWord(
  word: string,
  width: number,
  widthOf: (text: string) => number,
): string[] {
  if (word === '') return [];
  const chunks: string[] = [];
  let chunk = '';
  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code-point iteration is exactly the semantic Arabic shaping requires
  for (const ch of [...word]) {
    const candidate = chunk + ch;
    if (widthOf(toVisualString(candidate)) <= width || chunk === '') {
      chunk = candidate;
      continue;
    }
    // prefer cutting at the last separator inside the accumulated chunk
    let cut = -1;
    for (let i = chunk.length - 1; i > 0; i -= 1) {
      if (TOKEN_SEPARATORS.has(chunk[i] ?? '')) {
        cut = i + 1;
        break;
      }
    }
    if (cut > 0) {
      chunks.push(chunk.slice(0, cut));
      chunk = chunk.slice(cut) + ch;
    } else {
      chunks.push(chunk);
      chunk = ch;
    }
  }
  if (chunk !== '') chunks.push(chunk);
  return chunks;
}

const PF_TO_BASE = new Map<string, string>(
  (() => {
    const pairs: [string, string][] = [];
    for (const [base, forms] of Object.entries(FORMS)) {
      for (const form of forms) {
        // parseInt parses the decimal FORMS table key (a codepoint), never a business value
        pairs.push([String.fromCodePoint(form), String.fromCodePoint(parseInt(base, 10))]);
      }
    }
    for (const [alef, [iso, fin]] of Object.entries(LAM_ALEF)) {
      const expansion = `${String.fromCodePoint(0x0644)}${String.fromCodePoint(parseInt(alef, 10))}`;
      pairs.push([String.fromCodePoint(iso), expansion]);
      pairs.push([String.fromCodePoint(fin), expansion]);
    }
    return pairs;
  })(),
);

/**
 * Maps Arabic Presentation Form codepoints back to their base letters. The renderer draws
 * presentation forms (real shaping); PDF text-extraction tools sometimes report either the
 * presentation form or the base letter depending on the font's ToUnicode table, so
 * consumers comparing extracted text should normalize both sides with this function.
 */
export function normalizePresentationForms(text: string): string {
  let out = '';
  for (const ch of text) {
    out += PF_TO_BASE.get(ch) ?? ch;
  }
  return out;
}
