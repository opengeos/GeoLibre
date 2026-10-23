import { Input, Label, Select } from "@geolibre/ui";
import { useTranslation } from "react-i18next";
import { savedPostgresConnectionLabel } from "../helpers";

interface PostgresConnectionFieldsProps {
  savedConnections: string[];
  connectionString: string;
  /** Called with the new string from either the saved picker or the input. */
  onConnectionChange: (value: string) => void;
}

/**
 * The saved-connection picker and connection-string input shared by the
 * desktop (Martin/sidecar) and mobile (in-process tiles) PostgreSQL forms.
 * Only one form is mounted at a time, so the element ids never collide.
 */
export function PostgresConnectionFields({
  savedConnections,
  connectionString,
  onConnectionChange,
}: PostgresConnectionFieldsProps) {
  const { t } = useTranslation();
  return (
    <>
      {savedConnections.length > 0 ? (
        <div className="space-y-1.5">
          <Label htmlFor="postgres-saved-connection">{t("addData.postgres.savedConnection")}</Label>
          <Select
            id="postgres-saved-connection"
            value={savedConnections.includes(connectionString) ? connectionString : ""}
            onChange={(event) => onConnectionChange(event.target.value)}
          >
            <option value="">{t("addData.postgres.selectSavedConnection")}</option>
            {savedConnections.map((connection) => (
              <option key={connection} value={connection}>
                {savedPostgresConnectionLabel(connection)}
              </option>
            ))}
          </Select>
        </div>
      ) : null}
      <div className="space-y-1.5">
        <Label htmlFor="postgres-connection">{t("addData.postgres.connectionString")}</Label>
        <Input
          id="postgres-connection"
          type="password"
          autoComplete="off"
          placeholder={t("addData.postgres.connectionStringPlaceholder")}
          value={connectionString}
          onChange={(event) => onConnectionChange(event.target.value)}
        />
      </div>
    </>
  );
}
