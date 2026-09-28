/**
 * Minimal server-state hook: one GET resource with loading/error/data + reload, so
 * every page shares the same lifecycle (§36) without a state-management library.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, NetworkError } from './api/client.js';

export interface Resource<T> {
  readonly data: T | undefined;
  readonly loading: boolean;
  readonly error: Error | undefined;
  reload: () => void;
}

export function useResource<T>(load: () => Promise<T>): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(undefined);
    loadRef
      .current()
      .then(
        (value) => {
          if (!cancelled) setData(value);
        },
        (reason: unknown) => {
          if (!cancelled) setError(reason instanceof Error ? reason : new Error(String(reason)));
        },
      )
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tick]);

  const reload = useCallback(() => {
    setTick((value) => value + 1);
  }, []);

  return { data, loading, error, reload };
}

/** True when the error means "the API is unreachable" (§49). */
export function isUnreachable(error: Error | undefined): boolean {
  return error instanceof NetworkError || (error instanceof ApiError && error.status >= 500);
}
