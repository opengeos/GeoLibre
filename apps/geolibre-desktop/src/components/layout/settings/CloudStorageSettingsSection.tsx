import { CloudStorageSection } from "../CloudStorageSection";
import { CredentialStorageNotice } from "../CredentialStorageNotice";
import { useSettingsDraft } from "./SettingsDraftContext";

/**
 * The Cloud Storage section: S3-compatible connections and the default
 * location.
 *
 * Returns:
 *   The section content.
 */
export function CloudStorageSettingsSection() {
  const { draftDesktopSettings, setDraftDesktopSettings } = useSettingsDraft();

  return (
    <div className="space-y-5">
      <CredentialStorageNotice />
      <CloudStorageSection
        connections={draftDesktopSettings.s3Connections}
        onChange={(s3Connections) =>
          setDraftDesktopSettings((current) => ({ ...current, s3Connections }))
        }
        defaultLocation={draftDesktopSettings.s3DefaultLocation}
        onDefaultLocationChange={(s3DefaultLocation) =>
          setDraftDesktopSettings((current) => ({ ...current, s3DefaultLocation }))
        }
      />
    </div>
  );
}
