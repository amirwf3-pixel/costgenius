/**
 * Deterministic BOQ grouping.
 *
 * Chapter and group keys are the row's own `chapter`/`group` values (authoritative,
 * source-derived) — never inferred from code digits. Ordering is first-appearance
 * (insertion) order of the lines; within a group the lines keep their source order. Nothing
 * is sorted alphabetically or by code, no chapters or groups are merged, and duplicate-code
 * lines stay separate entries.
 */
import type { BoqLine } from './boq-line.js';

export interface ChapterLines {
  readonly chapter: string;
  readonly lines: readonly BoqLine[];
}

export interface ChapterGroupLines {
  readonly chapter: string;
  readonly group: string;
  readonly lines: readonly BoqLine[];
}

export interface BuildingLines {
  /** null groups the lines that carry no buildingId. */
  readonly buildingId: string | null;
  readonly lines: readonly BoqLine[];
}

/** Groups lines by chapter, first-appearance order. */
export function groupLinesByChapter(lines: readonly BoqLine[]): readonly ChapterLines[] {
  const groups: ChapterLines[] = [];
  for (const line of lines) {
    const existing = groups.find((g) => g.chapter === line.chapter);
    if (existing === undefined) {
      groups.push({ chapter: line.chapter, lines: [line] });
    } else {
      groups[groups.indexOf(existing)] = {
        chapter: existing.chapter,
        lines: [...existing.lines, line],
      };
    }
  }
  return groups;
}

/** Groups lines by chapter + group, first-appearance order. */
export function groupLinesByChapterGroup(lines: readonly BoqLine[]): readonly ChapterGroupLines[] {
  const groups: ChapterGroupLines[] = [];
  for (const line of lines) {
    const existing = groups.find((g) => g.chapter === line.chapter && g.group === line.group);
    if (existing === undefined) {
      groups.push({ chapter: line.chapter, group: line.group, lines: [line] });
    } else {
      groups[groups.indexOf(existing)] = {
        chapter: existing.chapter,
        group: existing.group,
        lines: [...existing.lines, line],
      };
    }
  }
  return groups;
}

/** Groups lines by building attribution (metadata only; no combined rule is invented). */
export function groupLinesByBuilding(lines: readonly BoqLine[]): readonly BuildingLines[] {
  const groups: BuildingLines[] = [];
  for (const line of lines) {
    const key = line.buildingId ?? null;
    const existing = groups.find((g) => g.buildingId === key);
    if (existing === undefined) {
      groups.push({ buildingId: key, lines: [line] });
    } else {
      groups[groups.indexOf(existing)] = {
        buildingId: existing.buildingId,
        lines: [...existing.lines, line],
      };
    }
  }
  return groups;
}
