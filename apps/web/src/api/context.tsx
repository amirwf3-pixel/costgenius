/**
 * API client dependency injection: one client per app, provided at the root and
 * consumable by every component (tests inject a fake client through the same context).
 */
import { createContext, useContext, type ReactElement, type ReactNode } from 'react';
import { createApiClient, type ApiClient } from './client.js';
import { resolveApiBaseUrl } from './config.js';

const ApiContext = createContext<ApiClient | undefined>(undefined);

export function ApiProvider({
  children,
  client,
}: {
  children: ReactNode;
  /** Injectable for tests; defaults to the app client bound to the configured base URL. */
  client?: ApiClient;
}): ReactElement {
  return (
    <ApiContext.Provider value={client ?? createApiClient(resolveApiBaseUrl())}>
      {children}
    </ApiContext.Provider>
  );
}

export function useApi(): ApiClient {
  const client = useContext(ApiContext);
  if (client === undefined) throw new Error('useApi must be used inside <ApiProvider>');
  return client;
}

export type { ApiClient };
