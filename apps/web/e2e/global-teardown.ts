import { rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { stopE2EStack } from './global-setup.js';

export default function globalTeardown(): void {
  stopE2EStack();
  // the session state file is a per-run transient (the backend it authenticated to is gone)
  rmSync(resolve(import.meta.dirname, '..', '.auth/state.json'), { force: true });
}
