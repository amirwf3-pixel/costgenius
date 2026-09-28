/**
 * تأیید نهایی‌سازی (§34): پیام صریح تغییرناپذیری، دکمه لغو/نهایی‌سازی، و بعد از
 * موفقیت صفحه به حالت فقط‌خواندنی می‌رود (کنترل آن در VersionWorkspacePage است).
 */
import { useState, type ReactElement } from 'react';
import { useApi } from '../../api/context.js';
import type { CoefficientInputs, FinalizedBundle } from '../../api/types.js';
import { Button, FormError, Modal } from '../ui/primitives.js';

export function FinalizeDialog({
  versionId,
  coefficients,
  onClose,
  onFinalized,
}: {
  versionId: string;
  coefficients: CoefficientInputs;
  onClose: () => void;
  onFinalized: (bundle: FinalizedBundle) => void;
}): ReactElement {
  const api = useApi();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | undefined>(undefined);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    try {
      const bundle = await api.finalize(versionId, coefficients);
      onFinalized(bundle);
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error(String(cause)));
      setBusy(false);
    }
  };

  return (
    <Modal title="نهایی‌سازی نسخه" onClose={onClose}>
      <p className="finalize-warning">
        با نهایی‌سازی، این نسخه غیرقابل تغییر می‌شود. برای تغییرات بعدی باید نسخه جدید ایجاد شود.
      </p>
      <FormError error={error} />
      <div className="form-actions">
        <Button onClick={onClose}>لغو</Button>
        <Button
          variant="primary"
          type="button"
          busy={busy}
          onClick={() => {
            void submit();
          }}
        >
          نهایی‌سازی
        </Button>
      </div>
    </Modal>
  );
}
