/**
 * تغییر گذرواژهٔ خودکار حساب (P8-A S1، CG-GOV@0.1.0 §1.2): گذرواژهٔ کنونی تأیید و
 * گذرواژهٔ جدید (۸ تا ۱۲۸ نویسه) تنظیم می‌شود؛ همهٔ نشست‌های دیگری از این کاربر
 * باطل می‌شوند ولی نشست جاری معتبر می‌ماند. هیچ اطلاعاتی از گذرواژه در پاسخ‌ها
 * بازنمی‌گردد.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import { useApi } from '../../api/context.js';
import { useSession } from './AuthenticatedApp.js';

export function PasswordChangeDialog({ onClose }: { onClose: () => void }): ReactElement {
  const api = useApi();
  const session = useSession();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (currentPassword.length === 0 || newPassword.length === 0) {
      setError('هر دو گذرواژه را وارد کنید.');
      return;
    }
    if (newPassword.length < 8 || newPassword.length > 128) {
      setError('گذرواژهٔ جدید باید بین ۸ تا ۱۲۸ نویسه باشد.');
      return;
    }
    if (newPassword !== confirmation) {
      setError('تکرار گذرواژهٔ جدید با خودش یکسان نیست.');
      return;
    }
    setBusy(true);
    setError(undefined);
    api
      .changePassword(currentPassword, newPassword)
      .then(
        () => {
          onClose();
        },
        (cause: unknown) => {
          setError(cause instanceof Error ? cause.message : 'تغییر گذرواژه انجام نشد.');
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="modal" role="dialog" aria-modal="true" aria-labelledby="password-title">
        <h2 id="password-title">تغییر گذرواژه — {session.username}</h2>
        <form onSubmit={submit} noValidate>
          <label htmlFor="current-password">گذرواژهٔ کنونی</label>
          <input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={currentPassword}
            onChange={(event) => {
              setCurrentPassword(event.target.value);
            }}
          />
          <label htmlFor="new-password">گذرواژهٔ جدید (۸ تا ۱۲۸ نویسه)</label>
          <input
            id="new-password"
            type="password"
            autoComplete="new-password"
            value={newPassword}
            onChange={(event) => {
              setNewPassword(event.target.value);
            }}
          />
          <label htmlFor="confirm-password">تکرار گذرواژهٔ جدید</label>
          <input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirmation}
            onChange={(event) => {
              setConfirmation(event.target.value);
            }}
          />
          {error !== undefined && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          <div className="form-actions">
            <button type="button" onClick={onClose}>
              انصراف
            </button>
            <button type="submit" disabled={busy}>
              {busy ? 'در حال ثبت…' : 'ثبت گذرواژهٔ جدید'}
            </button>
          </div>
        </form>
      </section>
    </div>
  );
}
