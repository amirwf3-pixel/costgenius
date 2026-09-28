/**
 * UI primitives shared by every page: buttons, badges, modal, field, LTR-safe technical
 * text and the three resource states (loading / empty / error+retry). Small, semantic,
 * keyboard-accessible; no icon-only controls without labels (§42).
 */
import {
  forwardRef,
  useEffect,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactElement,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';

export function Button({
  variant = 'secondary',
  busy = false,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'danger';
  busy?: boolean;
}): ReactElement {
  return (
    <button
      type="button"
      className={`button button-${variant}`}
      disabled={rest.disabled === true || busy}
      aria-busy={busy}
      {...rest}
    >
      {busy ? 'در حال انجام…' : children}
    </button>
  );
}

export function Badge({
  tone,
  children,
}: {
  tone: 'draft' | 'finalized' | 'neutral';
  children: ReactNode;
}): ReactElement {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/** LTR-safe technical text: codes, decimals, ids, negative numbers (§41). */
export function Ltr({ children }: { children: ReactNode }): ReactElement {
  return <span className="ltr">{children}</span>;
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}): ReactElement {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint !== undefined && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function TextInput(props, ref) {
    return <input ref={ref} className="input" {...props} />;
  },
);

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  function Select(props, ref) {
    return <select ref={ref} className="input" {...props} />;
  },
);

/**
 * Tracks the last element focused OUTSIDE any modal, so a closing dialog can restore
 * focus to its opener even when the dialog's own autofocus input already moved focus
 * (child autofocus runs before the Modal's effects, so activeElement is unreliable).
 */
let lastFocusedOutsideModal: HTMLElement | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', () => {
    const el = document.activeElement;
    if (el instanceof HTMLElement && el.closest('.modal-backdrop') === null) {
      lastFocusedOutsideModal = el;
    }
  });
}

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}): ReactElement {
  const backdropRef = useRef<HTMLDivElement>(null);
  // Keyboard hardening: move focus INTO the dialog on open (an [autofocus] child if
  // present, else the dialog container) so Escape and Tab start inside it, and on
  // close restore focus to the opener recorded by the tracker above.
  useEffect(() => {
    const root = backdropRef.current;
    if (root !== null && !root.contains(document.activeElement)) {
      (root.querySelector<HTMLElement>('[autofocus]') ?? root).focus();
    }
    return () => {
      const opener = lastFocusedOutsideModal;
      if (opener !== null && opener.isConnected) opener.focus();
    };
  }, []);
  return (
    <div
      ref={backdropRef}
      tabIndex={-1}
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div className="modal">
        <div className="modal-head">
          <h2>{title}</h2>
          <button type="button" className="modal-close" onClick={onClose} aria-label="بستن">
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>
  );
}

export function LoadingView({ label = 'در حال بارگذاری…' }: { label?: string }): ReactElement {
  return (
    <div className="state-view" role="status">
      <span className="spinner" aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}

export function EmptyView({ title, hint }: { title: string; hint?: string }): ReactElement {
  return (
    <div className="state-view state-empty">
      <p className="state-title">{title}</p>
      {hint !== undefined && <p className="state-hint">{hint}</p>}
    </div>
  );
}

export function ErrorView({
  error,
  onRetry,
}: {
  error: Error;
  onRetry?: () => void;
}): ReactElement {
  const status = (error as { status?: unknown }).status;
  const unreachable =
    error.name === 'NetworkError' ||
    (error.name === 'ApiError' && typeof status === 'number' && status >= 500);
  return (
    <div className="state-view state-error" role="alert">
      <p className="state-title">
        {unreachable ? 'CostGenius API در دسترس نیست.' : 'خطا در دریافت اطلاعات'}
      </p>
      {!unreachable && <p className="state-hint">{error.message}</p>}
      {onRetry !== undefined && <Button onClick={onRetry}>تلاش مجدد</Button>}
    </div>
  );
}

/**
 * A client-side validation failure with a user-facing Persian message. FormError
 * renders these (and API/network errors) verbatim; unexpected internal errors still
 * collapse to the generic «خطای غیرمنتظره» so no internal detail ever leaks.
 */
export class FormValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormValidationError';
  }
}

/** Shows a mutation error inline without losing the form (§48). */
export function FormError({ error }: { error: Error | undefined }): ReactElement | null {
  if (error === undefined) return null;
  const message =
    error.name === 'ApiError' ||
    error.name === 'NetworkError' ||
    error.name === 'FormValidationError'
      ? error.message
      : 'خطای غیرمنتظره';
  return (
    <p className="form-error" role="alert">
      {message}
    </p>
  );
}
