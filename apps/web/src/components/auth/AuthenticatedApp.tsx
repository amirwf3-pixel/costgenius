/**
 * دروازهٔ نشست برنامه (P8-A S1) — پیش از نمایش هر مسیری، نشست سرور پرسیده می‌شود:
 * - در حال بررسی → نشانگر بارگذاری؛
 * - بدون نشست (401) → صفحهٔ ورود؛ پس از ورود موفق، برنامه ادامه می‌یابد؛
 *   سایر خطاها (از جمله عدم دسترسی به API) → پیام خطا با «تلاش مجدد»؛
 *   خطای شبکه هرگز به‌عنوان «بدون نشست» تفسیر نمی‌شود (§14)؛
 * - با نشست معتبر → محتوای برنامه به‌همراه نوار حساب کاربری (نام کاربر،
 *   تغییر گذرواژه و خروج).
 *
 * نقش‌ها هنوز هیچ سطری از رابط کاربری را محدود نمی‌کنند — RBAC در S2 است.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactElement,
} from 'react';
import { ApiError } from '../../api/client.js';
import { useApi } from '../../api/context.js';
import type { AuthSession } from '../../api/types.js';
import { PasswordChangeDialog } from './PasswordChangeDialog.js';
import { LoginPage } from './LoginPage.js';

/** The current authenticated session (P8-A S1); defined everywhere inside AuthenticatedApp. */
const SessionContext = createContext<AuthSession | undefined>(undefined);

export function useSession(): AuthSession {
  const session = useContext(SessionContext);
  if (session === undefined) throw new Error('useSession requires an authenticated app');
  return session;
}

export function AuthenticatedApp({ children }: { children: ReactElement }): ReactElement {
  const api = useApi();
  const [session, setSession] = useState<AuthSession | undefined>(undefined);
  const [checked, setChecked] = useState(false);
  const [showPasswordChange, setShowPasswordChange] = useState(false);
  const [loggedOut, setLoggedOut] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [retryCount, setRetryCount] = useState(0);

  const retry = useCallback(() => {
    setChecked(false);
    setUnreachable(false);
    setRetryCount((count) => count + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .getSession()
      .then(
        (current) => {
          if (!cancelled) setSession(current);
        },
        (error: unknown) => {
          if (cancelled) return;
          if (error instanceof ApiError && error.status === 401) {
            // فقط 401 یعنی «بدون نشست» — صفحهٔ ورود
            setSession(undefined);
          } else {
            // خطای شبکه/سرور هرگز «بدون نشست» نیست (§14) — تلاش مجدد
            setUnreachable(true);
          }
        },
      )
      .finally(() => {
        if (!cancelled) setChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [api, retryCount]);

  if (!checked) {
    return (
      <section className="login-page" aria-label="بررسی نشست">
        <p>بررسی نشست…</p>
      </section>
    );
  }

  if (unreachable) {
    return (
      <section className="login-page" aria-label="API در دسترس نیست">
        <p>CostGenius API در دسترس نیست.</p>
        <button type="button" onClick={retry}>
          تلاش مجدد
        </button>
      </section>
    );
  }

  if (session === undefined) {
    return (
      <>
        {loggedOut && (
          <p role="status" className="logout-notice">
            نشست شما پایان یافت.
          </p>
        )}
        <LoginPage
          onLogin={(next) => {
            setLoggedOut(false);
            setSession(next);
          }}
        />
      </>
    );
  }

  const logout = (): void => {
    void api.logout().finally(() => {
      setSession(undefined);
      setLoggedOut(true);
    });
  };

  return (
    <SessionContext.Provider value={session}>
      {children}
      <AccountBar
        username={session.username}
        onLogout={logout}
        onChangePassword={() => {
          setShowPasswordChange(true);
        }}
      />
      {showPasswordChange && (
        <PasswordChangeDialog
          onClose={() => {
            setShowPasswordChange(false);
          }}
        />
      )}
    </SessionContext.Provider>
  );
}

/** Minimal current-user bar: username + password change + logout (S1 scope only). */
function AccountBar({
  username,
  onLogout,
  onChangePassword,
}: {
  username: string;
  onLogout: () => void;
  onChangePassword: () => void;
}): ReactElement {
  return (
    <aside className="account-bar" aria-label="حساب کاربری">
      <span className="account-username" aria-label="کاربر جاری">
        کاربر: {username}
      </span>
      <button type="button" onClick={onChangePassword}>
        تغییر گذرواژه
      </button>
      <button type="button" onClick={onLogout}>
        خروج
      </button>
    </aside>
  );
}
