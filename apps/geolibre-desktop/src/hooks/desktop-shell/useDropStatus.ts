import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import { createDropStatusNotifier } from "../../lib/drop-status-notifier";

/**
 * The import status, import error, and CRS warning, shown as notifications
 * (see `lib/drop-status-notifier.ts`). The setters keep React's state-setter
 * shape so the import hooks that call them are unchanged.
 *
 * @returns The setters, and a helper that clears the status after a delay.
 */
export function useDropStatus(): {
  clearDropMessageLater: () => void;
  setCrsWarning: Dispatch<SetStateAction<string | null>>;
  setDropError: Dispatch<SetStateAction<string | null>>;
  setDropMessage: Dispatch<SetStateAction<string | null>>;
} {
  const [notifier] = useState(createDropStatusNotifier);

  useEffect(() => () => notifier.dispose(), [notifier]);

  return {
    clearDropMessageLater: notifier.clearDropMessageLater,
    setCrsWarning: notifier.setCrsWarning,
    setDropError: notifier.setDropError,
    setDropMessage: notifier.setDropMessage,
  };
}
