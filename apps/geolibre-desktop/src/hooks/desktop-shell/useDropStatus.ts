import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The transient import status toast and the CRS warning banner.
 *
 * @returns The messages, their setters, and a helper that clears the toast after a delay.
 */
export function useDropStatus() {
  const dropMessageTimeoutRef = useRef<number | null>(null);
  const [dropMessage, setDropMessage] = useState<string | null>(null);
  const [dropError, setDropError] = useState<string | null>(null);
  // Kept out of `dropError` because the drop handler sets its own success
  // message after `addImportedVectorLayers` returns, which would clobber this
  // one. A mislabelled-CRS layer loads *successfully* and still renders
  // nowhere, so both messages are true at once and need separate slots.
  const [crsWarning, setCrsWarning] = useState<string | null>(null);

  const clearDropMessageLater = useCallback(() => {
    if (dropMessageTimeoutRef.current !== null) {
      window.clearTimeout(dropMessageTimeoutRef.current);
    }
    dropMessageTimeoutRef.current = window.setTimeout(() => {
      dropMessageTimeoutRef.current = null;
      setDropMessage(null);
      setDropError(null);
    }, 4000);
  }, []);

  useEffect(() => {
    return () => {
      if (dropMessageTimeoutRef.current !== null) {
        window.clearTimeout(dropMessageTimeoutRef.current);
      }
    };
  }, []);

  return {
    clearDropMessageLater,
    crsWarning,
    dropError,
    dropMessage,
    setCrsWarning,
    setDropError,
    setDropMessage,
  };
}
