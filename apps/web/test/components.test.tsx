/**
 * Component-level UX tests (§50): every page family plus the finalized read-only mode,
 * error/empty/loading states and the price-injection-proof add-line dialog — against a
 * fake API client injected through the same context the real app uses.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ApiProvider, type ApiClient } from '../src/api/context.js';
import { ProjectsPage } from '../src/components/projects/ProjectsPage.js';
import { ProjectDetailPage } from '../src/components/projects/ProjectDetailPage.js';
import { EstimateDetailPage } from '../src/components/estimates/EstimateDetailPage.js';
import { VersionWorkspacePage } from '../src/components/versions/VersionWorkspacePage.js';
import { BoqTable } from '../src/components/boq/BoqTable.js';
import type {
  Estimate,
  EstimateVersion,
  FinalizedTakeoffBundle,
  Project,
  TakeoffDocument,
  TakeoffListRow,
  TakeoffTransferResult,
  VersionOrBundle,
  AuthSession,
} from '../src/api/types.js';
import { TakeoffWorkspacePage } from '../src/components/takeoff/TakeoffWorkspacePage.js';
import { LoginPage } from '../src/components/auth/LoginPage.js';
import { AuthenticatedApp } from '../src/components/auth/AuthenticatedApp.js';
import { ApiError } from '../src/api/client.js';

afterEach(() => {
  cleanup();
});

const PROJECT: Project = {
  projectId: 'aaaaaaaa-bbbb-4ccc-9ddd-eeeeeeeeeeee',
  title: 'ساختمان اداری',
  metadata: { location: 'تهران' },
  createdAt: '2026-01-01T00:00:00Z',
};

const VERSION: EstimateVersion = {
  versionId: 'v-1',
  estimateId: 'e-1',
  versionNumber: 1,
  status: 'draft',
  createdAt: '2026-01-01T00:00:00Z',
  edition: '1404',
  buildingId: 'building-main',
  metadata: {},
  lines: [
    {
      lineId: 'l1',
      pricebookCode: '010101',
      chapter: 'chapter-1',
      group: '1',
      description: 'کندن و خارج کردن بوته و ریشه‌ها',
      unit: { code: 'm2', label: 'مترمربع' },
      quantity: '1000',
      basePrice: '2890',
      lineAmount: '2890000',
      calculationStatus: 'COMPLETE',
      edition: '1404',
      externalDependencies: [],
      notes: [],
      sourceRef: {
        sourceDocument: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
        edition: '1404',
        printedPage: '11',
        section: 'Chapter 1, Group 1',
      },
    },
    {
      lineId: 'l2',
      pricebookCode: '220925',
      chapter: 'chapter-22',
      group: '9',
      description: 'کسر بها به ردیف‌های ۲۲۰۹۱۰ تا ۲۲۰۹۱۸',
      unit: { code: 'm2', label: 'مترمربع' },
      quantity: '40',
      basePrice: null,
      lineAmount: null,
      calculationStatus: 'INCOMPLETE',
      edition: '1404',
      externalDependencies: [],
      notes: ['کسر بها'],
      sourceRef: {
        sourceDocument: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
        edition: '1404',
        printedPage: '186',
        section: 'Chapter 22, Group 9',
      },
    },
    {
      lineId: 'l3',
      pricebookCode: '270320',
      chapter: 'chapter-27',
      group: '3',
      description: 'کسر بها به ردیف ۲۷۰۳۰۱ و ۲۷۰۳۰۲',
      unit: { code: 'm3', label: 'مترمکعب' },
      quantity: '10',
      basePrice: '-1037000',
      lineAmount: '-10370000',
      calculationStatus: 'COMPLETE',
      edition: '1404',
      externalDependencies: [],
      notes: ['کسر بها'],
      sourceRef: {
        sourceDocument: 'فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴',
        edition: '1404',
        printedPage: '225',
        section: 'Chapter 27, Group 3',
      },
    },
  ],
};

const ESTIMATE: Estimate = {
  estimateId: 'e-1',
  projectId: PROJECT.projectId,
  title: 'برآورد اولیه',
  versions: [VERSION],
};

const TAKEOFF_DOC: TakeoffDocument = {
  documentId: 'dddddddd-1111-4222-8333-444444444444',
  takeoffId: 'tttttttt-1111-4222-8333-444444444444',
  projectId: PROJECT.projectId,
  title: 'متره مرحله اول',
  documentNumber: 1,
  status: 'draft',
  revision: 3,
  rounding: [],
  sheets: [
    {
      sheetId: 'S1',
      name: 'فونداسیون',
      lines: [
        {
          lineId: 'L1',
          rowNo: 1,
          description: 'کندن چاهک فونداسیون',
          location: 'محور A',
          itemCode: '010101',
          kind: 'addition',
          unit: 'm3',
          quantity: {
            type: 'dimensional',
            profile: 'LWH',
            length: '2',
            width: '1.5',
            height: '0.8',
          },
        },
        {
          lineId: 'L2',
          rowNo: 2,
          description: 'بتن مگر',
          kind: 'addition',
          unit: 'm3',
          quantity: { type: 'manual', value: '12.5', justification: 'بر اساس نقشه' },
        },
      ],
    },
    {
      sheetId: 'S2',
      name: 'دیوارچینی',
      lines: [
        {
          lineId: 'L3',
          rowNo: 1,
          description: 'جمع چاهک‌ها',
          kind: 'addition',
          unit: 'm3',
          quantity: {
            type: 'reference',
            terms: [{ lineId: 'L1', factor: '1', use: 'signed' }],
          },
        },
      ],
    },
  ],
  createdAt: '2026-01-02T00:00:00Z',
};

const TAKEOFF_BUNDLE: FinalizedTakeoffBundle = {
  document: { ...TAKEOFF_DOC, status: 'finalized', finalizedAt: '2026-01-03T00:00:00Z' },
  documentId: TAKEOFF_DOC.documentId,
  takeoffId: TAKEOFF_DOC.takeoffId,
  documentNumber: 1,
  finalizedAt: '2026-01-03T00:00:00Z',
  input: { sheets: TAKEOFF_DOC.sheets, rounding: TAKEOFF_DOC.rounding },
  result: {
    specId: 'CG-IR-MEAS',
    specVersion: '0.2.0',
    engineVersion: '1.0.0',
    status: 'ok',
    errors: [],
    lines: [
      {
        lineId: 'L1',
        sheetId: 'S1',
        rowNo: 1,
        itemCode: '010101',
        unit: 'm3',
        kind: 'addition',
        exactMagnitude: '2.4',
        signedValue: '2.4',
      },
      {
        lineId: 'L2',
        sheetId: 'S1',
        rowNo: 2,
        itemCode: null,
        unit: 'm3',
        kind: 'addition',
        exactMagnitude: '12.5',
        signedValue: '12.5',
      },
      {
        lineId: 'L3',
        sheetId: 'S2',
        rowNo: 1,
        itemCode: null,
        unit: 'm3',
        kind: 'addition',
        exactMagnitude: '2.4',
        signedValue: '2.4',
      },
    ],
    itemTotals: [
      {
        itemCode: '010101',
        unit: 'm3',
        exactQty: '2.4',
        qty: '2.4',
        lineIds: ['L1'],
      },
      {
        itemCode: null,
        unit: 'm3',
        exactQty: '14.9',
        qty: '14.9',
        lineIds: ['L2', 'L3'],
      },
    ],
    sheetTotals: [
      {
        sheetId: 'S1',
        byItem: [
          { itemCode: '010101', unit: 'm3', exactQty: '2.4', qty: '2.4', lineIds: ['L1'] },
          { itemCode: null, unit: 'm3', exactQty: '12.5', qty: '12.5', lineIds: ['L2'] },
        ],
      },
      {
        sheetId: 'S2',
        byItem: [{ itemCode: null, unit: 'm3', exactQty: '2.4', qty: '2.4', lineIds: ['L3'] }],
      },
    ],
  },
};

const TAKEOFF_LIST_ROW: TakeoffListRow = {
  documentId: TAKEOFF_DOC.documentId,
  takeoffId: TAKEOFF_DOC.takeoffId,
  documentNumber: 1,
  title: TAKEOFF_DOC.title,
  status: 'draft',
  revision: 3,
  createdAt: '2026-01-01T00:00:00Z',
};

const SAVED_TAKEOFF_DOC: TakeoffDocument = { ...TAKEOFF_DOC, revision: 4 };

const ARCHIVED_TAKEOFF_DOC: TakeoffDocument = {
  ...TAKEOFF_DOC,
  status: 'archived',
  archivedAt: '2026-01-04T00:00:00Z',
};

const FOLLOW_UP_TAKEOFF_DOC: TakeoffDocument = {
  ...TAKEOFF_DOC,
  documentId: 'ffffffff-1111-4222-8333-444444444444',
  documentNumber: 2,
  revision: 1,
};

const TRANSFER_RESULT: TakeoffTransferResult = {
  transferred: [
    {
      itemCode: '010101',
      unit: 'm3',
      lineId: 'tk-doc-010101',
      quantity: '2.4',
      lineIds: ['L1'],
      exactQty: '2.4',
    },
  ],
  skipped: [
    {
      itemCode: null,
      unit: 'm3',
      lineIds: ['L2', 'L3'],
      exactQty: '14.9',
      qty: '14.9',
    },
  ],
  lines: [],
};

const AUTH_SESSION: AuthSession = {
  userId: '11111111-2222-4333-8444-555555555555',
  username: 'admin',
  role: 'org_admin',
  expiresAt: '2026-01-01T12:00:00Z',
};

function fakeApi(overrides: Partial<ApiClient> = {}): ApiClient {
  return {
    login: vi.fn(() => Promise.resolve(AUTH_SESSION)),
    getSession: vi.fn(() => Promise.resolve(AUTH_SESSION)),
    logout: vi.fn(() => Promise.resolve(undefined)),
    changePassword: vi.fn(() =>
      Promise.resolve({
        userId: AUTH_SESSION.userId,
        username: AUTH_SESSION.username,
        role: AUTH_SESSION.role,
      }),
    ),
    listProjects: vi.fn(() => Promise.resolve([PROJECT])),
    createProject: vi.fn(() => Promise.resolve(PROJECT)),
    getProject: vi.fn(() => Promise.resolve(PROJECT)),
    listEstimates: vi.fn(() => Promise.resolve([ESTIMATE])),
    createEstimate: vi.fn(() => Promise.resolve(ESTIMATE)),
    getEstimate: vi.fn(() => Promise.resolve(ESTIMATE)),
    createVersion: vi.fn(() => Promise.resolve(VERSION)),
    getVersion: vi.fn(() => Promise.resolve<VersionOrBundle>({ kind: 'draft', version: VERSION })),
    addLines: vi.fn(() => Promise.resolve(VERSION)),
    previewTakeoffQuantities: vi.fn(() => Promise.reject(new Error('not used here'))),
    calculate: vi.fn(() => Promise.reject(new Error('not used here'))),
    finalize: vi.fn(() => Promise.reject(new Error('not used here'))),
    // P8-B S3: the edition list — the version-creation selector's data (DRAFT filtered
    // client-side; the fake returns no editions → the selector stays empty).
    listEditions: vi.fn(() => Promise.resolve([])),
    searchPricebook: vi.fn(() =>
      Promise.resolve([
        {
          code: '010101',
          chapter: 'chapter-1',
          group: '1',
          description: 'کندن و خارج کردن بوته و ریشه‌ها',
          unit: { code: 'm2', label: 'مترمربع' },
          basePrice: '2890',
          status: 'VERIFIED_SPEC_ONLY',
        },
      ]),
    ),
    createTakeoff: vi.fn(() => Promise.resolve(TAKEOFF_DOC)),
    listTakeoffs: vi.fn(() => Promise.resolve([TAKEOFF_LIST_ROW])),
    getTakeoff: vi.fn(() => Promise.resolve({ kind: 'document', document: TAKEOFF_DOC } as const)),
    saveTakeoffDraft: vi.fn(() => Promise.resolve(SAVED_TAKEOFF_DOC)),
    archiveTakeoff: vi.fn(() => Promise.resolve(ARCHIVED_TAKEOFF_DOC)),
    unarchiveTakeoff: vi.fn(() => Promise.resolve(TAKEOFF_DOC)),
    previewTakeoffCalculation: vi.fn(() => Promise.resolve(TAKEOFF_BUNDLE.result)),
    finalizeTakeoff: vi.fn(() => Promise.resolve(TAKEOFF_BUNDLE)),
    createTakeoffFollowUp: vi.fn(() => Promise.resolve(FOLLOW_UP_TAKEOFF_DOC)),
    transferTakeoffToBoq: vi.fn(() => Promise.resolve(TRANSFER_RESULT)),
    downloadReport: vi.fn(() => Promise.reject(new Error('not used here'))),
    downloadTakeoffReport: vi.fn(() => Promise.reject(new Error('not used here'))),
    health: vi.fn(() => Promise.resolve(true)),
    ...overrides,
  };
}

function renderWithRouter(ui: React.ReactElement, api: ApiClient, path: string): void {
  render(
    <MemoryRouter initialEntries={[path]}>
      <ApiProvider client={api}>
        <Routes>
          <Route path="/projects" element={<ProjectsPage />} />
          <Route path="/projects/:projectId" element={<ProjectDetailPage />} />
          <Route
            path="/projects/:projectId/takeoffs/:documentId"
            element={<TakeoffWorkspacePage />}
          />
          <Route path="/estimates/:estimateId" element={<EstimateDetailPage />} />
          <Route path="/versions/:versionId" element={<VersionWorkspacePage />} />
          <Route path="*" element={ui} />
        </Routes>
      </ApiProvider>
    </MemoryRouter>,
  );
}

describe('ProjectsPage', () => {
  it('lists real projects with title and metadata', async () => {
    renderWithRouter(<ProjectsPage />, fakeApi(), '/projects');
    expect(await screen.findByText('ساختمان اداری')).toBeInTheDocument();
    expect(screen.getByText(/location: تهران/)).toBeInTheDocument();
  });

  it('shows the empty state when no projects exist (no fake data)', async () => {
    renderWithRouter(
      <ProjectsPage />,
      fakeApi({ listProjects: vi.fn(() => Promise.resolve([])) }),
      '/projects',
    );
    expect(await screen.findByText('هنوز پروژه‌ای وجود ندارد.')).toBeInTheDocument();
  });

  it('shows a retryable error state on API failure', async () => {
    renderWithRouter(
      <ProjectsPage />,
      fakeApi({
        listProjects: vi.fn(() => Promise.reject(new Error('boom'))),
      }),
      '/projects',
    );
    expect(await screen.findByText('خطا در دریافت اطلاعات')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'تلاش مجدد' })).toBeInTheDocument();
  });

  it('creates a project through the form and navigates to it', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderWithRouter(<ProjectsPage />, api, '/projects');
    await user.click(await screen.findByRole('button', { name: '+ پروژه جدید' }));
    const titleInput = await screen.findByPlaceholderText('مثلاً ساختمان اداری فاز ۱');
    await user.type(titleInput, 'پروژه آزمایشی');
    await user.click(screen.getByRole('button', { name: 'ایجاد پروژه' }));
    await waitFor(() => {
      expect(api.createProject).toHaveBeenCalledWith({
        title: 'پروژه آزمایشی',
        metadata: {},
      });
    });
  });
});

describe('ProjectDetailPage', () => {
  it('shows project info, its estimates and the current-version link', async () => {
    renderWithRouter(<ProjectDetailPage />, fakeApi(), `/projects/${PROJECT.projectId}`);
    expect(await screen.findByText('برآوردها')).toBeInTheDocument();
    expect(screen.getByText('برآورد اولیه')).toBeInTheDocument();
    expect(screen.getByText('مشاهده نسخه جاری')).toBeInTheDocument();
    // no edit button: projects are immutable in the domain (§15)
    expect(screen.queryByRole('button', { name: /ویرایش/ })).not.toBeInTheDocument();
  });

  it('shows the estimates empty state', async () => {
    renderWithRouter(
      <ProjectDetailPage />,
      fakeApi({ listEstimates: vi.fn(() => Promise.resolve([])) }),
      `/projects/${PROJECT.projectId}`,
    );
    expect(await screen.findByText('هنوز برآوردی برای این پروژه وجود ندارد.')).toBeInTheDocument();
  });
});

describe('EstimateDetailPage', () => {
  it('lists versions with status badges and a create-version CTA', async () => {
    renderWithRouter(<EstimateDetailPage />, fakeApi(), `/estimates/${ESTIMATE.estimateId}`);
    expect(await screen.findByText('نسخه‌ها')).toBeInTheDocument();
    expect(screen.getByText('پیش‌نویس')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'نسخه جدید' })).toBeInTheDocument();
  });
});

describe('VersionWorkspacePage (draft)', () => {
  it('renders the BOQ table with exact LTR codes, null-as-ثبت‌نشده and visible negatives', async () => {
    renderWithRouter(<VersionWorkspacePage />, fakeApi(), '/versions/v-1');
    expect(await screen.findByRole('heading', { level: 1, name: /نسخه 1/ })).toBeInTheDocument();
    expect(screen.getByText('پیش‌نویس')).toBeInTheDocument();
    expect(screen.getAllByText('010101').length).toBeGreaterThan(0); // code stays LTR text
    expect(screen.getAllByText('ثبت نشده').length).toBeGreaterThanOrEqual(1); // 220925 null — never zero
    expect(screen.getByText('-1,037,000')).toBeInTheDocument(); // negative unit price visible
    expect(screen.getByText('-10,370,000')).toBeInTheDocument(); // negative line amount visible
    expect(screen.getAllByText('کسر بها').length).toBeGreaterThanOrEqual(1); // note preserved
    expect(screen.getByRole('button', { name: '+ افزودن ردیف' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'محاسبه' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'نهایی‌سازی' })).toBeInTheDocument();
    // reports exist but are disabled for a draft (§29)
    expect(screen.getByRole('button', { name: 'دانلود Excel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'دانلود PDF' })).toBeDisabled();
  });

  it('opens the add-line dialog, searches the pricebook and submits an exact-string line', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderWithRouter(<VersionWorkspacePage />, api, '/versions/v-1');
    await user.click(await screen.findByRole('button', { name: '+ افزودن ردیف' }));
    const searchInput = await screen.findByPlaceholderText('010101');
    await user.type(searchInput, '0101');
    const option = await screen.findByRole('option', { name: /کندن و خارج کردن/ });
    await user.click(option);
    await user.type(screen.getByPlaceholderText('1000'), '1000');
    await user.click(screen.getByRole('button', { name: 'افزودن ردیف' }));
    await waitFor(() => {
      expect(api.addLines).toHaveBeenCalledWith('v-1', [
        { pricebookCode: '010101', quantity: '1000', unit: 'm2' },
      ]);
    });
  });

  it('D-015: dimensional entry previews the exact quantity and commits ONLY the factors', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      previewTakeoffQuantities: vi.fn(() =>
        Promise.resolve({
          specVersion: '0.1.0',
          engineVersion: '0.1.0',
          items: [
            {
              lineId: 'preview',
              quantity: '20',
              unit: 'm2',
              takeoff: {
                input: {},
                output: { qty: '20' },
                specVersion: '0.1.0',
                engineVersion: '0.1.0',
              },
            },
          ],
        }),
      ),
    });
    renderWithRouter(<VersionWorkspacePage />, api, '/versions/v-1');
    await user.click(await screen.findByRole('button', { name: '+ افزودن ردیف' }));
    await user.type(await screen.findByPlaceholderText('010101'), '0101');
    await user.click(await screen.findByRole('option', { name: /کندن و خارج کردن/ }));
    // switch to dimensional entry (m2 → count × length × width)
    await user.selectOptions(screen.getByRole('combobox', { name: /روش ورود/ }), 'dimensional');
    await user.type(screen.getByPlaceholderText('4'), '4');
    await user.type(screen.getByPlaceholderText('2.5'), '2.5');
    await user.type(screen.getByPlaceholderText('2'), '2');
    await user.click(screen.getByRole('button', { name: 'محاسبهٔ مقدار' }));
    // the preview shows the exact quantity with the provenance versions
    const preview = await screen.findByTestId('takeoff-preview');
    expect(preview.textContent).toContain('20');
    expect(preview.textContent).toContain('0.1.0');
    // commit: only the factors travel — never a client-computed quantity
    await user.click(screen.getByRole('button', { name: 'افزودن ردیف' }));
    await waitFor(() => {
      expect(api.addLines).toHaveBeenCalledWith('v-1', [
        {
          pricebookCode: '010101',
          unit: 'm2',
          takeoff: { kind: 'addition', unit: 'm2', count: '4', length: '2.5', width: '2' },
        },
      ]);
    });
    expect(api.previewTakeoffQuantities).toHaveBeenCalledWith([
      { itemKey: 'preview', kind: 'addition', unit: 'm2', count: '4', length: '2.5', width: '2' },
    ]);
  });

  it('D-015/D2-A: a negative manual quantity is rejected in the dialog (deduction = کسر بها row)', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderWithRouter(<VersionWorkspacePage />, api, '/versions/v-1');
    await user.click(await screen.findByRole('button', { name: '+ افزودن ردیف' }));
    await user.type(await screen.findByPlaceholderText('010101'), '0101');
    await user.click(await screen.findByRole('option', { name: /کندن و خارج کردن/ }));
    await user.type(screen.getByPlaceholderText('1000'), '-5');
    await user.click(screen.getByRole('button', { name: 'افزودن ردیف' }));
    expect(await screen.findByText(/نامنفی/)).toBeInTheDocument();
    expect(api.addLines).not.toHaveBeenCalled();
  });

  it('D-015: non-S1 units (kg) stay manual-only — the dimensional option is disabled', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      searchPricebook: vi.fn(() =>
        Promise.resolve([
          {
            code: '090320',
            chapter: 'chapter-9',
            group: '3',
            description: 'آب‌بندی درزها با نوار پلاستیکی',
            unit: { code: 'kg', label: 'کیلوگرم' },
            basePrice: null,
            status: 'INCOMPLETE',
          },
        ]),
      ),
    });
    renderWithRouter(<VersionWorkspacePage />, api, '/versions/v-1');
    await user.click(await screen.findByRole('button', { name: '+ افزودن ردیف' }));
    await user.type(await screen.findByPlaceholderText('010101'), '0903');
    await user.click(await screen.findByRole('option', { name: /آب‌بندی/ }));
    expect(screen.getByRole('option', { name: 'متره‌ای (محاسبه از ابعاد)' })).toBeDisabled();
    // the manual quantity field remains the active path
    expect(screen.getByPlaceholderText('1000')).toBeInTheDocument();
  });
});

describe('VersionWorkspacePage (finalized read-only)', () => {
  it('removes every mutation control and enables report downloads (§29/§68)', async () => {
    const finalizedVersion: EstimateVersion = { ...VERSION, status: 'finalized' };
    const finalizedEstimate: Estimate = { ...ESTIMATE, versions: [finalizedVersion] };
    const bundle: VersionOrBundle = {
      kind: 'finalized',
      bundle: {
        estimate: finalizedEstimate,
        versionId: 'v-1',
        finalizedAt: '2026-01-01T00:00:00Z',
        calculation: {
          versionId: 'v-1',
          versionNumber: 1,
          s4Result: {
            calculationStatus: 'COMPLETE',
            finalEstimate: '69011321.1668',
            stages: [
              {
                stage: 'base-subtotal',
                coefficient: null,
                input: null,
                output: '38147600',
                status: 'COMPLETE',
              },
              {
                stage: 'floor',
                coefficient: '1.0451',
                input: null,
                output: '39868056.76',
                status: 'COMPLETE',
              },
              {
                stage: 'overhead',
                coefficient: '1.30',
                input: null,
                output: '51828473.788',
                status: 'COMPLETE',
              },
              {
                stage: 'regional',
                coefficient: '1.1',
                input: null,
                output: '57011321.1668',
                status: 'COMPLETE',
              },
              {
                stage: 'site-setup',
                coefficient: null,
                input: null,
                output: '69011321.1668',
                status: 'COMPLETE',
              },
            ],
            pending: { incomplete: [], externalDependencies: [], notSpecified: [] },
          },
          rollup: {
            amount: '38147600',
            status: 'COMPLETE',
            lineCount: 3,
            pricedLineCount: 2,
            pendingLineCount: 1,
          },
        },
      },
    };
    renderWithRouter(
      <VersionWorkspacePage />,
      fakeApi({ getVersion: vi.fn(() => Promise.resolve(bundle)) }),
      '/versions/v-1',
    );
    expect(await screen.findByText('نهایی‌شده')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '+ افزودن ردیف' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'محاسبه' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'نهایی‌سازی' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ایجاد نسخه جدید' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'دانلود Excel' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'دانلود PDF' })).toBeEnabled();
    // the golden exact total is displayed with grouping only (§33)
    expect(screen.getAllByText('69,011,321.1668').length).toBeGreaterThanOrEqual(1);
    // the finalized snapshot's calculation is shown from the persisted bundle
    expect(screen.getByText('جمع کل برآورد')).toBeInTheDocument();
  });
});

describe('BoqTable', () => {
  it('renders provenance as secondary text', () => {
    render(<BoqTable lines={VERSION.lines} />);
    expect(screen.getAllByText(/فهرست بهای واحد پایه رشته ابنیه سال ۱۴۰۴/).length).toBe(3);
    expect(screen.getAllByText(/صفحه 11|صفحه 186|صفحه 225/).length).toBe(3);
  });

  it('shows the no-lines hint for an empty draft', () => {
    render(<BoqTable lines={[]} />);
    expect(screen.getByText(/هنوز ردیفی ثبت نشده است/)).toBeInTheDocument();
  });
});

// -------------------------------------------------------------------------------------------------
// D-016 Phase 5: میزکار صورت‌برداشت کامل (تست‌های A تا AB)
// -------------------------------------------------------------------------------------------------

const PROJECT_ID = 'p-1';
const TAKEOFF_PATH = `/projects/${PROJECT_ID}/takeoffs/${TAKEOFF_DOC.documentId}`;

const CANONICAL_SAVED_CONTENT = {
  title: 'متره ویرایش‌شده',
  sheets: [
    {
      sheetId: 'S1',
      name: 'فونداسیون',
      lines: [
        {
          lineId: 'L1',
          rowNo: 1,
          description: 'کندن چاهک فونداسیون',
          location: 'محور A',
          itemCode: '010101',
          kind: 'addition',
          unit: 'm3',
          quantity: {
            type: 'dimensional',
            profile: 'LWH',
            length: '2',
            width: '1.5',
            height: '0.8',
          },
        },
        {
          lineId: 'L2',
          rowNo: 2,
          description: 'بتن مگر',
          kind: 'addition',
          unit: 'm3',
          quantity: { type: 'manual', value: '12.5', justification: 'بر اساس نقشه' },
        },
      ],
    },
    {
      sheetId: 'S2',
      name: 'دیوارچینی',
      lines: [
        {
          lineId: 'L3',
          rowNo: 1,
          description: 'جمع چاهک‌ها',
          kind: 'addition',
          unit: 'm3',
          quantity: { type: 'reference', terms: [{ lineId: 'L1', factor: '1', use: 'signed' }] },
        },
      ],
    },
  ],
  rounding: [],
};

/** محتوای ذخیره‌شدهٔ n-امین فراخوانی saveTakeoffDraft (با گارد ایندکس). */
function savedContentOf(api: ApiClient, index = 0): Record<string, unknown> {
  const calls = (api.saveTakeoffDraft as ReturnType<typeof vi.fn>).mock.calls;
  const call = calls[index];
  if (call === undefined) throw new Error('saveTakeoffDraft was not called');
  return call[3] as Record<string, unknown>;
}

async function openAddLineDialog(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: '+ ردیف جدید' }));
  await screen.findByText('افزودن ردیف به «فونداسیون»');
}

describe('TakeoffWorkspacePage (D-016 Phase 5)', () => {
  it('A) loads a draft document: title, status, revision, sheets and lines', async () => {
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    expect(await screen.findByText('متره مرحله اول')).toBeInTheDocument();
    expect(screen.getByText('پیش‌نویس')).toBeInTheDocument();
    expect(screen.getByText('فونداسیون (2)')).toBeInTheDocument();
    expect(screen.getByText('دیوارچینی (1)')).toBeInTheDocument();
    expect(screen.getByText('کندن چاهک فونداسیون')).toBeInTheDocument();
    expect(screen.getByText('بتن مگر')).toBeInTheDocument();
    expect(screen.getByText('نسخهٔ سند (revision)').nextElementSibling).toHaveTextContent('3');
  });

  it("B) switching sheet tabs shows that sheet's lines only", async () => {
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    await screen.findByText('کندن چاهک فونداسیون');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'دیوارچینی (1)' }));
    expect(screen.getByText('جمع چاهک‌ها')).toBeInTheDocument();
    expect(screen.queryByText('کندن چاهک فونداسیون')).not.toBeInTheDocument();
  });

  it('C) editing marks dirty, save sends expectedRevision and replaces the server revision', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    const title = await screen.findByLabelText('عنوان سند');
    expect(screen.getByText('بدون تغییر')).toBeInTheDocument();
    await user.clear(title);
    await user.type(title, 'متره ویرایش‌شده');
    expect(screen.getByText('تغییرات ذخیره‌نشده')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ذخیرهٔ تغییرات' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'ذخیرهٔ تغییرات' }));
    expect(await screen.findByText('ذخیره شد')).toBeInTheDocument();
    expect(api.saveTakeoffDraft).toHaveBeenCalledTimes(1);
    expect(api.saveTakeoffDraft).toHaveBeenCalledWith(
      PROJECT_ID,
      TAKEOFF_DOC.documentId,
      3,
      CANONICAL_SAVED_CONTENT,
    );
    expect(screen.getByText('نسخهٔ سند (revision)').nextElementSibling).toHaveTextContent('4');
  });

  it('D) canonical save omits every empty optional field (no location/itemCode/notes/selector keys)', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    await screen.findByLabelText('عنوان سند');
    const title = screen.getByLabelText('عنوان سند');
    await user.clear(title);
    await user.type(title, 'متره ویرایش‌شده');
    await user.click(screen.getByRole('button', { name: 'ذخیرهٔ تغییرات' }));
    await screen.findByText('ذخیره شد');
    const content = savedContentOf(api) as unknown as {
      sheets: { lines: Record<string, unknown>[] }[];
    };
    const sheet = content.sheets[0];
    if (sheet === undefined) throw new Error('sheet S1 missing');
    const l1 = sheet.lines[0];
    const l2 = sheet.lines[1];
    if (l1 === undefined || l2 === undefined) throw new Error('lines missing');
    expect(l1['location']).toBe('محور A');
    expect(l1['itemCode']).toBe('010101');
    expect('notes' in l1).toBe(false);
    expect('location' in l2).toBe(false);
    expect('itemCode' in l2).toBe(false);
    expect('notes' in l2).toBe(false);
  });

  it('E) a 409 conflict shows the exact Persian message and keeps local edits (never overwritten)', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      saveTakeoffDraft: vi.fn(() =>
        Promise.reject(new ApiError(409, 'PERSISTENCE_CONFLICT', 'revision mismatch')),
      ),
    });
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    const title = await screen.findByLabelText('عنوان سند');
    await user.clear(title);
    await user.type(title, 'متره ویرایش محلی');
    await user.click(screen.getByRole('button', { name: 'ذخیرهٔ تغییرات' }));
    expect(
      await screen.findByText(
        'این سند در جای دیگری تغییر کرده است. ابتدا نسخه جدید را دریافت کنید.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'دریافت نسخهٔ جدید' })).toBeInTheDocument();
    // ویرایش محلی حفظ می‌شود و ذخیره تا دریافت نسخهٔ جدید غیرفعال است
    expect(screen.getByLabelText('عنوان سند')).toHaveValue('متره ویرایش محلی');
    expect(screen.getByRole('button', { name: 'ذخیرهٔ تغییرات' })).toBeDisabled();
  });

  it('F) «دریافت نسخهٔ جدید» reloads the document from the server', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      saveTakeoffDraft: vi.fn(() =>
        Promise.reject(new ApiError(409, 'PERSISTENCE_CONFLICT', 'revision mismatch')),
      ),
    });
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    const title = await screen.findByLabelText('عنوان سند');
    await user.clear(title);
    await user.type(title, 'متره ویرایش محلی');
    await user.click(screen.getByRole('button', { name: 'ذخیرهٔ تغییرات' }));
    await user.click(await screen.findByRole('button', { name: 'دریافت نسخهٔ جدید' }));
    await waitFor(() => {
      expect(api.getTakeoff).toHaveBeenCalledTimes(2);
    });
    // نسخهٔ سرور جایگزین ویرایش محلی شد
    await waitFor(() => {
      expect(screen.getByLabelText('عنوان سند')).toHaveValue('متره مرحله اول');
    });
  });

  it('G) a new dimensional line is added locally (nothing saved until ذخیره)', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    await screen.findByText('کندن چاهک فونداسیون');
    await openAddLineDialog(user);
    await user.type(screen.getByLabelText('شرح ردیف'), 'تسمه‌بندی اطراف پی');
    await user.type(screen.getByLabelText('طول'), '10');
    await user.type(screen.getByLabelText('عرض'), '2');
    await user.click(screen.getByRole('button', { name: 'افزودن ردیف' }));
    expect(await screen.findByText('تسمه‌بندی اطراف پی')).toBeInTheDocument();
    expect(screen.getByText('ابعادی (10 × 2)')).toBeInTheDocument();
    expect(api.saveTakeoffDraft).not.toHaveBeenCalled();
    expect(screen.getByText('تغییرات ذخیره‌نشده')).toBeInTheDocument();
  });

  it('H) a duplicate lineId is rejected client-side without calling the API', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    await screen.findByText('کندن چاهک فونداسیون');
    await openAddLineDialog(user);
    const id = screen.getByLabelText('شناسهٔ ردیف');
    await user.clear(id);
    await user.type(id, 'L2');
    await user.type(screen.getByLabelText('شرح ردیف'), 'تست تکراری');
    await user.click(screen.getByRole('button', { name: 'افزودن ردیف' }));
    expect(await screen.findByText(/شناسهٔ ردیف در این سند تکراری است/)).toBeInTheDocument();
    expect(api.saveTakeoffDraft).not.toHaveBeenCalled();
  });

  it('I) a manual quantity without justification is rejected', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    await screen.findByText('کندن چاهک فونداسیون');
    await openAddLineDialog(user);
    await user.type(screen.getByLabelText('شرح ردیف'), 'مقدار دستی بدون دلیل');
    await user.selectOptions(screen.getByRole('combobox', { name: 'نوع مقدار' }), 'manual');
    await user.type(screen.getByLabelText('مقدار دستی'), '5');
    await user.click(screen.getByRole('button', { name: 'افزودن ردیف' }));
    expect(await screen.findByText(/دلیل مقدار دستی الزامی است/)).toBeInTheDocument();
  });

  it('J) a reference quantity can select a cross-sheet line (dependency shown in formula)', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    await screen.findByText('کندن چاهک فونداسیون');
    await openAddLineDialog(user);
    await user.type(screen.getByLabelText('شرح ردیف'), 'ارجاع بین‌برگه‌ای');
    await user.selectOptions(screen.getByRole('combobox', { name: 'نوع مقدار' }), 'reference');
    // گزینهٔ مرجع، ردیف برگهٔ دیگر را با نام برگه نشان می‌دهد
    const referenceSelect = screen.getByLabelText('ردیف مرجع جملهٔ 1');
    expect(
      within(referenceSelect).getByRole('option', { name: /دیوارچینی.*L3/ }),
    ).toBeInTheDocument();
    await user.selectOptions(referenceSelect, 'L3');
    await user.click(screen.getByRole('button', { name: 'افزودن ردیف' }));
    expect(await screen.findByText('ارجاع (1 × #L3)')).toBeInTheDocument();
  });

  it('K) the expression builder produces the exact JSON tree (round node over a const)', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    await screen.findByText('کندن چاهک فونداسیون');
    await openAddLineDialog(user);
    await user.type(screen.getByLabelText('شرح ردیف'), 'عبارت گردشده');
    await user.selectOptions(screen.getByRole('combobox', { name: 'نوع مقدار' }), 'expression');
    await user.selectOptions(screen.getByLabelText('عملگر گره root'), 'round');
    await user.selectOptions(screen.getByLabelText('عملگر گره root.arg'), 'const');
    await user.type(screen.getByLabelText('مقدار ثابت گره root.arg'), '2.5');
    await user.clear(screen.getByLabelText('دقت گرد کردن'));
    await user.type(screen.getByLabelText('دقت گرد کردن'), '1');
    await user.click(screen.getByRole('button', { name: 'افزودن ردیف' }));
    expect(await screen.findByText('عبارت round(2.5, 1, HALF_UP)')).toBeInTheDocument();
  });

  it('L) removing a referenced line warns about its dependents first', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    await screen.findByText('کندن چاهک فونداسیون');
    const row = screen.getByText('کندن چاهک فونداسیون').closest('tr');
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'حذف' }));
    expect(await screen.findByText('حذف ردیف L1')).toBeInTheDocument();
    expect(screen.getByText(/L3/)).toBeInTheDocument();
    expect(screen.getByText(/ارجاع می‌دهند/)).toBeInTheDocument();
  });

  it('M) an unreferenced line is removed after confirmation', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    await screen.findByText('بتن مگر');
    const row = screen.getByText('بتن مگر').closest('tr');
    expect(row).not.toBeNull();
    await user.click(within(row as HTMLElement).getByRole('button', { name: 'حذف' }));
    expect(await screen.findByText('حذف ردیف L2')).toBeInTheDocument();
    expect(screen.queryByText(/ارجاع می‌دهند/)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'حذف ردیف' }));
    await waitFor(() => {
      expect(screen.queryByText('بتن مگر')).not.toBeInTheDocument();
    });
    expect(screen.getByText('تغییرات ذخیره‌نشده')).toBeInTheDocument();
  });

  it('N) a design rounding rule is added and travels in the save body', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    await screen.findByText('قواعد گرد کردن سند (0)');
    await user.click(screen.getByRole('button', { name: '+ قاعدهٔ گرد کردن' }));
    await screen.findByText('قاعدهٔ گرد کردن جدید');
    await user.clear(screen.getByLabelText('دقت گرد کردن'));
    await user.type(screen.getByLabelText('دقت گرد کردن'), '2');
    await user.click(screen.getByRole('button', { name: 'ثبت قاعده' }));
    expect(await screen.findByText(/جمع آیتم/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'ذخیرهٔ تغییرات' }));
    await screen.findByText('ذخیره شد');
    const content = savedContentOf(api) as unknown as {
      rounding: { target: string; scale: number; mode: string; sourceStatus: string }[];
    };
    expect(content.rounding).toEqual([
      { target: 'item-total', scale: 2, mode: 'HALF_UP', sourceStatus: 'design' },
    ]);
  });

  it('O) finalize stays disabled while the draft is dirty', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    const title = await screen.findByLabelText('عنوان سند');
    expect(screen.getByRole('button', { name: 'نهایی‌سازی' })).toBeEnabled();
    await user.clear(title);
    await user.type(title, 'تغییر ذخیره‌نشده');
    expect(screen.getByRole('button', { name: 'نهایی‌سازی' })).toBeDisabled();
  });

  it('P) finalizing shows the immutable result view (exact values, no edit actions)', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    await screen.findByText('متره مرحله اول');
    await user.click(screen.getByRole('button', { name: 'نهایی‌سازی' }));
    await screen.findByText('نهایی‌سازی سند صورت‌برداشت');
    await user.click(screen.getByRole('button', { name: 'نهایی‌سازی قطعی' }));
    expect(await screen.findByText('جمع آیتم‌ها (بر پایهٔ کد)')).toBeInTheDocument();
    expect(screen.getByText('نهایی‌شده')).toBeInTheDocument();
    expect(screen.getAllByText('2.4').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: '+ ردیف جدید' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ایجاد سند پیرو' })).toBeInTheDocument();
  });

  it('Q) an engine failure keeps the draft and lists Persian hints for the codes', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      finalizeTakeoff: vi.fn(() =>
        Promise.reject(
          new ApiError(
            422,
            'TAKEOFF_CALCULATION_FAILED',
            'takeoff document "d" does not calculate: UNKNOWN_REFERENCE(L9), UNIT_MISMATCH(L2)',
          ),
        ),
      ),
    });
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    await screen.findByText('متره مرحله اول');
    await user.click(screen.getByRole('button', { name: 'نهایی‌سازی' }));
    await user.click(await screen.findByRole('button', { name: 'نهایی‌سازی قطعی' }));
    expect(
      await screen.findByText(
        'محاسبهٔ صورت‌برداشت با خطا رد شد؛ هیچ چیزی نهایی نشد. خطاهای موتور محاسبه را ببینید.',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText('مرجع انتخاب‌شده وجود ندارد.')).toBeInTheDocument();
    expect(screen.getByText('واحد این مقدار با مرجع سازگار نیست.')).toBeInTheDocument();
    // سند پیش‌نویس ماند و قابل ویرایش است
    expect(screen.getByRole('button', { name: '+ ردیف جدید' })).toBeInTheDocument();
  });

  it('R) an archived document is read-only and unarchive calls the API with expectedRevision', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      getTakeoff: vi.fn(() =>
        Promise.resolve({ kind: 'document', document: ARCHIVED_TAKEOFF_DOC } as const),
      ),
    });
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    await screen.findByText('بایگانی‌شده');
    expect(screen.queryByRole('button', { name: '+ ردیف جدید' })).not.toBeInTheDocument();
    expect(screen.queryAllByRole('button', { name: 'ویرایش' })).toHaveLength(0);
    expect(screen.queryByLabelText('عنوان سند')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'بازگردانی از بایگانی' }));
    await waitFor(() => {
      expect(api.unarchiveTakeoff).toHaveBeenCalledWith(
        PROJECT_ID,
        TAKEOFF_DOC.documentId,
        ARCHIVED_TAKEOFF_DOC.revision,
      );
    });
    await screen.findByRole('button', { name: '+ ردیف جدید' });
  });

  it('S) follow-up creates the next document and opens its workspace', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      getTakeoff: vi.fn(() =>
        Promise.resolve({ kind: 'finalized', bundle: TAKEOFF_BUNDLE } as const),
      ),
    });
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    await screen.findByText('جمع آیتم‌ها (بر پایهٔ کد)');
    await user.click(screen.getByRole('button', { name: 'ایجاد سند پیرو' }));
    const followUpDialog = await screen.findByRole('dialog');
    await user.click(within(followUpDialog).getByRole('button', { name: 'ساختن سند پیرو' }));
    await waitFor(() => {
      expect(api.createTakeoffFollowUp).toHaveBeenCalledWith(PROJECT_ID, TAKEOFF_DOC.documentId);
    });
    await waitFor(() => {
      expect(api.getTakeoff).toHaveBeenCalledWith(PROJECT_ID, FOLLOW_UP_TAKEOFF_DOC.documentId);
    });
  });

  it('T) the transfer dialog lists draft versions and renders transferred/skipped results', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      getTakeoff: vi.fn(() =>
        Promise.resolve({ kind: 'finalized', bundle: TAKEOFF_BUNDLE } as const),
      ),
    });
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    await screen.findByText('جمع آیتم‌ها (بر پایهٔ کد)');
    await user.click(screen.getByRole('button', { name: 'انتقال به برآورد' }));
    const dialog = await screen.findByRole('dialog');
    const estimateSelect = within(dialog).getByLabelText('برآورد مقصد');
    expect(
      within(estimateSelect).getByRole('option', { name: 'برآورد اولیه' }),
    ).toBeInTheDocument();
    await user.selectOptions(estimateSelect, ESTIMATE.estimateId);
    await user.selectOptions(within(dialog).getByLabelText('نسخهٔ مقصد'), VERSION.versionId);
    await user.click(within(dialog).getByRole('button', { name: 'انتقال به برآورد' }));
    expect(await within(dialog).findByText('نتیجهٔ انتقال')).toBeInTheDocument();
    expect(within(dialog).getByText('tk-doc-010101')).toBeInTheDocument();
    expect(within(dialog).getByText(/اقلام بدون کد/)).toBeInTheDocument();
    expect(api.transferTakeoffToBoq).toHaveBeenCalledWith(
      PROJECT_ID,
      TAKEOFF_DOC.documentId,
      VERSION.versionId,
    );
  });

  it('U) a repeated transfer shows the exact ALREADY_TRANSFERRED message', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      getTakeoff: vi.fn(() =>
        Promise.resolve({ kind: 'finalized', bundle: TAKEOFF_BUNDLE } as const),
      ),
      transferTakeoffToBoq: vi.fn(() =>
        Promise.reject(
          new ApiError(422, 'TAKEOFF_TRANSFER_REJECTED', 'transfer rejected', {
            failures: [
              {
                itemCode: '010101',
                unit: 'm3',
                errors: [
                  {
                    code: 'ALREADY_TRANSFERRED',
                    message: 'line tk-x was already transferred',
                  },
                ],
              },
            ],
            skipped: [],
          }),
        ),
      ),
    });
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    await screen.findByText('جمع آیتم‌ها (بر پایهٔ کد)');
    await user.click(screen.getByRole('button', { name: 'انتقال به برآورد' }));
    const dialog = await screen.findByRole('dialog');
    const estimateSelect = within(dialog).getByLabelText('برآورد مقصد');
    expect(
      within(estimateSelect).getByRole('option', { name: 'برآورد اولیه' }),
    ).toBeInTheDocument();
    await user.selectOptions(estimateSelect, ESTIMATE.estimateId);
    await user.selectOptions(within(dialog).getByLabelText('نسخهٔ مقصد'), VERSION.versionId);
    await user.click(within(dialog).getByRole('button', { name: 'انتقال به برآورد' }));
    expect(
      await within(dialog).findByText('این صورت‌برداشت قبلاً به این برآورد منتقل شده است.'),
    ).toBeInTheDocument();
  });

  it('V) sheets are managed client-side: adding a sheet creates a new tab', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    await screen.findByText('فونداسیون (2)');
    await user.click(screen.getByRole('button', { name: 'مدیریت برگه‌ها' }));
    await screen.findByText('مدیریت برگه‌های سند');
    await user.type(screen.getByLabelText('نام برگهٔ جدید'), 'سقف');
    await user.click(screen.getByRole('button', { name: '+ افزودن برگه' }));
    await user.click(screen.getByRole('button', { name: 'انجام شد' }));
    expect(await screen.findByText('سقف (0)')).toBeInTheDocument();
    expect(screen.getByText('تغییرات ذخیره‌نشده')).toBeInTheDocument();
  });

  it('W) deleting a sheet with referenced lines lists the dependents in the warning', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    await screen.findByText('فونداسیون (2)');
    await user.click(screen.getByRole('button', { name: 'مدیریت برگه‌ها' }));
    await screen.findByText('مدیریت برگه‌های سند');
    const rows = screen.getAllByRole('listitem');
    const firstSheetRow = rows.find((row) => within(row).queryByText('S1') !== null);
    expect(firstSheetRow).toBeDefined();
    await user.click(
      within(firstSheetRow as HTMLElement).getByRole('button', { name: 'حذف برگه' }),
    );
    expect(await screen.findByText('حذف قطعی برگه')).toBeInTheDocument();
    expect(screen.getByText(/L3/)).toBeInTheDocument();
  });

  it('X) nothing to save right after load: save/finalize disabled and «بدون تغییر»', async () => {
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    await screen.findByText('متره مرحله اول');
    expect(screen.getByText('بدون تغییر')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ذخیرهٔ تغییرات' })).toBeDisabled();
  });

  it('Y) uncoded lines and empty fields render «—» (never 0 or null text)', async () => {
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    await screen.findByText('بتن مگر');
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(2);
  });

  it('Z) quantities render the canonical read-only formula with exact decimal strings', async () => {
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    expect(await screen.findByText('ابعادی (2 × 1.5 × 0.8)')).toBeInTheDocument();
    expect(screen.getByText('دستی 12.5')).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole('tab', { name: 'دیوارچینی (1)' }));
    expect(screen.getByText('ارجاع (1 × #L1)')).toBeInTheDocument();
  });

  it('AA) ProjectDetailPage creates a takeoff and opens it; existing docs open by documentId', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderWithRouter(<ProjectDetailPage />, api, `/projects/${PROJECT_ID}`);
    // بازکردن سند موجود با شناسهٔ سند (فهرست اسناد وجود ندارد)
    await user.type(await screen.findByLabelText('شناسهٔ سند صورت‌برداشت'), TAKEOFF_DOC.documentId);
    await user.click(screen.getByRole('button', { name: 'بازکردن سند' }));
    await waitFor(() => {
      expect(api.getTakeoff).toHaveBeenCalledWith(PROJECT_ID, TAKEOFF_DOC.documentId);
    });
    // بازگشت به صفحهٔ پروژه و ساخت سند جدید
    await user.click(screen.getByRole('link', { name: 'ساختمان اداری' }));
    await user.click(await screen.findByRole('button', { name: '+ صورت‌برداشت جدید' }));
    await screen.findByText('سند صورت‌برداشت جدید');
    await user.type(screen.getByLabelText('عنوان سند *'), 'متره مرحله دوم');
    await user.click(screen.getByRole('button', { name: 'ایجاد سند' }));
    await waitFor(() => {
      expect(api.createTakeoff).toHaveBeenCalledWith(PROJECT_ID, { title: 'متره مرحله دوم' });
    });
    expect(await screen.findByText('متره مرحله اول')).toBeInTheDocument();
  });

  it("P7-S1) the project page lists the project's takeoff documents and rows open the workspace", async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderWithRouter(<ProjectDetailPage />, api, `/projects/${PROJECT_ID}`);
    // the list renders the projection row (title + draft status) with a link into the
    // workspace — the normal discovery path, replacing open-by-documentId-only
    const row = (await screen.findAllByRole('listitem')).find(
      (item) => within(item).queryByText('متره مرحله اول') !== null,
    );
    expect(row).toBeDefined();
    expect(within(row as HTMLElement).getByText('پیش‌نویس')).toBeInTheDocument();
    await user.click(within(row as HTMLElement).getByRole('link', { name: 'متره مرحله اول' }));
    await waitFor(() => {
      expect(api.getTakeoff).toHaveBeenCalledWith(PROJECT_ID, TAKEOFF_DOC.documentId);
    });
  });

  it('P7-S1b) the list shows every status with its label (draft, archived, finalized)', async () => {
    renderWithRouter(
      <ProjectDetailPage />,
      fakeApi({
        listTakeoffs: vi.fn(() =>
          Promise.resolve<readonly TakeoffListRow[]>([
            { ...TAKEOFF_LIST_ROW, documentId: 'd-draft', status: 'draft' },
            { ...TAKEOFF_LIST_ROW, documentId: 'd-arch', status: 'archived' },
            {
              ...TAKEOFF_LIST_ROW,
              documentId: 'd-fin',
              status: 'finalized',
              finalizedAt: '2026-02-02T00:00:00Z',
            },
          ]),
        ),
      }),
      `/projects/${PROJECT_ID}`,
    );
    expect(await screen.findByText('بایگانی‌شده')).toBeInTheDocument();
    expect(screen.getByText('نهایی‌شده')).toBeInTheDocument();
    expect(screen.getByText('پیش‌نویس')).toBeInTheDocument();
    // the finalized row shows the finalization instant; the draft row never does
    const rows = screen.getAllByRole('listitem');
    const finalizedRow = rows.find((item) => within(item).queryByText('نهایی‌شده') !== null);
    expect(finalizedRow).toBeDefined();
    expect(within(finalizedRow as HTMLElement).getByText(/نهایی‌سازی:/)).toBeInTheDocument();
    const draftRow = rows.find((item) => within(item).queryByText('پیش‌نویس') !== null);
    expect(draftRow).toBeDefined();
    expect(within(draftRow as HTMLElement).queryByText(/نهایی‌سازی:/)).not.toBeInTheDocument();
  });

  it('P7-S2) the draft workspace previews the server-side calculation and renders its result', async () => {
    const user = userEvent.setup();
    const api = fakeApi();
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    await screen.findByText('فونداسیون (2)');
    // the preview button is enabled on a clean draft; the section explains the contract
    const previewButton = screen.getByRole('button', { name: 'پیش‌نمایش محاسبه' });
    expect(previewButton).toBeEnabled();
    await user.click(previewButton);
    expect(await screen.findByText('جمع آیتم‌ها (بر پایهٔ کد)')).toBeInTheDocument();
    // NO client-side calculation: the rendered numbers are the API mock's verbatim values
    expect(api.previewTakeoffCalculation).toHaveBeenCalledWith(PROJECT_ID, TAKEOFF_DOC.documentId);
    // '14.9' legitimately appears in both the itemTotals and sheetTotals tables
    expect((await screen.findAllByText('14.9')).length).toBeGreaterThan(0);
    expect(screen.getByText(/نتیجهٔ پیش‌نمایش محاسبه است/)).toBeInTheDocument();
    // the draft stays editable — preview is not persistence and not finalization
    expect(screen.getByRole('button', { name: 'نهایی‌سازی' })).toBeEnabled();
    expect(screen.getByText('بدون تغییر', { exact: true })).toBeInTheDocument();
  });

  it('P7-S2b) a rejected preview shows the structured failures as Persian hints', async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <TakeoffWorkspacePage />,
      fakeApi({
        previewTakeoffCalculation: vi.fn(() =>
          Promise.reject(
            new ApiError(
              422,
              'TAKEOFF_SOLUTION_REJECTED',
              'the takeoff document does not calculate; nothing was persisted (stateless preview)',
              { failures: [{ code: 'UNKNOWN_REFERENCE', lineId: 'L9', message: 'missing' }] },
            ),
          ),
        ),
      }),
      TAKEOFF_PATH,
    );
    await screen.findByText('فونداسیون (2)');
    await user.click(screen.getByRole('button', { name: 'پیش‌نمایش محاسبه' }));
    // the banner carries the mapped user message + the structured failure's Persian hint
    expect(await screen.findByText(/پیش‌نمایش محاسبهٔ صورت‌برداشت رد شد/)).toBeInTheDocument();
    expect(screen.getByText('مرجع انتخاب‌شده وجود ندارد.')).toBeInTheDocument();
    // nothing was rendered as a result and the draft is untouched
    expect(screen.queryByText('جمع آیتم‌ها (بر پایهٔ کد)')).not.toBeInTheDocument();
    expect(screen.getByText('بدون تغییر', { exact: true })).toBeInTheDocument();
  });

  it('AB) the last remaining sheet cannot be deleted (stable document shape)', async () => {
    const user = userEvent.setup();
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    await screen.findByText('فونداسیون (2)');
    await user.click(screen.getByRole('button', { name: 'مدیریت برگه‌ها' }));
    await screen.findByText('مدیریت برگه‌های سند');
    const rows = screen.getAllByRole('listitem');
    const lastSheetRow = rows.find((row) => within(row).queryByText('S2') !== null);
    expect(lastSheetRow).toBeDefined();
    expect(
      within(lastSheetRow as HTMLElement).getByRole('button', { name: 'حذف برگه' }),
    ).toBeEnabled();
    await user.click(within(lastSheetRow as HTMLElement).getByRole('button', { name: 'حذف برگه' }));
    await user.click(screen.getByRole('button', { name: 'حذف قطعی برگه' }));
    await waitFor(() => {
      expect(screen.queryByText('S2')).not.toBeInTheDocument();
    });
    const remainingRow = screen
      .getAllByRole('listitem')
      .find((row) => within(row).queryByText('S1') !== null);
    expect(remainingRow).toBeDefined();
    expect(
      within(remainingRow as HTMLElement).getByRole('button', { name: 'حذف برگه' }),
    ).toBeDisabled();
  });
});

// -------------------------------------------------------------------------------------------------
// D-016 Phase 6: گزارش‌های صورت‌برداشت (فقط سند نهایی‌شده — G6=A)
// -------------------------------------------------------------------------------------------------

const createObjectUrlMock = vi.fn(() => 'blob:takeoff-report');
const revokeObjectUrlMock = vi.fn();

describe('TakeoffWorkspacePage reports (D-016 Phase 6)', () => {
  beforeAll(() => {
    // jsdom has no object-URL implementation; the download flow only needs the calls.
    (URL as { createObjectURL?: unknown }).createObjectURL = createObjectUrlMock;
    (URL as { revokeObjectURL?: unknown }).revokeObjectURL = revokeObjectUrlMock;
  });

  it('finalized view shows the گزارش‌ها section with both downloads enabled', async () => {
    const api = fakeApi({
      getTakeoff: vi.fn(() =>
        Promise.resolve({ kind: 'finalized', bundle: TAKEOFF_BUNDLE } as const),
      ),
    });
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    await screen.findByText('جمع آیتم‌ها (بر پایهٔ کد)');
    expect(screen.getByRole('heading', { name: 'گزارش‌ها' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'دانلود Excel' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'دانلود PDF' })).toBeEnabled();
  });

  it('draft view has NO report actions, only the finalized-only explanation', async () => {
    renderWithRouter(<TakeoffWorkspacePage />, fakeApi(), TAKEOFF_PATH);
    await screen.findByText('کندن چاهک فونداسیون');
    expect(screen.queryByRole('heading', { name: 'گزارش‌ها' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'دانلود Excel' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'دانلود PDF' })).not.toBeInTheDocument();
    expect(
      screen.getByText(/گزارش‌های PDF و Excel فقط برای سند نهایی‌شده ساخته می‌شوند/),
    ).toBeInTheDocument();
  });

  it('clicking دانلود Excel/PDF calls the client for the finalized document and anchors the file', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      getTakeoff: vi.fn(() =>
        Promise.resolve({ kind: 'finalized', bundle: TAKEOFF_BUNDLE } as const),
      ),
      downloadTakeoffReport: vi.fn(() =>
        Promise.resolve({
          blob: new Blob(['PK-takeoff'], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          }),
          filename: 'costgenius-takeoff-dddddddd.xlsx',
        }),
      ),
    });
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    await screen.findByText('جمع آیتم‌ها (بر پایهٔ کد)');
    await user.click(screen.getByRole('button', { name: 'دانلود Excel' }));
    await waitFor(() => {
      expect(api.downloadTakeoffReport).toHaveBeenCalledWith(
        PROJECT_ID,
        TAKEOFF_DOC.documentId,
        'excel',
      );
    });
    await user.click(screen.getByRole('button', { name: 'دانلود PDF' }));
    await waitFor(() => {
      expect(api.downloadTakeoffReport).toHaveBeenCalledWith(
        PROJECT_ID,
        TAKEOFF_DOC.documentId,
        'pdf',
      );
    });
    expect(createObjectUrlMock).toHaveBeenCalled();
    expect(revokeObjectUrlMock).toHaveBeenCalled();
  });

  it('a failed download shows the error inline (never silently ignored)', async () => {
    const user = userEvent.setup();
    const api = fakeApi({
      getTakeoff: vi.fn(() =>
        Promise.resolve({ kind: 'finalized', bundle: TAKEOFF_BUNDLE } as const),
      ),
      downloadTakeoffReport: vi.fn(() =>
        Promise.reject(
          new ApiError(
            409,
            'TAKEOFF_NOT_FINALIZED',
            'takeoff document is a draft; only a finalized takeoff has a report',
          ),
        ),
      ),
    });
    renderWithRouter(<TakeoffWorkspacePage />, api, TAKEOFF_PATH);
    await screen.findByText('جمع آیتم‌ها (بر پایهٔ کد)');
    await user.click(screen.getByRole('button', { name: 'دانلود PDF' }));
    expect(await screen.findByText(/only a finalized takeoff/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------------------------------------
 * P8-A S1 — authentication UI (CG-GOV-SPEC@0.1.0 §1)
 * -----------------------------------------------------------------------------------------------*/

describe('P8-A S1 authentication UI', () => {
  it('LoginPage submits credentials and hands the session to the app', async () => {
    const api = fakeApi();
    const onLogin = vi.fn();
    render(
      <ApiProvider client={api}>
        <LoginPage onLogin={onLogin} />
      </ApiProvider>,
    );
    await userEvent.type(screen.getByLabelText('نام کاربری'), 'admin');
    await userEvent.type(screen.getByLabelText('گذرواژه'), 'test-password-123');
    await userEvent.click(screen.getByRole('button', { name: 'ورود' }));
    await waitFor(() => {
      expect(onLogin).toHaveBeenCalledWith(AUTH_SESSION);
    });
    expect(api.login).toHaveBeenCalledWith('admin', 'test-password-123');
  });

  it('LoginPage shows the uniform 401 message and never any credential material', async () => {
    const api = fakeApi({
      login: vi.fn(() =>
        Promise.reject(
          new ApiError(
            401,
            'AUTH_INVALID_CREDENTIALS',
            'the username or password is incorrect (no further detail is ever provided)',
          ),
        ),
      ),
    });
    render(
      <ApiProvider client={api}>
        <LoginPage onLogin={vi.fn()} />
      </ApiProvider>,
    );
    await userEvent.type(screen.getByLabelText('نام کاربری'), 'admin');
    await userEvent.type(screen.getByLabelText('گذرواژه'), 'wrong-password');
    await userEvent.click(screen.getByRole('button', { name: 'ورود' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('نام کاربری یا گذرواژه نادرست است.');
    // the server message (and any credential) never leaks into the UI
    expect(document.body.textContent).not.toContain('no further detail');
    expect(document.body.textContent).not.toContain('wrong-password');
    expect(document.body.textContent).not.toContain('test-password');
  });

  it('LoginPage rejects an empty submission client-side', async () => {
    const api = fakeApi();
    render(
      <ApiProvider client={api}>
        <LoginPage onLogin={vi.fn()} />
      </ApiProvider>,
    );
    await userEvent.click(screen.getByRole('button', { name: 'ورود' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'نام کاربری و گذرواژه را وارد کنید.',
    );
    expect(api.login).not.toHaveBeenCalled();
  });

  it('AuthenticatedApp gates the app: no session → login page; nothing else renders', async () => {
    const api = fakeApi({
      getSession: vi.fn(() =>
        Promise.reject(new ApiError(401, 'UNAUTHENTICATED', 'a valid session is required')),
      ),
    });
    render(
      <MemoryRouter>
        <ApiProvider client={api}>
          <AuthenticatedApp>
            <div>secret-workspace</div>
          </AuthenticatedApp>
        </ApiProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading', { name: 'ورود به CostGenius' })).toBeVisible();
    expect(screen.queryByText('secret-workspace')).toBeNull(); // gated content never renders
  });

  it('AuthenticatedApp: a NON-401 session failure (API down) is an unreachable error, never the login page (§14)', async () => {
    // the session probe fails at the network level (fetch rejects, e.g. API down)
    const api = fakeApi({
      getSession: vi.fn(() => Promise.reject(new TypeError('fetch failed'))),
    });
    render(
      <MemoryRouter>
        <ApiProvider client={api}>
          <AuthenticatedApp>
            <div>workspace-content</div>
          </AuthenticatedApp>
        </ApiProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('CostGenius API در دسترس نیست.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'تلاش مجدد' })).toBeVisible();
    // network failure must NEVER be interpreted as "no session" — no login form
    expect(screen.queryByRole('heading', { name: 'ورود به CostGenius' })).toBeNull();
    expect(screen.queryByText('workspace-content')).toBeNull(); // gated content never renders

    // retry re-probes the session: now it answers 401 → the login page appears
    (api.getSession as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new ApiError(401, 'UNAUTHENTICATED', 'a valid session is required'),
    );
    await userEvent.click(screen.getByRole('button', { name: 'تلاش مجدد' }));
    expect(await screen.findByRole('heading', { name: 'ورود به CostGenius' })).toBeVisible();
  });

  it('AuthenticatedApp renders the app with the current user and logs out on demand', async () => {
    const api = fakeApi();
    render(
      <MemoryRouter>
        <ApiProvider client={api}>
          <AuthenticatedApp>
            <div>workspace-content</div>
          </AuthenticatedApp>
        </ApiProvider>
      </MemoryRouter>,
    );
    expect(await screen.findByText('workspace-content')).toBeVisible();
    expect(screen.getByLabelText('کاربر جاری')).toHaveTextContent('کاربر: admin');
    await userEvent.click(screen.getByRole('button', { name: 'خروج' }));
    await waitFor(() => {
      expect(api.logout).toHaveBeenCalled();
    });
    expect(await screen.findByRole('heading', { name: 'ورود به CostGenius' })).toBeVisible();
  });

  it('password change requires the current password and a matching 8+ character new password', async () => {
    const api = fakeApi();
    render(
      <MemoryRouter>
        <ApiProvider client={api}>
          <AuthenticatedApp>
            <div>workspace-content</div>
          </AuthenticatedApp>
        </ApiProvider>
      </MemoryRouter>,
    );
    await screen.findByText('workspace-content');
    await userEvent.click(screen.getByRole('button', { name: 'تغییر گذرواژه' }));
    const dialog = await screen.findByRole('dialog');
    await userEvent.click(within(dialog).getByRole('button', { name: 'ثبت گذرواژهٔ جدید' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'هر دو گذرواژه را وارد کنید.',
    );
    await userEvent.type(within(dialog).getByLabelText('گذرواژهٔ کنونی'), 'test-password-123');
    await userEvent.type(
      within(dialog).getByLabelText('گذرواژهٔ جدید (۸ تا ۱۲۸ نویسه)'),
      'brand-new-password-456',
    );
    await userEvent.type(within(dialog).getByLabelText('تکرار گذرواژهٔ جدید'), 'different');
    await userEvent.click(within(dialog).getByRole('button', { name: 'ثبت گذرواژهٔ جدید' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'تکرار گذرواژهٔ جدید با خودش یکسان نیست.',
    );
    expect(api.changePassword).not.toHaveBeenCalled();
  });
});
