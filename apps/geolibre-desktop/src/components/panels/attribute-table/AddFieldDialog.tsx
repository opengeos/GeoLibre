import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Label,
  Input,
  Select,
  Button,
} from "@geolibre/ui";
import type { NewColumnType } from "../../../lib/attribute-columns";
import type { TFunction } from "i18next";
import type { GeoLibreLayer } from "@geolibre/core";
import type { Dispatch, SetStateAction } from "react";

interface AddFieldDialogProps {
  addingColumn: boolean;
  setAddingColumn: Dispatch<SetStateAction<boolean>>;
  t: TFunction<"translation", undefined>;
  layer: GeoLibreLayer | undefined;
  newColumnName: string;
  newColumnCollides: boolean;
  newColumnReserved: boolean;
  setNewColumnName: Dispatch<SetStateAction<string>>;
  canSubmitNewColumn: boolean;
  confirmAddColumn: () => void;
  newColumnNameTrimmed: string;
  newColumnType: NewColumnType;
  changeNewColumnType: (type: NewColumnType) => void;
  newColumnDefault: string;
  setNewColumnDefault: Dispatch<SetStateAction<string>>;
  canAddColumn: boolean;
  canManageColumns: boolean;
}

/** The attribute table's add-field dialog: name, type and default value of a new column. */
export function AddFieldDialog({
  addingColumn,
  setAddingColumn,
  t,
  layer,
  newColumnName,
  newColumnCollides,
  newColumnReserved,
  setNewColumnName,
  canSubmitNewColumn,
  confirmAddColumn,
  newColumnNameTrimmed,
  newColumnType,
  changeNewColumnType,
  newColumnDefault,
  setNewColumnDefault,
  canAddColumn,
  canManageColumns,
}: AddFieldDialogProps) {
  return (
    <Dialog open={addingColumn} onOpenChange={(open: boolean) => setAddingColumn(open)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("attributeTable.addField")}</DialogTitle>
          <DialogDescription>
            {t("attributeTable.addFieldDescription", {
              layer: layer?.name ?? "",
            })}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 py-1">
          <div className="grid gap-1.5">
            <Label htmlFor="new-field-name">{t("attributeTable.fieldName")}</Label>
            <Input
              id="new-field-name"
              autoFocus
              value={newColumnName}
              placeholder={t("attributeTable.newFieldPlaceholder")}
              aria-invalid={newColumnCollides || newColumnReserved || undefined}
              onChange={(event) => setNewColumnName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && canSubmitNewColumn) {
                  event.preventDefault();
                  confirmAddColumn();
                }
              }}
            />
            {newColumnReserved ? (
              <span className="text-xs text-destructive">{t("attributeTable.fieldReserved")}</span>
            ) : newColumnCollides ? (
              <span className="text-xs text-destructive">
                {t("attributeTable.fieldExists", {
                  name: newColumnNameTrimmed,
                })}
              </span>
            ) : null}
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-field-type">{t("attributeTable.fieldType")}</Label>
            <Select
              id="new-field-type"
              value={newColumnType}
              onChange={(event) => changeNewColumnType(event.target.value as NewColumnType)}
            >
              <option value="text">{t("attributeTable.typeText")}</option>
              <option value="number">{t("attributeTable.typeNumber")}</option>
              <option value="boolean">{t("attributeTable.typeBoolean")}</option>
            </Select>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="new-field-default">{t("attributeTable.defaultValue")}</Label>
            {newColumnType === "boolean" ? (
              <Select
                id="new-field-default"
                value={newColumnDefault}
                onChange={(event) => setNewColumnDefault(event.target.value)}
              >
                <option value="">{t("attributeTable.noDefault")}</option>
                <option value="false">false</option>
                <option value="true">true</option>
              </Select>
            ) : (
              <Input
                id="new-field-default"
                type={newColumnType === "number" ? "number" : "text"}
                value={newColumnDefault}
                placeholder={t("attributeTable.defaultValuePlaceholder")}
                onChange={(event) => setNewColumnDefault(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && canSubmitNewColumn) {
                    event.preventDefault();
                    confirmAddColumn();
                  }
                }}
              />
            )}
          </div>
          {!canAddColumn ? (
            <span className="text-xs text-destructive">
              {t("attributeTable.noFeaturesForField")}
            </span>
          ) : null}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={() => setAddingColumn(false)}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!canManageColumns || !canSubmitNewColumn} onClick={confirmAddColumn}>
            {t("attributeTable.addField")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
