/**
 * صفحهٔ ورود (P8-A S1، CG-GOV@0.1.0 §1) — تنها مسیر دسترسی به برنامه وقتی نشست
 * معتبری وجود ندارد. خطای اعتبارسنجی یا 401 با پیام فارسی واحد نشان داده می‌شود
 * («نام کاربری یا گذرواژه نادرست است.») — سرور هرگز تفکیک کاربر ناشناخته از
 * گذرواژهٔ نادرست را لو نمی‌دهد و این صفحه هم همین رفتار را حفظ می‌کند.
 * هیچگونه ذخیرهٔ رمز یا نشست در مرورگر انجام نمی‌شود؛ کوکی HttpOnly سرور،
 * تنها حامل نشست است.
 */
import { useState, type FormEvent, type ReactElement } from 'react';
import { useApi } from '../../api/context.js';
import type { AuthSession } from '../../api/types.js';

export function LoginPage({ onLogin }: { onLogin: (session: AuthSession) => void }): ReactElement {
  const api = useApi();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (username.length === 0 || password.length === 0) {
      setError('نام کاربری و گذرواژه را وارد کنید.');
      return;
    }
    setBusy(true);
    setError(undefined);
    api
      .login(username, password)
      .then(
        (session) => {
          onLogin(session);
        },
        (cause: unknown) => {
          setError(cause instanceof Error ? cause.message : 'ورود انجام نشد.');
        },
      )
      .finally(() => {
        setBusy(false);
      });
  };

  return (
    <section className="login-page" aria-labelledby="login-title">
      <h1 id="login-title">ورود به CostGenius</h1>
      <form onSubmit={submit} noValidate>
        <label htmlFor="login-username">نام کاربری</label>
        <input
          id="login-username"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(event) => {
            setUsername(event.target.value);
          }}
        />
        <label htmlFor="login-password">گذرواژه</label>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        {error !== undefined && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy}>
          {busy ? 'در حال ورود…' : 'ورود'}
        </button>
      </form>
      <p className="login-note">
        دسترسی با حساب سازمانی شما انجام می‌شود؛ نشست ۱۲ ساعت اعتبار دارد.
      </p>
    </section>
  );
}
