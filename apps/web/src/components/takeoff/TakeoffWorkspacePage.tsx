/**
 * میزکار سند صورت‌برداشت (D-016 Phase 5) — کل گردش کار سند در یک صفحه:
 * بارگذاری با documentId، ویرایش پیش‌نویس (برگه‌ها + ردیف‌ها + قواعد گرد کردن)،
 * ذخیرهٔ کامل سند با expectedRevision، بایگانی/بازگردانی، نهایی‌سازی، سند پیرو و
 * انتقال به برآورد. سند نهایی‌شده کاملاً فقط-خواندنی است و نتیجه از snapshot
 * تغییرناپذیر خوانده می‌شود.
 *
 * قوانین: اعشارها رشتهٔ دقیق می‌مانند و هیچ محاسبه/گرد کردن سمت کلاینت نیست؛
 * dirty یعنی «محتوای ارسالی با آخرین نسخهٔ سرور فرق دارد» (مقایسه روی شکل
 * تجردیِ همان بدنهٔ ذخیره)؛ روی ۴۰۹ هرگز ویرایش محلی بازنویسی نمی‌شود — پیام
 * قطعی فارسی + دکمهٔ دریافت نسخهٔ جدید نشان داده می‌شود.
 */
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ApiError, takeoffEngineHints, takeoffFailureHints } from '../../api/client.js';
import { useApi } from '../../api/context.js';
import type {
  FinalizedTakeoffBundle,
  SaveTakeoffContent,
  TakeoffDocument,
  TakeoffExpressionNode,
  TakeoffLine,
  TakeoffQuantity,
  TakeoffResult,
  TakeoffRoundingRule,
  TakeoffSheet,
} from '../../api/types.js';
import { formatInstant } from '../../format.js';
import { useResource } from '../../hooks.js';
import {
  Badge,
  Button,
  ErrorView,
  Field,
  FormError,
  FormValidationError,
  LoadingView,
  Ltr,
  Modal,
  TextInput,
} from '../ui/primitives.js';
import { LineDialog } from './LineDialog.js';
import { QuantityDisplay } from './QuantityEditor.js';
import { RoundingRulesPanel } from './RoundingRulesPanel.js';
import { TakeoffResultView } from './TakeoffResultView.js';
import { TransferDialog } from './TransferDialog.js';
import {
  allLines,
  duplicateKeyIssues,
  newLine,
  newLineId,
  newSheet,
  newSheetId,
  takeoffStatusLabel,
  validateLineShape,
} from './model.js';

/** پیام قطعی تعارض همزمانی (§ نسخهٔ ۵) — بدون تغییر حرفی نمایش داده می‌شود. */
export const TAKEOFF_CONFLICT_MESSAGE =
  'این سند در جای دیگری تغییر کرده است. ابتدا نسخه جدید را دریافت کنید.';

// -------------------------------------------------------------------------------------------------
// شکل تجردیِ بدنهٔ ذخیره — هم برای ذخیره و هم برای تشخیص dirty (یک نمایش، نه دو).
// فیلدهای اختیاریِ خالی حذف می‌شوند؛ «undefined» هرگز ارسال نمی‌شود.
// -------------------------------------------------------------------------------------------------

function canonicalQuantity(quantity: TakeoffQuantity): TakeoffQuantity {
  if (quantity.type !== 'dimensional') return quantity;
  return {
    type: 'dimensional',
    profile: quantity.profile,
    ...(quantity.similarCount !== undefined && quantity.similarCount !== ''
      ? { similarCount: quantity.similarCount }
      : {}),
    ...(quantity.floorCount !== undefined && quantity.floorCount !== ''
      ? { floorCount: quantity.floorCount }
      : {}),
    ...(quantity.length !== undefined && quantity.length !== '' ? { length: quantity.length } : {}),
    ...(quantity.width !== undefined && quantity.width !== '' ? { width: quantity.width } : {}),
    ...(quantity.height !== undefined && quantity.height !== '' ? { height: quantity.height } : {}),
  };
}

function canonicalLine(line: TakeoffLine): TakeoffLine {
  return {
    lineId: line.lineId,
    rowNo: line.rowNo,
    description: line.description,
    ...(line.location !== undefined && line.location !== '' ? { location: line.location } : {}),
    ...(line.itemCode !== undefined && line.itemCode !== null && line.itemCode !== ''
      ? { itemCode: line.itemCode }
      : {}),
    kind: line.kind,
    unit: line.unit,
    quantity: canonicalQuantity(line.quantity),
    ...(line.notes !== undefined && line.notes !== '' ? { notes: line.notes } : {}),
  };
}

function canonicalSheet(sheet: TakeoffSheet): TakeoffSheet {
  return { sheetId: sheet.sheetId, name: sheet.name, lines: sheet.lines.map(canonicalLine) };
}

function canonicalRule(rule: TakeoffRoundingRule): TakeoffRoundingRule {
  const selector = rule.selector;
  const cleanedSelector =
    selector === undefined
      ? undefined
      : {
          ...(selector.itemCode !== undefined && selector.itemCode !== ''
            ? { itemCode: selector.itemCode }
            : {}),
          ...(selector.unit !== undefined && selector.unit !== '' ? { unit: selector.unit } : {}),
          ...(selector.lineIds !== undefined && selector.lineIds.length > 0
            ? { lineIds: selector.lineIds }
            : {}),
        };
  return {
    target: rule.target,
    ...(cleanedSelector !== undefined && Object.keys(cleanedSelector).length > 0
      ? { selector: cleanedSelector }
      : {}),
    scale: rule.scale,
    mode: rule.mode,
    sourceStatus: rule.sourceStatus,
    ...(rule.source !== undefined ? { source: rule.source } : {}),
  };
}

/** شکل نهاییِ محتوای سند (همان بدنهٔ save بدون expectedRevision). */
export function canonicalContent(content: SaveTakeoffContent): SaveTakeoffContent {
  return {
    title: content.title,
    sheets: content.sheets.map(canonicalSheet),
    rounding: content.rounding.map(canonicalRule),
  };
}

function contentOf(document: TakeoffDocument): SaveTakeoffContent {
  return { title: document.title, sheets: document.sheets, rounding: document.rounding };
}

// -------------------------------------------------------------------------------------------------
// نشان‌های وابستگی ارجاع‌ها (فقط هشدار؛ حل مقدار فقط با موتور است)
// -------------------------------------------------------------------------------------------------

/** شناسهٔ ردیف‌هایی که این مقدار از آن‌ها می‌خواند (ارجاع و گره‌های عبارت). */
export function referencedLineIds(quantity: TakeoffQuantity): readonly string[] {
  switch (quantity.type) {
    case 'dimensional':
    case 'manual':
      return [];
    case 'reference':
      return quantity.terms.map((term) => term.lineId).filter((id) => id !== '');
    case 'expression':
      return nodeRefs(quantity.node);
  }
}

function nodeRefs(node: TakeoffExpressionNode): readonly string[] {
  switch (node.op) {
    case 'const':
      return [];
    case 'ref':
      return node.lineId === '' ? [] : [node.lineId];
    case 'add':
    case 'mul':
      return node.args.flatMap(nodeRefs);
    case 'sub':
      return [...nodeRefs(node.args[0]), ...nodeRefs(node.args[1])];
    case 'round':
      return nodeRefs(node.arg);
  }
}

// -------------------------------------------------------------------------------------------------
// صفحه
// -------------------------------------------------------------------------------------------------

interface LocalState {
  readonly doc: TakeoffDocument;
  readonly local: SaveTakeoffContent;
}

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'load-error'; readonly error: Error }
  | { readonly kind: 'document'; readonly state: LocalState }
  | { readonly kind: 'finalized'; readonly bundle: FinalizedTakeoffBundle };

export function TakeoffWorkspacePage(): ReactElement {
  const { projectId, documentId } = useParams<{ projectId: string; documentId: string }>();
  const api = useApi();
  const navigate = useNavigate();
  const project = useResource(() => {
    if (projectId === undefined) return Promise.reject(new Error('نشانی پروژه نامعتبر است'));
    return api.getProject(projectId);
  });

  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [reloadTick, setReloadTick] = useState(0);
  const [activeSheetId, setActiveSheetId] = useState('');
  const [saveBusy, setSaveBusy] = useState(false);
  const [saveState, setSaveState] = useState<'idle' | 'saved' | 'failed'>('idle');
  const [saveError, setSaveError] = useState<Error | undefined>(undefined);
  const [conflict, setConflict] = useState(false);
  const [lineDialog, setLineDialog] = useState<
    | { readonly mode: 'create'; readonly sheetId: string; readonly line: TakeoffLine }
    | { readonly mode: 'edit'; readonly sheetId: string; readonly line: TakeoffLine }
    | undefined
  >(undefined);
  const [lineRemoval, setLineRemoval] = useState<
    { readonly sheetId: string; readonly lineId: string } | undefined
  >(undefined);
  const [manageSheets, setManageSheets] = useState(false);
  const [finalizeAsk, setFinalizeAsk] = useState(false);
  const [finalizeBusy, setFinalizeBusy] = useState(false);
  const [finalizeError, setFinalizeError] = useState<Error | undefined>(undefined);
  const [followUpAsk, setFollowUpAsk] = useState(false);
  const [followUpBusy, setFollowUpBusy] = useState(false);
  const [transferOpen, setTransferOpen] = useState(false);
  const [lifecycleError, setLifecycleError] = useState<Error | undefined>(undefined);
  const [downloading, setDownloading] = useState<'excel' | 'pdf' | undefined>(undefined);
  const [downloadError, setDownloadError] = useState<Error | undefined>(undefined);
  // P7-S2 (CG-FT@0.2.0 §16): پیش‌نمایش محاسبهٔ سمت سرور — بی‌حالت، بدون ذخیره/نهایی‌سازی
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewResult, setPreviewResult] = useState<TakeoffResult | undefined>(undefined);
  const [previewError, setPreviewError] = useState<Error | undefined>(undefined);

  // گزارش‌ها (Phase 6): فقط سند نهایی‌شده گزارش دارد؛ رندر سمت سرور از snapshot
  // نهایی‌سازی است و سند را تغییر نمی‌دهد. (Above the early returns so the finalized
  // view's closures always see the initialized binding.)
  const download = async (kind: 'excel' | 'pdf'): Promise<void> => {
    if (projectId === undefined || documentId === undefined) return;
    setDownloading(kind);
    setDownloadError(undefined);
    try {
      const { blob, filename } = await api.downloadTakeoffReport(projectId, documentId, kind);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (cause) {
      setDownloadError(cause instanceof Error ? cause : new Error(String(cause)));
    } finally {
      setDownloading(undefined);
    }
  };

  useEffect(() => {
    if (projectId === undefined || documentId === undefined) {
      setPhase({ kind: 'load-error', error: new Error('نشانی سند صورت‌برداشت نامعتبر است.') });
      return;
    }
    let cancelled = false;
    setPhase({ kind: 'loading' });
    setConflict(false);
    setSaveError(undefined);
    setFinalizeError(undefined);
    setLifecycleError(undefined);
    setPreviewResult(undefined);
    setPreviewError(undefined);
    api.getTakeoff(projectId, documentId).then(
      (value) => {
        if (cancelled) return;
        setPhase(
          value.kind === 'finalized'
            ? { kind: 'finalized', bundle: value.bundle }
            : {
                kind: 'document',
                state: { doc: value.document, local: contentOf(value.document) },
              },
        );
      },
      (cause: unknown) => {
        if (cancelled) return;
        setPhase({
          kind: 'load-error',
          error: cause instanceof Error ? cause : new Error(String(cause)),
        });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, projectId, documentId, reloadTick]);

  const state = phase.kind === 'document' ? phase.state : undefined;
  const dirty = useMemo(
    () =>
      state !== undefined &&
      JSON.stringify(canonicalContent(state.local)) !==
        JSON.stringify(canonicalContent(contentOf(state.doc))),
    [state],
  );

  // هشدار بستن صفحه با تغییرات ذخیره‌نشده (فقط پیش‌نویسِ قابل ویرایش)
  useEffect(() => {
    if (!dirty) return;
    const handler = (event: BeforeUnloadEvent): void => {
      // مرورگرهای مدرن (از جمله Chromium هدف e2e) با preventDefault کافی است؛
      // مقداردهی returnValue منسوخ است و نیاز نیست.
      event.preventDefault();
    };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
    };
  }, [dirty]);

  // برگهٔ فعال همیشه معتبر بماند (حذف برگه → برگهٔ اول)
  useEffect(() => {
    if (state === undefined) return;
    if (!state.local.sheets.some((sheet) => sheet.sheetId === activeSheetId)) {
      setActiveSheetId(state.local.sheets[0]?.sheetId ?? '');
    }
  }, [state, activeSheetId]);

  if (phase.kind === 'loading') return <LoadingView label="در حال دریافت سند صورت‌برداشت…" />;
  if (phase.kind === 'load-error')
    return (
      <section>
        <nav className="breadcrumb">
          <Link
            to={projectId === undefined ? '/projects' : `/projects/${projectId}`}
            className="link"
          >
            بازگشت به پروژه
          </Link>
        </nav>
        <ErrorView
          error={phase.error}
          onRetry={() => {
            setReloadTick((tick) => tick + 1);
          }}
        />
      </section>
    );

  if (phase.kind === 'finalized') {
    const bundle = phase.bundle;
    return (
      <section aria-labelledby="takeoff-title">
        <Breadcrumb projectTitle={project.data?.title} />
        <div className="page-head">
          <h1 id="takeoff-title">{bundle.document.title}</h1>
          <div className="page-head-actions">
            <Button
              onClick={() => {
                setFollowUpAsk(true);
              }}
            >
              ایجاد سند پیرو
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setTransferOpen(true);
              }}
            >
              انتقال به برآورد
            </Button>
          </div>
        </div>
        <div className="info-grid">
          <InfoRow label="شمارهٔ سند">
            <Ltr>{String(bundle.documentNumber)}</Ltr>
          </InfoRow>
          <InfoRow label="وضعیت">
            <Badge tone="finalized">{takeoffStatusLabel('finalized')}</Badge>
          </InfoRow>
          <InfoRow label="نهایی‌شده در">{formatInstant(bundle.finalizedAt)}</InfoRow>
          <InfoRow label="شناسهٔ سند">
            <Ltr>{bundle.documentId}</Ltr>
          </InfoRow>
          <InfoRow label="زنجیرهٔ متره">
            <Ltr>{bundle.takeoffId}</Ltr>
          </InfoRow>
        </div>
        <p className="state-hint">
          سند نهایی‌شده تغییرناپذیر است؛ نتیجهٔ زیر از snapshot لحظهٔ نهایی‌سازی خوانده می‌شود. برای
          تغییر، سند پیرو بسازید؛ برای برآورد، انتقال را اجرا کنید. گزارش‌های PDF و Excel نیز از
          همین snapshot ساخته می‌شوند.
        </p>
        <TakeoffResultView bundle={bundle} />

        <h2 className="section-title">گزارش‌ها</h2>
        <div className="section-actions">
          <Button
            variant="secondary"
            busy={downloading === 'excel'}
            onClick={() => {
              void download('excel');
            }}
          >
            دانلود Excel
          </Button>
          <Button
            variant="secondary"
            busy={downloading === 'pdf'}
            onClick={() => {
              void download('pdf');
            }}
          >
            دانلود PDF
          </Button>
        </div>
        <FormError error={downloadError} />

        {followUpAsk && projectId !== undefined && documentId !== undefined && (
          <Modal
            title="ایجاد سند پیرو"
            onClose={() => {
              setFollowUpAsk(false);
            }}
          >
            <div className="form">
              <p>
                سندی جدید در همین زنجیرهٔ متره ساخته می‌شود: شمارهٔ سند از سمت سرور صادر می‌شود،
                ردیف‌ها و قواعد با شناسه‌های پایدار همان‌طور کپی می‌شوند و سند جاری نهایی‌شده باقی
                می‌ماند.
              </p>
              <FormError error={lifecycleError} />
              <div className="form-actions">
                <Button
                  onClick={() => {
                    setFollowUpAsk(false);
                    setLifecycleError(undefined);
                  }}
                >
                  انصراف
                </Button>
                <Button
                  variant="primary"
                  busy={followUpBusy}
                  onClick={() => {
                    setFollowUpBusy(true);
                    setLifecycleError(undefined);
                    api
                      .createTakeoffFollowUp(projectId, documentId)
                      .then((draft) => {
                        navigate(`/projects/${projectId}/takeoffs/${draft.documentId}`);
                      })
                      .catch((cause: unknown) => {
                        setLifecycleError(
                          cause instanceof Error ? cause : new Error(String(cause)),
                        );
                      })
                      .finally(() => {
                        setFollowUpBusy(false);
                      });
                  }}
                >
                  ساختن سند پیرو
                </Button>
              </div>
            </div>
          </Modal>
        )}
        {transferOpen && projectId !== undefined && documentId !== undefined && (
          <TransferDialog
            projectId={projectId}
            documentId={documentId}
            onClose={() => {
              setTransferOpen(false);
            }}
          />
        )}
      </section>
    );
  }

  // ---- پیش‌نویس / بایگانی‌شده ----
  if (state === undefined) return <LoadingView />;
  const { doc, local } = state;
  const editable = doc.status === 'draft' && !conflict && !saveBusy;
  const activeSheet =
    local.sheets.find((sheet) => sheet.sheetId === activeSheetId) ?? local.sheets[0];
  const lineRefs = allLines(local.sheets);
  const existingLineIds = new Set(lineRefs.map((ref) => ref.line.lineId));

  const editLocal = (updater: (current: SaveTakeoffContent) => SaveTakeoffContent): void => {
    setPhase((current) => {
      if (current.kind !== 'document') return current;
      return { kind: 'document', state: { ...current.state, local: updater(current.state.local) } };
    });
    setSaveState('idle');
    setSaveError(undefined);
  };

  const patchSheet = (sheetId: string, updater: (sheet: TakeoffSheet) => TakeoffSheet): void => {
    editLocal((current) => ({
      ...current,
      sheets: current.sheets.map((sheet) => (sheet.sheetId === sheetId ? updater(sheet) : sheet)),
    }));
  };

  // P7-S2: محاسبهٔ پیش‌نمایش روی «آخرین نسخهٔ ذخیره‌شده» اجرا می‌شود (سمت سرور)؛ به همین
  // دلیل مثل نهایی‌سازی فقط با سند بدون تغییر فعال است. هیچ چیزی ذخیره یا نهایی نمی‌شود.
  const runPreview = (): void => {
    if (projectId === undefined || documentId === undefined) return;
    setPreviewBusy(true);
    setPreviewError(undefined);
    api
      .previewTakeoffCalculation(projectId, documentId)
      .then(
        (result) => {
          setPreviewResult(result);
        },
        (cause: unknown) => {
          setPreviewResult(undefined);
          setPreviewError(cause instanceof Error ? cause : new Error(String(cause)));
        },
      )
      .finally(() => {
        setPreviewBusy(false);
      });
  };

  const save = (): void => {
    if (projectId === undefined || documentId === undefined) return;
    const issues = collectSaveIssues(local);
    if (issues.length > 0) {
      setSaveError(new FormValidationError(issues.join(' ')));
      setSaveState('failed');
      return;
    }
    setSaveBusy(true);
    setSaveError(undefined);
    setSaveState('idle');
    api
      .saveTakeoffDraft(projectId, documentId, doc.revision, canonicalContent(local))
      .then(
        (saved) => {
          // نسخهٔ سرور جایگزین می‌شود (revision جدید از پاسخ) — محلی = سرور
          setPhase({ kind: 'document', state: { doc: saved, local: contentOf(saved) } });
          setSaveState('saved');
          setConflict(false);
          setPreviewResult(undefined); // محتوای سند عوض شد؛ پیش‌نمایش قبلی دیگر معتبر نیست
        },
        (cause: unknown) => {
          if (cause instanceof ApiError && cause.code === 'PERSISTENCE_CONFLICT') {
            setConflict(true); // ویرایش محلی دست‌نخورده می‌ماند
          } else {
            setSaveError(cause instanceof Error ? cause : new Error(String(cause)));
            setSaveState('failed');
          }
        },
      )
      .finally(() => {
        setSaveBusy(false);
      });
  };

  const runLifecycle = (action: 'archive' | 'unarchive' | 'finalize'): void => {
    if (projectId === undefined || documentId === undefined) return;
    if (action === 'finalize') setFinalizeBusy(true);
    setLifecycleError(undefined);
    setFinalizeError(undefined);
    const onDocument = (updated: TakeoffDocument): void => {
      setPhase({ kind: 'document', state: { doc: updated, local: contentOf(updated) } });
    };
    const onFinalized = (bundle: FinalizedTakeoffBundle): void => {
      setPhase({ kind: 'finalized', bundle });
      setFinalizeAsk(false);
    };
    const onFailure = (cause: unknown): void => {
      const error = cause instanceof Error ? cause : new Error(String(cause));
      if (action === 'finalize') setFinalizeError(error);
      else setLifecycleError(error);
    };
    const done = (): void => {
      setFinalizeBusy(false);
    };
    if (action === 'archive') {
      api
        .archiveTakeoff(projectId, documentId, doc.revision)
        .then(onDocument, onFailure)
        .finally(done);
    } else if (action === 'unarchive') {
      api
        .unarchiveTakeoff(projectId, documentId, doc.revision)
        .then(onDocument, onFailure)
        .finally(done);
    } else {
      api
        .finalizeTakeoff(projectId, documentId, doc.revision)
        .then(onFinalized, onFailure)
        .finally(done);
    }
  };

  // هشدار ارجاع‌های آویزان (نشان‌دهی وابستگی؛ حل مقدار فقط با موتور است)
  const danglingWarnings: string[] = [];
  for (const ref of lineRefs) {
    for (const target of referencedLineIds(ref.line.quantity)) {
      if (!existingLineIds.has(target)) {
        danglingWarnings.push(
          `ردیف ${ref.line.lineId} به ردیف ${target} ارجاع می‌دهد که در سند وجود ندارد.`,
        );
      }
    }
  }

  const removalLine =
    lineRemoval === undefined
      ? undefined
      : lineRefs.find((ref) => ref.line.lineId === lineRemoval.lineId);
  const removalDependents =
    removalLine === undefined
      ? []
      : lineRefs
          .filter((ref) => referencedLineIds(ref.line.quantity).includes(removalLine.line.lineId))
          .map((ref) => ref.line.lineId);

  return (
    <section aria-labelledby="takeoff-title">
      <Breadcrumb projectTitle={project.data?.title} />
      <div className="page-head">
        <h1 id="takeoff-title">
          {local.title === '' ? 'سند صورت‌برداشت بدون عنوان' : local.title}
        </h1>
        {doc.status === 'draft' && (
          <div className="page-head-actions">
            <span
              className={`save-state save-state-${dirty ? 'dirty' : saveState === 'saved' ? 'saved' : 'clean'}`}
            >
              {saveBusy
                ? 'در حال ذخیره…'
                : conflict
                  ? 'تعارض نسخه'
                  : dirty
                    ? 'تغییرات ذخیره‌نشده'
                    : saveState === 'saved'
                      ? 'ذخیره شد'
                      : 'بدون تغییر'}
            </span>
            <Button disabled={!editable || !dirty} onClick={save}>
              ذخیرهٔ تغییرات
            </Button>
            <Button
              disabled={!editable || dirty || saveBusy}
              busy={previewBusy}
              onClick={runPreview}
            >
              پیش‌نمایش محاسبه
            </Button>
            <Button
              disabled={!editable || dirty || saveBusy}
              onClick={() => {
                setFinalizeAsk(true);
                setFinalizeError(undefined);
              }}
            >
              نهایی‌سازی
            </Button>
            <Button
              disabled={!editable || dirty || saveBusy}
              onClick={() => {
                runLifecycle('archive');
              }}
            >
              بایگانی
            </Button>
          </div>
        )}
        {doc.status === 'archived' && (
          <div className="page-head-actions">
            <Button
              variant="primary"
              onClick={() => {
                runLifecycle('unarchive');
              }}
            >
              بازگردانی از بایگانی
            </Button>
          </div>
        )}
      </div>

      <div className="info-grid">
        <InfoRow label="شمارهٔ سند">
          <Ltr>{String(doc.documentNumber)}</Ltr>
        </InfoRow>
        <InfoRow label="وضعیت">
          <Badge tone={doc.status === 'draft' ? 'draft' : 'neutral'}>
            {takeoffStatusLabel(doc.status)}
          </Badge>
        </InfoRow>
        <InfoRow label="نسخهٔ سند (revision)">
          <Ltr>{String(doc.revision)}</Ltr>
        </InfoRow>
        <InfoRow label="شناسهٔ سند">
          <Ltr>{doc.documentId}</Ltr>
        </InfoRow>
        <InfoRow label="زنجیرهٔ متره">
          <Ltr>{doc.takeoffId}</Ltr>
        </InfoRow>
        <InfoRow label="تاریخ ایجاد">{formatInstant(doc.createdAt)}</InfoRow>
        {doc.archivedAt !== undefined && (
          <InfoRow label="بایگانی‌شده در">{formatInstant(doc.archivedAt)}</InfoRow>
        )}
      </div>

      {doc.status === 'draft' && (
        <div className="form">
          <Field label="عنوان سند *">
            <TextInput
              value={local.title}
              disabled={!editable}
              aria-label="عنوان سند"
              onChange={(event) => {
                editLocal((current) => ({ ...current, title: event.target.value }));
              }}
            />
          </Field>
        </div>
      )}

      {doc.status === 'archived' && (
        <p className="state-hint">
          سند بایگانی‌شده فقط خواندنی است؛ با «بازگردانی» دوباره پیش‌نویسِ قابل ویرایش می‌شود.
        </p>
      )}

      {doc.status === 'draft' && (
        <p className="state-hint">
          گزارش‌های PDF و Excel فقط برای سند نهایی‌شده ساخته می‌شوند؛ پس از نهایی‌سازی در همین صفحه
          قابل دریافت‌اند.
        </p>
      )}

      {doc.status === 'draft' && (
        <section className="takeoff-preview" aria-labelledby="takeoff-preview-title">
          <h2 className="section-title" id="takeoff-preview-title">
            پیش‌نمایش محاسبه
          </h2>
          <p className="state-hint">
            پیش‌نمایش، محاسبه را روی آخرین نسخهٔ ذخیره‌شدهٔ سرور اجرا می‌کند؛ هیچ چیزی ذخیره یا
            نهایی نمی‌شود، نسخهٔ سند تغییر نمی‌کند و نتیجه قابل انتقال به برآورد نیست. برای نتیجهٔ
            تغییرناپذیر، «نهایی‌سازی» را اجرا کنید.
          </p>
          {previewError !== undefined && (
            <div className="error-banner" role="alert">
              <p>{previewError.message}</p>
              {previewError instanceof ApiError &&
                previewError.code === 'TAKEOFF_SOLUTION_REJECTED' && (
                  <ul>
                    {takeoffFailureHints(previewError.details).map((hint) => (
                      <li key={hint}>{hint}</li>
                    ))}
                  </ul>
                )}
            </div>
          )}
          {previewResult !== undefined && (
            <TakeoffResultView bundle={{ document: doc, result: previewResult }} preview />
          )}
        </section>
      )}

      {conflict && (
        <div className="conflict-banner" role="alert">
          <p className="conflict-message">{TAKEOFF_CONFLICT_MESSAGE}</p>
          <p className="field-hint">
            تغییرات محلی شما حفظ شده و بازنویسی نشده‌اند؛ با دریافت نسخهٔ جدید، تغییرات ذخیره‌نشدهٔ
            این صفحه کنار گذاشته می‌شود.
          </p>
          <div className="form-actions">
            <Button
              variant="primary"
              onClick={() => {
                setReloadTick((tick) => tick + 1);
              }}
            >
              دریافت نسخهٔ جدید
            </Button>
          </div>
        </div>
      )}

      <FormError error={lifecycleError} />
      <FormError error={saveError} />

      {danglingWarnings.length > 0 && doc.status === 'draft' && (
        <div className="warning-banner" role="status">
          <p className="warning-title">ارجاع‌های ناموجود (در نهایی‌سازی رد می‌شوند):</p>
          <ul>
            {danglingWarnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}

      {/* --- برگه‌ها --- */}
      <div className="sheet-tabs" role="tablist" aria-label="برگه‌های سند">
        {local.sheets.map((sheet) => (
          <button
            key={sheet.sheetId}
            type="button"
            role="tab"
            aria-selected={activeSheet?.sheetId === sheet.sheetId}
            className={`sheet-tab ${activeSheet?.sheetId === sheet.sheetId ? 'sheet-tab-active' : ''}`}
            onClick={() => {
              setActiveSheetId(sheet.sheetId);
            }}
          >
            {sheet.name} ({String(sheet.lines.length)})
          </button>
        ))}
        <Button
          disabled={!editable}
          onClick={() => {
            setManageSheets(true);
          }}
        >
          مدیریت برگه‌ها
        </Button>
        {activeSheet !== undefined && editable && (
          <Button
            variant="primary"
            onClick={() => {
              const rowNos = activeSheet.lines.map((line) => line.rowNo);
              const nextRowNo = rowNos.length === 0 ? 1 : Math.max(...rowNos) + 1;
              setLineDialog({
                mode: 'create',
                sheetId: activeSheet.sheetId,
                line: newLine(newLineId([...existingLineIds]), nextRowNo),
              });
            }}
          >
            + ردیف جدید
          </Button>
        )}
      </div>

      {/* --- جدول ردیف‌های برگهٔ فعال --- */}
      {activeSheet === undefined ? (
        <p className="state-hint">این سند برگه‌ای ندارد؛ از «مدیریت برگه‌ها» یک برگه بسازید.</p>
      ) : (
        <div className="table-wrap">
          <table className="boq-table takeoff-table">
            <thead>
              <tr>
                <th>ردیف</th>
                <th>شناسه</th>
                <th>شرح</th>
                <th>محل</th>
                <th>کد آیتم</th>
                <th>نوع</th>
                <th>واحد</th>
                <th>مقدار / فرمول</th>
                <th>یادداشت</th>
                {editable && <th>عملیات</th>}
              </tr>
            </thead>
            <tbody>
              {activeSheet.lines.map((line) => (
                <tr key={line.lineId}>
                  <td className="cell-num">
                    <Ltr>{String(line.rowNo)}</Ltr>
                  </td>
                  <td className="cell-code">
                    <Ltr>{line.lineId}</Ltr>
                  </td>
                  <td className="cell-desc">{line.description}</td>
                  <td>{line.location ?? <span className="cell-null">—</span>}</td>
                  <td className="cell-code">
                    {line.itemCode == null || line.itemCode === '' ? (
                      <span className="cell-null">—</span>
                    ) : (
                      <Ltr>{line.itemCode}</Ltr>
                    )}
                  </td>
                  <td>{line.kind === 'addition' ? 'افزایش' : 'کسر'}</td>
                  <td className="cell-code">
                    <Ltr>{line.unit}</Ltr>
                  </td>
                  <td className="cell-code">
                    <QuantityDisplay line={line} />
                  </td>
                  <td className="cell-notes">
                    {line.notes ?? <span className="cell-null">—</span>}
                  </td>
                  {editable && (
                    <td className="cell-actions">
                      <Button
                        onClick={() => {
                          setLineDialog({ mode: 'edit', sheetId: activeSheet.sheetId, line });
                        }}
                      >
                        ویرایش
                      </Button>
                      <Button
                        onClick={() => {
                          setLineRemoval({ sheetId: activeSheet.sheetId, lineId: line.lineId });
                        }}
                      >
                        حذف
                      </Button>
                    </td>
                  )}
                </tr>
              ))}
              {activeSheet.lines.length === 0 && (
                <tr>
                  <td colSpan={editable ? 10 : 9} className="cell-empty">
                    این برگه ردیفی ندارد.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <RoundingRulesPanel
        rules={local.rounding}
        disabled={!editable}
        sheets={local.sheets}
        onChange={(rounding) => {
          editLocal((current) => ({ ...current, rounding }));
        }}
      />

      {/* --- گفت‌وگوی ردیف --- */}
      {lineDialog !== undefined && (
        <LineDialog
          mode={lineDialog.mode}
          sheetName={local.sheets.find((sheet) => sheet.sheetId === lineDialog.sheetId)?.name ?? ''}
          line={lineDialog.line}
          sheets={local.sheets}
          onClose={() => {
            setLineDialog(undefined);
          }}
          onSubmit={(line) => {
            const target = lineDialog.sheetId;
            if (lineDialog.mode === 'create') {
              patchSheet(target, (sheet) => ({ ...sheet, lines: [...sheet.lines, line] }));
            } else {
              patchSheet(target, (sheet) => ({
                ...sheet,
                lines: sheet.lines.map((candidate) =>
                  candidate.lineId === lineDialog.line.lineId ? line : candidate,
                ),
              }));
            }
            setLineDialog(undefined);
          }}
        />
      )}

      {/* --- تأیید حذف ردیف (با نشان‌دهی وابستگی) --- */}
      {removalLine !== undefined && lineRemoval !== undefined && (
        <Modal
          title={`حذف ردیف ${removalLine.line.lineId}`}
          onClose={() => {
            setLineRemoval(undefined);
          }}
        >
          <div className="form">
            <p>
              ردیف «
              {removalLine.line.description === '' ? 'بدون شرح' : removalLine.line.description}» از
              برگه حذف می‌شود (تا ذخیره نشود، فقط محلی است).
            </p>
            {removalDependents.length > 0 && (
              <p className="warning-title">
                هشدار: ردیف‌های <Ltr>{removalDependents.join('، ')}</Ltr> به این ردیف ارجاع می‌دهند؛
                با حذف، ارجاع‌شان ناموجود می‌شود و نهایی‌سازی رد می‌شود.
              </p>
            )}
            <div className="form-actions">
              <Button
                onClick={() => {
                  setLineRemoval(undefined);
                }}
              >
                انصراف
              </Button>
              <Button
                variant="primary"
                onClick={() => {
                  patchSheet(lineRemoval.sheetId, (sheet) => ({
                    ...sheet,
                    lines: sheet.lines.filter(
                      (candidate) => candidate.lineId !== lineRemoval.lineId,
                    ),
                  }));
                  setLineRemoval(undefined);
                }}
              >
                حذف ردیف
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {/* --- مدیریت برگه‌ها --- */}
      {manageSheets && (
        <SheetsManager
          sheets={local.sheets}
          references={lineRefs.map((ref) => ({
            lineId: ref.line.lineId,
            targets: referencedLineIds(ref.line.quantity),
          }))}
          onClose={() => {
            setManageSheets(false);
          }}
          onChange={(sheets) => {
            editLocal((current) => ({ ...current, sheets }));
          }}
        />
      )}

      {/* --- تأیید نهایی‌سازی --- */}
      {finalizeAsk && (
        <Modal
          title="نهایی‌سازی سند صورت‌برداشت"
          onClose={() => {
            setFinalizeAsk(false);
            setFinalizeError(undefined);
          }}
        >
          <div className="form">
            <p>
              موتور محاسبه سمت سرور اجرا می‌شود و نتیجه در یک snapshot تغییرناپذیر ثبت می‌شود. پس از
              نهایی‌سازی، این سند دیگر قابل ویرایش نیست؛ برای تغییرات بعدی باید سند پیرو بسازید. اگر
              محاسبه رد شود، هیچ چیزی نهایی نمی‌شود و سند پیش‌نویس می‌ماند.
            </p>
            {finalizeError !== undefined && (
              <div className="error-banner" role="alert">
                <p>{finalizeError.message}</p>
                {finalizeError instanceof ApiError &&
                  finalizeError.code === 'TAKEOFF_CALCULATION_FAILED' && (
                    <ul>
                      {takeoffEngineHints(finalizeError.serverMessage).map((hint) => (
                        <li key={hint}>{hint}</li>
                      ))}
                    </ul>
                  )}
              </div>
            )}
            <div className="form-actions">
              <Button
                onClick={() => {
                  setFinalizeAsk(false);
                  setFinalizeError(undefined);
                }}
              >
                انصراف
              </Button>
              <Button
                variant="primary"
                busy={finalizeBusy}
                onClick={() => {
                  runLifecycle('finalize');
                }}
              >
                نهایی‌سازی قطعی
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

// -------------------------------------------------------------------------------------------------

function Breadcrumb({ projectTitle }: { projectTitle: string | undefined }): ReactElement {
  const { projectId } = useParams<{ projectId: string }>();
  return (
    <nav className="breadcrumb">
      <Link to="/projects" className="link">
        پروژه‌ها
      </Link>
      <span aria-hidden="true">›</span>
      <Link to={projectId === undefined ? '/projects' : `/projects/${projectId}`} className="link">
        {projectTitle ?? 'پروژه'}
      </Link>
      <span aria-hidden="true">›</span>
      <span>صورت‌برداشت</span>
    </nav>
  );
}

function InfoRow({
  label,
  children,
}: {
  label: string;
  children: ReactElement | string;
}): ReactElement {
  return (
    <div className="info-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** مسائل شکل سند پیش از ارسال (تکراری‌ها + شکل هر ردیف) — هیچ‌وقت به سرور نمی‌رسد. */
function collectSaveIssues(content: SaveTakeoffContent): readonly string[] {
  const issues: string[] = [];
  if (content.title.trim().length === 0) issues.push('عنوان سند را وارد کنید.');
  issues.push(...duplicateKeyIssues(content.sheets));
  for (const ref of allLines(content.sheets)) {
    const shape = validateLineShape(ref.line);
    if (shape.issues.length > 0) issues.push(`ردیف ${ref.line.lineId}: ${shape.issues.join(' ')}`);
  }
  return issues;
}

// -------------------------------------------------------------------------------------------------
// مدیریت برگه‌ها (کاملاً سمت کلاینت — سند کامل ذخیره می‌شود، نه برگه‌به‌برگه)
// -------------------------------------------------------------------------------------------------

function SheetsManager({
  sheets,
  references,
  onClose,
  onChange,
}: {
  sheets: readonly TakeoffSheet[];
  /** برای هشدار وابستگی هنگام حذف برگه: خط‌ها به کدام شناسه‌ها ارجاع می‌دهند. */
  references: readonly { readonly lineId: string; readonly targets: readonly string[] }[];
  onClose: () => void;
  onChange: (next: readonly TakeoffSheet[]) => void;
}): ReactElement {
  const [newName, setNewName] = useState('');
  const [confirmId, setConfirmId] = useState<string | undefined>(undefined);
  const [rename, setRename] = useState<Record<string, string>>({});

  const addSheet = (): void => {
    const name = newName.trim();
    if (name === '') return;
    onChange([...sheets, newSheet(newSheetId(sheets.map((sheet) => sheet.sheetId)), name)]);
    setNewName('');
  };

  const sheetById = (sheetId: string): TakeoffSheet | undefined =>
    sheets.find((sheet) => sheet.sheetId === sheetId);
  const confirmSheet = confirmId === undefined ? undefined : sheetById(confirmId);
  const confirmDependents =
    confirmSheet === undefined
      ? []
      : references
          .filter((ref) =>
            ref.targets.some((target) => confirmSheet.lines.some((line) => line.lineId === target)),
          )
          .map((ref) => ref.lineId);

  return (
    <Modal title="مدیریت برگه‌های سند" onClose={onClose}>
      <div className="form">
        <p className="field-hint">
          برگه‌ها فقط در همین صفحه سازماندهی می‌شوند؛ با «ذخیرهٔ تغییرات» کل سند یکجا ذخیره می‌شود.
          شناسهٔ برگه پایدار است و در نتیجه و ارجاع‌ها استفاده می‌شود.
        </p>
        <ul className="sheet-manage-list">
          {sheets.map((sheet) => (
            <li key={sheet.sheetId} className="sheet-manage-row">
              <Field label={`نام برگه (${String(sheet.lines.length)} ردیف)`}>
                <TextInput
                  value={rename[sheet.sheetId] ?? sheet.name}
                  aria-label={`نام برگه ${sheet.sheetId}`}
                  onChange={(event) => {
                    setRename((current) => ({ ...current, [sheet.sheetId]: event.target.value }));
                  }}
                  onBlur={() => {
                    const value = (rename[sheet.sheetId] ?? '').trim();
                    if (value !== '' && value !== sheet.name) {
                      onChange(
                        sheets.map((candidate) =>
                          candidate.sheetId === sheet.sheetId
                            ? { ...candidate, name: value }
                            : candidate,
                        ),
                      );
                    }
                  }}
                />
              </Field>
              <span className="field-hint">
                شناسه: <Ltr>{sheet.sheetId}</Ltr>
              </span>
              <Button
                onClick={() => {
                  setConfirmId(sheet.sheetId);
                }}
                disabled={sheets.length <= 1}
              >
                حذف برگه
              </Button>
              {confirmSheet?.sheetId === sheet.sheetId && (
                <div className="warning-banner">
                  <p>
                    حذف برگه «{sheet.name}» با {String(sheet.lines.length)} ردیف.
                    {confirmDependents.length > 0 && (
                      <>
                        {' '}
                        ردیف‌های <Ltr>{confirmDependents.join('، ')}</Ltr> به ردیف‌های این برگه
                        ارجاع می‌دهند و با حذف، ارجاع‌شان ناموجود می‌شود.
                      </>
                    )}
                  </p>
                  <div className="form-actions">
                    <Button
                      onClick={() => {
                        setConfirmId(undefined);
                      }}
                    >
                      انصراف
                    </Button>
                    <Button
                      variant="primary"
                      onClick={() => {
                        onChange(sheets.filter((candidate) => candidate.sheetId !== sheet.sheetId));
                        setConfirmId(undefined);
                      }}
                    >
                      حذف قطعی برگه
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
        <div className="form-row">
          <Field label="نام برگهٔ جدید *">
            <TextInput
              value={newName}
              aria-label="نام برگهٔ جدید"
              onChange={(event) => {
                setNewName(event.target.value);
              }}
            />
          </Field>
          <Button variant="primary" disabled={newName.trim() === ''} onClick={addSheet}>
            + افزودن برگه
          </Button>
        </div>
        <div className="form-actions">
          <Button variant="primary" onClick={onClose}>
            انجام شد
          </Button>
        </div>
      </div>
    </Modal>
  );
}
