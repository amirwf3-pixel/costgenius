/**
 * مسیرهای برنامه (§8) — مسیرهای واقعی گردش کار + یک صفحه درباره:
 * /projects (فهرست)، /projects/:id (پروژه)، /estimates/:id (برآورد)،
 * /versions/:id (میزکار نسخه) و /projects/:projectId/takeoffs/:documentId
 * (میزکار سند صورت‌برداشت کامل، D-016). «/» به /projects هدایت می‌شود.
 *
 * P8-A S1: کل برنامه پشت دروازهٔ نشست است (AuthenticatedApp) — بدون نشست معتبر،
 * هیچ مسیری رندر نمی‌شود و صفحهٔ ورود نشان داده می‌شود.
 */
import { Navigate, Route, Routes } from 'react-router-dom';
import type { ReactElement } from 'react';
import { AppShell } from './components/layout/AppShell.js';
import { ProjectsPage } from './components/projects/ProjectsPage.js';
import { ProjectDetailPage } from './components/projects/ProjectDetailPage.js';
import { EstimateDetailPage } from './components/estimates/EstimateDetailPage.js';
import { VersionWorkspacePage } from './components/versions/VersionWorkspacePage.js';
import { TakeoffWorkspacePage } from './components/takeoff/TakeoffWorkspacePage.js';
import { AuthenticatedApp } from './components/auth/AuthenticatedApp.js';

export function App(): ReactElement {
  return (
    <AuthenticatedApp>
      <AppShell>
        <Routes>
          <Route path="/" element={<Navigate to="/projects" replace />} />
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
          <Route
            path="/projects/:projectId/takeoffs/:documentId"
            element={<TakeoffWorkspacePage />}
          />
          <Route path="/estimates/:estimateId" element={<EstimateDetailPage />} />
          <Route path="/versions/:versionId" element={<VersionWorkspacePage />} />
          <Route
            path="/about"
            element={
              <section>
                <h1>درباره CostGenius</h1>
                <p>
                  سامانه برآورد ابنیه بر پایه فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴ (اطلاعیه
                  ۱۴۰۳/۷۴۲۹۴۸). قیمت‌ها فقط از فهرست رسمی خوانده می‌شوند؛ محاسبات با اعشار دقیق
                  انجام و نسخه‌های نهایی تغییرناپذیرند.
                </p>
              </section>
            }
          />
          <Route path="*" element={<Navigate to="/projects" replace />} />
        </Routes>
      </AppShell>
    </AuthenticatedApp>
  );
}
