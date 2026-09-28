/**
 * The application shell (§9): a header with brand + API status dot, a right-side
 * navigation (RTL) and the main content area. Desktop-first, responsive enough.
 */
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useApi } from '../../api/context.js';

export function AppShell({ children }: { children: ReactNode }): ReactElement {
  const api = useApi();
  const [online, setOnline] = useState<boolean | undefined>(undefined);
  const location = useLocation();

  useEffect(() => {
    let cancelled = false;
    const check = (): void => {
      void api.health().then((ok) => {
        if (!cancelled) setOnline(ok);
      });
    };
    check();
    const timer = window.setInterval(check, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [api]);

  return (
    <div className="shell">
      <header className="shell-header">
        <div className="brand">
          <span className="brand-name">CostGenius</span>
          <span className="brand-sub">سامانه برآورد ابنیه — فهرست‌بها ۱۴۰۴</span>
        </div>
        <div
          className="api-status"
          aria-label={online === false ? 'سرور در دسترس نیست' : 'سرور در دسترس است'}
        >
          <span
            className={`dot dot-${online === undefined ? 'unknown' : online ? 'ok' : 'down'}`}
            aria-hidden="true"
          />
          <span className="api-status-text">
            {online === undefined ? 'بررسی اتصال…' : online ? 'متصل' : 'قطع'}
          </span>
        </div>
      </header>
      <div className="shell-body">
        <nav className="shell-nav" aria-label="ناوبری اصلی">
          <Link
            to="/projects"
            className={location.pathname.startsWith('/projects') ? 'nav-link active' : 'nav-link'}
          >
            پروژه‌ها
          </Link>
          <Link
            to="/about"
            className={location.pathname === '/about' ? 'nav-link active' : 'nav-link'}
          >
            درباره
          </Link>
        </nav>
        <main className="shell-main">{children}</main>
      </div>
    </div>
  );
}
