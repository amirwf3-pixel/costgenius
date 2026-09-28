/**
 * ویرایشگر مقدار ردیف صورت‌برداشت (D-016) — فقط چهار شکل مجاز قرارداد 0.2.0:
 * ابعادی، ارجاع، عبارت ساخت‌یافته، دستی. هیچ تجزیه‌گر متنی و هیچ محاسبه‌ای اینجا
 * نیست؛ خروجی همان درخت JSON است که API انتظار دارد. اعشارها رشته می‌مانند.
 */
import { useId, type ReactElement } from 'react';
import type {
  TakeoffExpressionNode,
  TakeoffLine,
  TakeoffQuantity,
  TakeoffReferenceTerm,
} from '../../api/types.js';
import { Button, Field, Ltr, Select, TextInput } from '../ui/primitives.js';
import {
  DECIMAL_PATTERN,
  PROFILE_OPTIONS,
  QUANTITY_TYPE_OPTIONS,
  displayQuantity,
  type LineRef,
} from './model.js';

/** گره ثابتِ خالی برای شروع (مقدار هنوز وارد نشده). */
function emptyConst(): TakeoffExpressionNode {
  return { op: 'const', value: '' };
}

export function QuantityEditor({
  quantity,
  lines,
  onChange,
  disabled = false,
}: {
  quantity: TakeoffQuantity;
  /** همهٔ ردیف‌های سند (ارجاع بین‌برگه‌ای مجاز است، CG-FT §5.2). */
  lines: readonly LineRef[];
  onChange: (next: TakeoffQuantity) => void;
  disabled?: boolean;
}): ReactElement {
  const typeId = useId();
  switch (quantity.type) {
    case 'dimensional':
      return (
        <DimensionalEditor
          quantity={quantity}
          onChange={onChange}
          disabled={disabled}
          typeId={typeId}
        />
      );
    case 'reference':
      return (
        <ReferenceEditor
          quantity={quantity}
          lines={lines}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'expression':
      return (
        <ExpressionEditor
          quantity={quantity}
          lines={lines}
          onChange={onChange}
          disabled={disabled}
        />
      );
    case 'manual':
      return <ManualEditor quantity={quantity} onChange={onChange} disabled={disabled} />;
  }
}

// -------------------------------------------------------------------------------------------------

function DimensionalEditor({
  quantity,
  onChange,
  disabled,
  typeId,
}: {
  quantity: Extract<TakeoffQuantity, { type: 'dimensional' }>;
  onChange: (next: TakeoffQuantity) => void;
  disabled: boolean;
  typeId: string;
}): ReactElement {
  /** تغییر یک بُعد — مقدار خالی یعنی «غایب» (کلید حذف می‌شود، نه undefined). */
  const setDim = (key: 'length' | 'width' | 'height', value: string): void => {
    const patch =
      key === 'length'
        ? value === ''
          ? {}
          : { length: value }
        : key === 'width'
          ? value === ''
            ? {}
            : { width: value }
          : value === ''
            ? {}
            : { height: value };
    onChange({ ...quantity, ...patch });
  };
  const dim = (key: 'length' | 'width' | 'height'): { value: string; required: boolean } => ({
    value: quantity[key] ?? '',
    required:
      (quantity.profile === 'L' && key === 'length') ||
      (quantity.profile === 'LW' && (key === 'length' || key === 'width')) ||
      quantity.profile === 'LWH',
  });
  const dims = { length: dim('length'), width: dim('width'), height: dim('height') };
  return (
    <div className="form">
      <Field label="نوع مقدار">
        <Select
          id={typeId}
          value={quantity.type}
          disabled={disabled}
          onChange={(event) => {
            const type = event.target.value as TakeoffQuantity['type'];
            // جابه‌جایی بین چهار شکل؛ هیچ مقداری به‌طور پنهانی پیش‌فرض نمی‌شود
            onChange(
              type === 'dimensional'
                ? quantity
                : type === 'manual'
                  ? { type: 'manual', value: '', justification: '' }
                  : type === 'reference'
                    ? { type: 'reference', terms: [{ lineId: '', factor: '1', use: 'signed' }] }
                    : { type: 'expression', node: emptyConst() },
            );
          }}
        >
          {QUANTITY_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      <Field
        label="الگوی ابعاد *"
        hint="ابعادِ الزامی همان‌هایی است که الگو تعیین می‌کند؛ واحد تبدیل نمی‌شود."
      >
        <Select
          value={quantity.profile}
          disabled={disabled}
          onChange={(event) => {
            const profile = event.target.value as typeof quantity.profile;
            // تغییر الگو فقط فیلدهای مجاز را نگه می‌دارد؛ مقدارِ متناسب با الگوی
            // جدید حفظ و بقیه غایب می‌شوند (بدون نوشتن undefined).
            const needsLength = profile !== 'count';
            const needsWidth = profile === 'LW' || profile === 'LWH';
            const needsHeight = profile === 'LWH';
            onChange({
              type: 'dimensional',
              profile,
              ...(quantity.floorCount !== undefined ? { floorCount: quantity.floorCount } : {}),
              ...(quantity.similarCount !== undefined
                ? { similarCount: quantity.similarCount }
                : {}),
              ...(needsLength && quantity.length !== undefined ? { length: quantity.length } : {}),
              ...(needsWidth && quantity.width !== undefined ? { width: quantity.width } : {}),
              ...(needsHeight && quantity.height !== undefined ? { height: quantity.height } : {}),
            });
          }}
        >
          {PROFILE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="form-row">
        {quantity.profile !== 'count' && (
          <>
            <DimensionField
              label="طول"
              required={dims.length.required}
              value={dims.length.value}
              disabled={disabled}
              onChange={(value) => {
                setDim('length', value);
              }}
            />
            {(quantity.profile === 'LW' || quantity.profile === 'LWH') && (
              <DimensionField
                label="عرض"
                required={dims.width.required}
                value={dims.width.value}
                disabled={disabled}
                onChange={(value) => {
                  setDim('width', value);
                }}
              />
            )}
            {quantity.profile === 'LWH' && (
              <DimensionField
                label="ارتفاع"
                required={dims.height.required}
                value={dims.height.value}
                disabled={disabled}
                onChange={(value) => {
                  setDim('height', value);
                }}
              />
            )}
          </>
        )}
      </div>
      <div className="form-row">
        <Field
          label="تعداد طبقات (اختیاری)"
          hint="عدد صحیح ≥ ۱. خالی یعنی غایب — موتور آن را ۱ در نظر می‌گیرد و «غایب» ثبت می‌کند؛ هرگز به‌صورت پنهان ۱ نوشته نمی‌شود."
        >
          <TextInput
            value={quantity.floorCount ?? ''}
            disabled={disabled}
            inputMode="numeric"
            dir="ltr"
            aria-label="تعداد طبقات"
            onChange={(event) => {
              const value = event.target.value;
              onChange({
                ...quantity,
                ...(value === '' ? {} : { floorCount: value }),
              });
            }}
          />
        </Field>
        <Field
          label="تعداد مشابه (اختیاری)"
          hint="عدد صحیح ≥ ۱ — تعداد نمونه‌های مشابه همین ردیف (با تعداد طبقات متفاوت است)."
        >
          <TextInput
            value={quantity.similarCount ?? ''}
            disabled={disabled}
            inputMode="numeric"
            dir="ltr"
            aria-label="تعداد مشابه"
            onChange={(event) => {
              const value = event.target.value;
              onChange({
                ...quantity,
                ...(value === '' ? {} : { similarCount: value }),
              });
            }}
          />
        </Field>
      </div>
    </div>
  );
}

function DimensionField({
  label,
  required,
  value,
  disabled,
  onChange,
}: {
  label: string;
  required: boolean;
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}): ReactElement {
  const invalid = value !== '' && !DECIMAL_PATTERN.test(value);
  return (
    <Field label={`${label}${required ? ' *' : ''}`}>
      <TextInput
        value={value}
        disabled={disabled}
        inputMode="decimal"
        dir="ltr"
        aria-label={label}
        aria-invalid={invalid}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      />
    </Field>
  );
}

// -------------------------------------------------------------------------------------------------

function ReferenceEditor({
  quantity,
  lines,
  onChange,
  disabled,
}: {
  quantity: Extract<TakeoffQuantity, { type: 'reference' }>;
  lines: readonly LineRef[];
  onChange: (next: TakeoffQuantity) => void;
  disabled: boolean;
}): ReactElement {
  const setTerm = (index: number, patch: Partial<TakeoffReferenceTerm>): void => {
    onChange({
      type: 'reference',
      terms: quantity.terms.map((term, i) => (i === index ? { ...term, ...patch } : term)),
    });
  };
  return (
    <div className="form">
      <Field label="نوع مقدار">
        <Select
          value={quantity.type}
          disabled={disabled}
          onChange={(event) => {
            const type = event.target.value as TakeoffQuantity['type'];
            if (type === 'reference') return;
            onChange(
              type === 'dimensional'
                ? { type: 'dimensional', profile: 'LW' }
                : type === 'manual'
                  ? { type: 'manual', value: '', justification: '' }
                  : { type: 'expression', node: emptyConst() },
            );
          }}
        >
          {QUANTITY_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      <p className="field-hint">
        مقدار ردیف از ردیف‌های دیگر خوانده می‌شود: «مجموع ضریب × مقدار مرجع». ارجاع بین برگه‌ها مجاز
        است؛ حل مقدار فقط با موتور محاسبه انجام می‌شود.
      </p>
      {quantity.terms.map((term, index) => (
        <div className="form-row" key={`term-${String(index)}`}>
          <Field label={`ردیف مرجع ${String(index + 1)} *`}>
            <Select
              value={term.lineId}
              disabled={disabled}
              aria-label={`ردیف مرجع جملهٔ ${String(index + 1)}`}
              onChange={(event) => {
                setTerm(index, { lineId: event.target.value });
              }}
            >
              <option value="">— انتخاب ردیف —</option>
              {lines.map((ref) => (
                <option key={ref.line.lineId} value={ref.line.lineId}>
                  {`${ref.sheetName} · ردیف ${String(ref.line.rowNo)} · ${ref.line.lineId} — ${ref.line.description === '' ? 'بدون شرح' : ref.line.description} (${ref.line.unit})`}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={`ضریب ${String(index + 1)} *`} hint="عدد اعشاری؛ منفی مجاز است (کسر).">
            <TextInput
              value={term.factor}
              disabled={disabled}
              inputMode="decimal"
              dir="ltr"
              aria-label={`ضریب جملهٔ ${String(index + 1)}`}
              onChange={(event) => {
                setTerm(index, { factor: event.target.value });
              }}
            />
          </Field>
          <Field label="نوع خواندن مرجع">
            <Select
              value={term.use}
              disabled={disabled}
              aria-label="نوع خواندن مرجع"
              onChange={(event) => {
                setTerm(index, { use: event.target.value as TakeoffReferenceTerm['use'] });
              }}
            >
              <option value="signed">با علامت (افزایش/کسر مرجع)</option>
              <option value="magnitude">فقط قدرمطلق</option>
            </Select>
          </Field>
          <div className="field">
            <span className="field-label">حذف جمله</span>
            <Button
              disabled={disabled}
              onClick={() => {
                onChange({
                  type: 'reference',
                  terms: quantity.terms.filter((_, i) => i !== index),
                });
              }}
            >
              حذف
            </Button>
          </div>
        </div>
      ))}
      <div className="form-actions">
        <Button
          disabled={disabled}
          onClick={() => {
            onChange({
              type: 'reference',
              terms: [...quantity.terms, { lineId: '', factor: '1', use: 'signed' }],
            });
          }}
        >
          + جملهٔ ارجاع
        </Button>
      </div>
    </div>
  );
}

// -------------------------------------------------------------------------------------------------

function ExpressionEditor({
  quantity,
  lines,
  onChange,
  disabled,
}: {
  quantity: Extract<TakeoffQuantity, { type: 'expression' }>;
  lines: readonly LineRef[];
  onChange: (next: TakeoffQuantity) => void;
  disabled: boolean;
}): ReactElement {
  return (
    <div className="form">
      <Field label="نوع مقدار">
        <Select
          value={quantity.type}
          disabled={disabled}
          onChange={(event) => {
            const type = event.target.value as TakeoffQuantity['type'];
            if (type === 'expression') return;
            onChange(
              type === 'dimensional'
                ? { type: 'dimensional', profile: 'LW' }
                : type === 'manual'
                  ? { type: 'manual', value: '', justification: '' }
                  : { type: 'reference', terms: [{ lineId: '', factor: '1', use: 'signed' }] },
            );
          }}
        >
          {QUANTITY_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      <p className="field-hint">
        عبارت فقط با گره‌های مجاز ساخته می‌شود (ثابت، ارجاع، جمع، ضرب، تفریق، گرد کردن). تقسیم، توان
        و π وجود ندارند و هیچ فرمول متنی تجزیه نمی‌شود.
      </p>
      <div className="expression-editor">
        <NodeEditor
          path="root"
          node={quantity.node}
          lines={lines}
          disabled={disabled}
          onChange={(node) => {
            onChange({ type: 'expression', node });
          }}
        />
      </div>
    </div>
  );
}

/**
 * به‌روزرسانی عملوندهای گره با حفظ نوع تاپلی قرارداد (add/mul دست‌کم دو عملوند،
 * sub دقیقاً دو عملوند) — بدون هیچ cast و بدون عملوند گمشده.
 */
function replaceArg(
  node: TakeoffExpressionNode,
  index: number,
  next: TakeoffExpressionNode,
): TakeoffExpressionNode {
  switch (node.op) {
    case 'add':
    case 'mul':
      return {
        op: node.op,
        args: tupleOfTwoPlus(node.args.map((candidate, i) => (i === index ? next : candidate))),
      };
    case 'sub':
      return {
        op: 'sub',
        args: tupleOfExactlyTwo(node.args.map((candidate, i) => (i === index ? next : candidate))),
      };
    default:
      return node;
  }
}

function appendArg(
  node: TakeoffExpressionNode,
  extra: TakeoffExpressionNode,
): TakeoffExpressionNode {
  if (node.op === 'add' || node.op === 'mul') return { op: node.op, args: [...node.args, extra] };
  return node;
}

function removeLastArg(node: TakeoffExpressionNode): TakeoffExpressionNode {
  if (node.op === 'add' || node.op === 'mul') {
    return { op: node.op, args: tupleOfTwoPlus(node.args.slice(0, -1)) };
  }
  return node;
}

function tupleOfTwoPlus(
  args: readonly TakeoffExpressionNode[],
): [TakeoffExpressionNode, TakeoffExpressionNode, ...TakeoffExpressionNode[]] {
  const [first, second, ...rest] = args;
  if (first === undefined || second === undefined) {
    throw new Error('عملگر جمع/ضرب دست‌کم دو عملوند لازم دارد.');
  }
  return [first, second, ...rest];
}

function tupleOfExactlyTwo(
  args: readonly TakeoffExpressionNode[],
): [TakeoffExpressionNode, TakeoffExpressionNode] {
  const [first, second] = args;
  if (first === undefined || second === undefined) {
    throw new Error('عملگر تفریق دقیقاً دو عملوند لازم دارد.');
  }
  return [first, second];
}

/** ویرایشگر بازگشتی یک گره — کلید React مسیرِ گره است (نه اندیس آرایه). */
function NodeEditor({
  path,
  node,
  lines,
  disabled,
  onChange,
}: {
  path: string;
  node: TakeoffExpressionNode;
  lines: readonly LineRef[];
  disabled: boolean;
  onChange: (next: TakeoffExpressionNode) => void;
}): ReactElement {
  return (
    <div className="expression-node" data-node-path={path}>
      <div className="form-row">
        <Field label="عملگر گره">
          <Select
            value={node.op}
            disabled={disabled}
            aria-label={`عملگر گره ${path}`}
            onChange={(event) => {
              const op = event.target.value;
              switch (op) {
                case 'const':
                  onChange({ op: 'const', value: '' });
                  break;
                case 'ref':
                  onChange({ op: 'ref', lineId: '', use: 'signed' });
                  break;
                case 'add':
                  onChange({ op: 'add', args: [emptyConst(), emptyConst()] });
                  break;
                case 'mul':
                  onChange({ op: 'mul', args: [emptyConst(), emptyConst()] });
                  break;
                case 'sub':
                  onChange({ op: 'sub', args: [emptyConst(), emptyConst()] });
                  break;
                case 'round':
                  onChange({ op: 'round', arg: emptyConst(), rule: { scale: 0, mode: 'HALF_UP' } });
                  break;
              }
            }}
          >
            <option value="const">ثابت</option>
            <option value="ref">ارجاع به ردیف</option>
            <option value="add">جمع (+)</option>
            <option value="mul">ضرب (×)</option>
            <option value="sub">تفریق (−)</option>
            <option value="round">گرد کردن</option>
          </Select>
        </Field>
        {node.op === 'const' && (
          <Field label="مقدار ثابت *">
            <TextInput
              value={node.value}
              disabled={disabled}
              inputMode="decimal"
              dir="ltr"
              aria-label={`مقدار ثابت گره ${path}`}
              onChange={(event) => {
                onChange({ op: 'const', value: event.target.value });
              }}
            />
          </Field>
        )}
        {node.op === 'ref' && (
          <>
            <Field label="ردیف مرجع *">
              <Select
                value={node.lineId}
                disabled={disabled}
                aria-label={`ردیف مرجع گره ${path}`}
                onChange={(event) => {
                  onChange({ op: 'ref', lineId: event.target.value, use: node.use });
                }}
              >
                <option value="">— انتخاب ردیف —</option>
                {lines.map((ref) => (
                  <option key={ref.line.lineId} value={ref.line.lineId}>
                    {`${ref.sheetName} · ${ref.line.lineId} — ${ref.line.description === '' ? 'بدون شرح' : ref.line.description} (${ref.line.unit})`}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="نوع خواندن">
              <Select
                value={node.use}
                disabled={disabled}
                aria-label="نوع خواندن مرجع عبارت"
                onChange={(event) => {
                  onChange({
                    op: 'ref',
                    lineId: node.lineId,
                    use: event.target.value as 'signed' | 'magnitude',
                  });
                }}
              >
                <option value="signed">با علامت</option>
                <option value="magnitude">قدرمطلق</option>
              </Select>
            </Field>
          </>
        )}
        {node.op === 'round' && (
          <>
            <Field label="دقت گرد کردن (۰ تا ۲۰) *">
              <TextInput
                value={String(node.rule.scale)}
                disabled={disabled}
                inputMode="numeric"
                dir="ltr"
                aria-label="دقت گرد کردن"
                onChange={(event) => {
                  const parsed = Number.parseInt(event.target.value, 10);
                  onChange({
                    op: 'round',
                    arg: node.arg,
                    rule: { ...node.rule, scale: Number.isNaN(parsed) ? 0 : parsed },
                  });
                }}
              />
            </Field>
            <Field label="روش گرد کردن">
              <Select
                value={node.rule.mode}
                disabled={disabled}
                aria-label="روش گرد کردن"
                onChange={(event) => {
                  onChange({
                    op: 'round',
                    arg: node.arg,
                    rule: { ...node.rule, mode: event.target.value },
                  });
                }}
              >
                {['HALF_UP', 'HALF_EVEN', 'DOWN', 'UP', 'FLOOR', 'CEIL'].map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
      </div>
      {node.op === 'round' && (
        <NodeEditor
          path={`${path}.arg`}
          node={node.arg}
          lines={lines}
          disabled={disabled}
          onChange={(arg) => {
            onChange({ op: 'round', arg, rule: node.rule });
          }}
        />
      )}
      {(node.op === 'add' || node.op === 'mul' || node.op === 'sub') && (
        <div className="expression-args">
          {node.args.map((arg, index) => (
            <NodeEditor
              key={`${path}.args.${String(index)}`}
              path={`${path}.args.${String(index)}`}
              node={arg}
              lines={lines}
              disabled={disabled}
              onChange={(next) => {
                onChange(replaceArg(node, index, next));
              }}
            />
          ))}
          {node.op !== 'sub' && (
            <div className="form-actions">
              <Button
                disabled={disabled}
                onClick={() => {
                  onChange(appendArg(node, emptyConst()));
                }}
              >
                + عملوند
              </Button>
              {node.args.length > 2 && (
                <Button
                  disabled={disabled}
                  onClick={() => {
                    onChange(removeLastArg(node));
                  }}
                >
                  − عملوند
                </Button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// -------------------------------------------------------------------------------------------------

function ManualEditor({
  quantity,
  onChange,
  disabled,
}: {
  quantity: Extract<TakeoffQuantity, { type: 'manual' }>;
  onChange: (next: TakeoffQuantity) => void;
  disabled: boolean;
}): ReactElement {
  return (
    <div className="form">
      <Field label="نوع مقدار">
        <Select
          value={quantity.type}
          disabled={disabled}
          onChange={(event) => {
            const type = event.target.value as TakeoffQuantity['type'];
            if (type === 'manual') return;
            onChange(
              type === 'dimensional'
                ? { type: 'dimensional', profile: 'LW' }
                : type === 'reference'
                  ? { type: 'reference', terms: [{ lineId: '', factor: '1', use: 'signed' }] }
                  : { type: 'expression', node: emptyConst() },
            );
          }}
        >
          {QUANTITY_TYPE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
      </Field>
      <div className="form-row">
        <Field
          label="مقدار دستی *"
          hint="عدد اعشاری دقیق نامنفی — کسر با نوع ردیف «کسر» انجام می‌شود."
        >
          <TextInput
            value={quantity.value}
            disabled={disabled}
            inputMode="decimal"
            dir="ltr"
            aria-label="مقدار دستی"
            onChange={(event) => {
              onChange({
                type: 'manual',
                value: event.target.value,
                justification: quantity.justification,
              });
            }}
          />
        </Field>
        <Field label="دلیل ثبت *">
          <TextInput
            value={quantity.justification}
            disabled={disabled}
            aria-label="دلیل ثبت"
            onChange={(event) => {
              onChange({
                type: 'manual',
                value: quantity.value,
                justification: event.target.value,
              });
            }}
          />
        </Field>
      </div>
    </div>
  );
}

/** رندر فرمول خواندنی یک ردیف (نمایش قطعی، فقط-خواندنی؛ CG-FT §6.3). */
export function QuantityDisplay({ line }: { line: TakeoffLine }): ReactElement {
  return <Ltr>{displayQuantity(line.quantity)}</Ltr>;
}
