/**
 * افزودن ردیف (§25/§26): جستجوی کد فهرست‌بها از endpoint واقعی lookup (فقط UX)،
 * انتخاب ردیف → واحد دقیقاً از همان ردیف پر می‌شود (بدون تبدیل)، مقدار به‌صورت
 * رشته دقیق اعشار ارسال می‌شود. resolution نهایی همیشه سمت backend است.
 *
 * D-015/D6-B: ورود مقدار به دو روش — «دستی» (مقدار دقیق، همیشه نامنفی؛ کسر فقط با
 * ردیف کسر بها) و «متره‌ای» (تعداد × ابعاد بر حسب واحد m/m2/m3/each). مقدار متره‌ای
 * هرگز سمت کلاینت محاسبه نمی‌شود: پیش‌نمایش بی‌حالت از endpoint محاسبهٔ S1 گرفته
 * می‌شود و ثبت نهایی فقط «ضرایب» را می‌فرستد تا سرور خودش مقدار و provenance را
 * بسازد. واحدهای غیر متره‌ای (مثل kg) فقط دستی هستند.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useApi } from '../../api/context.js';
import { formatAmount, formatDecimal } from '../../format.js';
import type { NewLineInput, PricebookRowRef } from '../../api/types.js';
import { ApiError, takeoffFactorHint } from '../../api/client.js';
import {
  Button,
  Field,
  FormError,
  FormValidationError,
  Ltr,
  Modal,
  Select,
  TextInput,
} from '../ui/primitives.js';

/** D2-A: manual quantities are non-negative — a deduction is a کسر بها row, never a signed quantity. */
const DECIMAL_PATTERN = /^\d+(\.\d+)?$/;
/** Dimensional factors: integer count and non-negative exact decimals only. */
const COUNT_PATTERN = /^\d+$/;

/** The S1 quantity units (D-015): dimensional entry is offered for these only. */
const DIMENSIONAL_UNITS: ReadonlySet<string> = new Set(['m', 'm2', 'm3', 'each']);

/** Per-unit required dimensions: m → L; m2 → L×W; m3 → L×W×H; each → count only. */
function requiredDimensionsOf(unit: string): { length: boolean; width: boolean; height: boolean } {
  return {
    length: unit === 'm' || unit === 'm2' || unit === 'm3',
    width: unit === 'm2' || unit === 'm3',
    height: unit === 'm3',
  };
}

export function AddLineDialog({
  versionId,
  editionId,
  onClose,
  onAdded,
}: {
  versionId: string;
  /** P8-B S3 (§12/§19): the workspace version's bound edition — the search's edition. */
  editionId: string | undefined;
  onClose: () => void;
  onAdded: () => void;
}): ReactElement {
  const api = useApi();
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<readonly PricebookRowRef[] | undefined>(undefined);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<Error | undefined>(undefined);
  const [selected, setSelected] = useState<PricebookRowRef | undefined>(undefined);
  const [entryMode, setEntryMode] = useState<'manual' | 'dimensional'>('manual');
  const [quantity, setQuantity] = useState('');
  const [count, setCount] = useState('');
  const [length, setLength] = useState('');
  const [width, setWidth] = useState('');
  const [height, setHeight] = useState('');
  const [preview, setPreview] = useState<
    { quantity: string; specVersion: string; engineVersion: string } | undefined
  >(undefined);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [buildingId, setBuildingId] = useState('');
  const [landscaping, setLandscaping] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const debounce = useRef<number | undefined>(undefined);

  const unitCode = selected?.unit.code ?? '';
  const dimensionalAvailable = DIMENSIONAL_UNITS.has(unitCode);
  const dims = requiredDimensionsOf(unitCode);

  // Any change to the factors (or the row/mode) invalidates the preview — the shown
  // quantity must always belong to the factors currently on screen.
  useEffect(() => {
    setPreview(undefined);
  }, [selected, entryMode, count, length, width, height]);

  // debounced lookup — only when the user types at least one character
  useEffect(() => {
    if (debounce.current !== undefined) window.clearTimeout(debounce.current);
    if (search.trim().length === 0) {
      setResults(undefined);
      setSearchError(undefined);
      return;
    }
    setSearching(true);
    debounce.current = window.setTimeout(() => {
      api
        .searchPricebook(search.trim(), 20, editionId)
        .then((rows) => {
          setResults(rows);
          setSearchError(undefined);
        })
        .catch((cause: unknown) => {
          setSearchError(cause instanceof Error ? cause : new Error(String(cause)));
          setResults(undefined);
        })
        .finally(() => {
          setSearching(false);
        });
    }, 300);
    return () => {
      if (debounce.current !== undefined) window.clearTimeout(debounce.current);
    };
  }, [api, search, editionId]);

  /** Collects the current factors (only the dimensions the unit requires). */
  const factorsOf = ():
    | {
        kind: 'addition';
        unit: string;
        count: string;
        length?: string;
        width?: string;
        height?: string;
      }
    | undefined => {
    if (selected === undefined) return undefined;
    if (!COUNT_PATTERN.test(count)) return undefined;
    if (dims.length && !DECIMAL_PATTERN.test(length)) return undefined;
    if (dims.width && !DECIMAL_PATTERN.test(width)) return undefined;
    if (dims.height && !DECIMAL_PATTERN.test(height)) return undefined;
    return {
      kind: 'addition',
      unit: unitCode,
      count,
      ...(dims.length ? { length } : {}),
      ...(dims.width ? { width } : {}),
      ...(dims.height ? { height } : {}),
    };
  };

  const runPreview = async (): Promise<void> => {
    if (selected === undefined) {
      setError(new FormValidationError('ابتدا یک ردیف فهرست‌بها را از نتایج جستجو انتخاب کنید.'));
      return;
    }
    const factors = factorsOf();
    if (factors === undefined) {
      setError(
        new FormValidationError(
          'تعداد باید عددی صحیح نامنفی و ابعاد اعداد اعشاری نامنفی باشند (مثلاً 4 و 2.5).',
        ),
      );
      return;
    }
    setPreviewBusy(true);
    setError(undefined);
    try {
      const result = await api.previewTakeoffQuantities([{ itemKey: 'preview', ...factors }]);
      const item = result.items[0];
      if (item === undefined) throw new Error('پاسخ پیش‌نمایش خالی بود.');
      setPreview({
        quantity: item.quantity,
        specVersion: result.specVersion,
        engineVersion: result.engineVersion,
      });
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'TAKEOFF_QUANTITIES_REJECTED') {
        const failures = (cause.details as { failures?: { code?: string }[] } | undefined)
          ?.failures;
        const first = failures?.[0]?.code;
        setError(
          new FormValidationError(
            first !== undefined ? takeoffFactorHint(first) : cause.userMessage,
          ),
        );
      } else {
        setError(cause instanceof Error ? cause : new Error(String(cause)));
      }
      setPreviewBusy(false);
      return;
    }
    setPreviewBusy(false);
  };

  const submit = async (): Promise<void> => {
    if (selected === undefined) {
      setError(new FormValidationError('ابتدا یک ردیف فهرست‌بها را از نتایج جستجو انتخاب کنید.'));
      return;
    }
    const base = {
      pricebookCode: selected.code,
      unit: selected.unit.code, // exact unit of the row — never converted
      ...(buildingId.trim().length > 0 ? { buildingId: buildingId.trim() } : {}),
      ...(landscaping ? { landscaping: true } : {}),
    };
    let line: NewLineInput;
    if (entryMode === 'dimensional') {
      if (!dimensionalAvailable) {
        setError(
          new FormValidationError(
            'واحد این ردیف در محاسبهٔ متره‌ای پشتیبانی نمی‌شود؛ مقدار را دستی وارد کنید.',
          ),
        );
        return;
      }
      const factors = factorsOf();
      if (factors === undefined) {
        setError(
          new FormValidationError(
            'تعداد باید عددی صحیح نامنفی و ابعاد اعداد اعشاری نامنفی باشند (مثلاً 4 و 2.5).',
          ),
        );
        return;
      }
      // Commit sends ONLY the factors — the server computes the quantity and provenance.
      line = { ...base, takeoff: factors };
    } else {
      if (!DECIMAL_PATTERN.test(quantity)) {
        setError(
          new FormValidationError(
            'مقدار باید یک عدد اعشاری دقیق نامنفی باشد (مثلاً 1000 یا 12.5). کسر بها با ردیف مخصوص آن (مثل 010517) ثبت می‌شود، نه با مقدار منفی.',
          ),
        );
        return;
      }
      line = { ...base, quantity };
    }
    setBusy(true);
    setError(undefined);
    try {
      await api.addLines(versionId, [line]);
      onAdded();
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setBusy(false);
    }
  };

  return (
    <Modal title="افزودن ردیف فهرست‌بها" onClose={onClose}>
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field
          label="جستجوی کد یا شرح *"
          hint="مثلاً 010101 یا بخشی از شرح ردیف. اتصال نهایی همیشه با کد دقیق انجام می‌شود."
        >
          <TextInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="010101"
            className="input ltr-input"
            autoFocus
          />
        </Field>

        {searching && <p className="state-hint">در حال جستجو…</p>}
        {searchError !== undefined && <FormError error={searchError} />}
        {results !== undefined && results.length === 0 && !searching && (
          <p className="state-hint">
            ردیفی با این جستجو پیدا نشد. کد دقیق را از فهرست‌بها چاپی بررسی کنید.
          </p>
        )}
        {results !== undefined && results.length > 0 && (
          <div className="lookup-list" role="listbox" aria-label="نتایج جستجوی فهرست‌بها">
            {results.map((row) => (
              <button
                type="button"
                key={row.code}
                role="option"
                aria-selected={selected?.code === row.code}
                className={`lookup-item ${selected?.code === row.code ? 'selected' : ''}`}
                onClick={() => setSelected(row)}
              >
                <span className="lookup-code">
                  <Ltr>{row.code}</Ltr>
                </span>
                <span className="lookup-desc">{row.description}</span>
                <span className="lookup-unit">{row.unit.label}</span>
                <span className={`lookup-price ${row.basePrice === null ? 'cell-null' : ''}`}>
                  <Ltr>{formatAmount(row.basePrice)}</Ltr>
                </span>
              </button>
            ))}
          </div>
        )}

        {selected !== undefined && (
          <p className="selected-row">
            ردیف انتخابی: <Ltr>{selected.code}</Ltr> — {selected.description} ({selected.unit.label}
            )
          </p>
        )}

        <Field
          label="روش ورود *"
          hint={
            dimensionalAvailable
              ? 'متره‌ای: مقدار از تعداد × ابعاد با موتور محاسبهٔ S1 به‌دست می‌آید (فقط واحدهای m، m2، m3 و each).'
              : 'واحد این ردیف متره‌ای نیست؛ فقط ورود دستی مقدار پشتیبانی می‌شود.'
          }
        >
          <Select
            value={entryMode}
            onChange={(event) => {
              setEntryMode(event.target.value === 'dimensional' ? 'dimensional' : 'manual');
            }}
          >
            <option value="manual">دستی (مقدار دقیق)</option>
            <option value="dimensional" disabled={!dimensionalAvailable}>
              متره‌ای (محاسبه از ابعاد)
            </option>
          </Select>
        </Field>

        {entryMode === 'manual' && (
          <Field
            label="مقدار *"
            hint="عدد دقیق اعشاری به‌صورت متن؛ بدون گردکردن. مقدار منفی پذیرفته نیست — کسر با ردیف کسر بها ثبت می‌شود."
          >
            <TextInput
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              placeholder="1000"
              className="input ltr-input"
            />
          </Field>
        )}

        {entryMode === 'dimensional' && selected !== undefined && (
          <>
            <div className="form-row">
              <Field label="تعداد *" hint="عدد صحیح نامنفی">
                <TextInput
                  value={count}
                  onChange={(event) => setCount(event.target.value)}
                  placeholder="4"
                  className="input ltr-input"
                />
              </Field>
              {dims.length && (
                <Field label="طول (متر) *">
                  <TextInput
                    value={length}
                    onChange={(event) => setLength(event.target.value)}
                    placeholder="2.5"
                    className="input ltr-input"
                  />
                </Field>
              )}
              {dims.width && (
                <Field label="عرض (متر) *">
                  <TextInput
                    value={width}
                    onChange={(event) => setWidth(event.target.value)}
                    placeholder="2"
                    className="input ltr-input"
                  />
                </Field>
              )}
              {dims.height && (
                <Field label="ارتفاع (متر) *">
                  <TextInput
                    value={height}
                    onChange={(event) => setHeight(event.target.value)}
                    placeholder="0.5"
                    className="input ltr-input"
                  />
                </Field>
              )}
            </div>
            <div className="form-actions">
              <Button onClick={() => void runPreview()} busy={previewBusy}>
                محاسبهٔ مقدار
              </Button>
            </div>
            {preview !== undefined && (
              <p className="selected-row" data-testid="takeoff-preview">
                مقدار دقیق محاسبه‌شده: <Ltr>{formatDecimal(preview.quantity)}</Ltr>{' '}
                {selected.unit.label} — موتور مترهٔ S1 (مشخصات {preview.specVersion}، موتور{' '}
                {preview.engineVersion})؛ هنگام ثبت، سرور همین مقدار را بازمحاسبه و ثبت می‌کند.
              </p>
            )}
          </>
        )}

        <div className="form-row">
          <Field label="ساختمان (اختیاری)">
            <TextInput
              value={buildingId}
              onChange={(event) => setBuildingId(event.target.value)}
              placeholder="building-main"
            />
          </Field>
          <Field label="فضای سبز">
            <Select
              value={landscaping ? 'yes' : 'no'}
              onChange={(event) => setLandscaping(event.target.value === 'yes')}
            >
              <option value="no">خیر</option>
              <option value="yes">بله</option>
            </Select>
          </Field>
        </div>
        <FormError error={error} />
        <div className="form-actions">
          <Button onClick={onClose}>لغو</Button>
          <Button variant="primary" type="submit" busy={busy}>
            افزودن ردیف
          </Button>
        </div>
      </form>
    </Modal>
  );
}
