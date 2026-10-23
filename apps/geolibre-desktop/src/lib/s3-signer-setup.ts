/**
 * Installs the S3 signer at import time, before any project restore can ask
 * for a signed URL. Imported for its side effect by `App.tsx`.
 */
import { useDesktopSettingsStore } from "../hooks/useDesktopSettings";
import { normalizeS3DefaultLocation } from "./s3-connections";
import { installS3Signer } from "./s3-signer";

installS3Signer(
  () => useDesktopSettingsStore.getState().desktopSettings.s3Connections,
  (listener) =>
    useDesktopSettingsStore.subscribe((state, previous) => {
      if (state.desktopSettings.s3Connections !== previous.desktopSettings.s3Connections) {
        listener();
      }
    }),
  {
    get: () => useDesktopSettingsStore.getState().desktopSettings.s3DefaultLocation,
    // Written through the settings store, whose persistence saves it with the
    // rest of the desktop settings.
    set: (location) => {
      const { desktopSettings, setDesktopSettings } = useDesktopSettingsStore.getState();
      setDesktopSettings({
        ...desktopSettings,
        s3DefaultLocation: normalizeS3DefaultLocation(location),
      });
    },
  },
);
