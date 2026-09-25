// Code-split panels and dialogs mounted by DesktopShell. Each is loaded on
// first render and falls back to a no-op component if its chunk fails to load.
import { lazy } from "react";

export const ProcessingDialog = lazy(() =>
  import("../processing/ProcessingDialog")
    .then((module) => ({
      default: module.ProcessingDialog,
    }))
    .catch((error) => {
      // A failed chunk load (network error, corrupted bundle) would otherwise
      // throw during render and unmount the whole shell. Fall back to a
      // no-op component so the rest of the app stays interactive.
      console.error("Failed to load ProcessingDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/ProcessingDialog").ProcessingDialog;
      return { default: Fallback };
    }),
);

export const ConversionDialog = lazy(() =>
  import("../processing/ConversionDialog")
    .then((module) => ({
      default: module.ConversionDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load ConversionDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/ConversionDialog").ConversionDialog;
      return { default: Fallback };
    }),
);

export const StyleManagerPanel = lazy(() =>
  import("../panels/StyleManagerPanel")
    .then((module) => ({
      default: module.StyleManagerPanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load StyleManagerPanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/StyleManagerPanel").StyleManagerPanel;
      return { default: Fallback };
    }),
);

export const VectorToolsDialog = lazy(() =>
  import("../processing/VectorToolsDialog")
    .then((module) => ({
      default: module.VectorToolsDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load VectorToolsDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/VectorToolsDialog").VectorToolsDialog;
      return { default: Fallback };
    }),
);

export const BatchToolsDialog = lazy(() =>
  import("../processing/BatchToolsDialog")
    .then((module) => ({
      default: module.BatchToolsDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load BatchToolsDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/BatchToolsDialog").BatchToolsDialog;
      return { default: Fallback };
    }),
);

export const ModelBuilderPanel = lazy(() =>
  import("../processing/model-builder/ModelBuilderPanel")
    .then((module) => ({
      default: module.ModelBuilderPanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load ModelBuilderPanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/model-builder/ModelBuilderPanel").ModelBuilderPanel;
      return { default: Fallback };
    }),
);

export const NetworkToolsDialog = lazy(() =>
  import("../processing/NetworkToolsDialog")
    .then((module) => ({
      default: module.NetworkToolsDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load NetworkToolsDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/NetworkToolsDialog").NetworkToolsDialog;
      return { default: Fallback };
    }),
);

export const StatisticsToolsDialog = lazy(() =>
  import("../processing/StatisticsToolsDialog")
    .then((module) => ({
      default: module.StatisticsToolsDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load StatisticsToolsDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/StatisticsToolsDialog").StatisticsToolsDialog;
      return { default: Fallback };
    }),
);

export const ProcessingHistoryDialog = lazy(() =>
  import("../processing/ProcessingHistoryDialog")
    .then((module) => ({
      default: module.ProcessingHistoryDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load ProcessingHistoryDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/ProcessingHistoryDialog").ProcessingHistoryDialog;
      return { default: Fallback };
    }),
);

export const SelectByExpressionDialog = lazy(() =>
  import("../selection/SelectByExpressionDialog")
    .then((module) => ({
      default: module.SelectByExpressionDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load SelectByExpressionDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../selection/SelectByExpressionDialog").SelectByExpressionDialog;
      return { default: Fallback };
    }),
);

export const SelectByLocationDialog = lazy(() =>
  import("../selection/SelectByLocationDialog")
    .then((module) => ({
      default: module.SelectByLocationDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load SelectByLocationDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../selection/SelectByLocationDialog").SelectByLocationDialog;
      return { default: Fallback };
    }),
);

export const GeocodeDialog = lazy(() =>
  import("../processing/GeocodeDialog")
    .then((module) => ({
      default: module.GeocodeDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load GeocodeDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/GeocodeDialog").GeocodeDialog;
      return { default: Fallback };
    }),
);

export const RasterToolsDialog = lazy(() =>
  import("../processing/RasterToolsDialog")
    .then((module) => ({
      default: module.RasterToolsDialog,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load RasterToolsDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/RasterToolsDialog").RasterToolsDialog;
      return { default: Fallback };
    }),
);

export const SegmentationDialog = lazy(() =>
  import("../processing/SegmentationDialog")
    .then((module) => ({
      default: module.SegmentationDialog,
    }))
    .catch((error) => {
      console.error("Failed to load SegmentationDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/SegmentationDialog").SegmentationDialog;
      return { default: Fallback };
    }),
);

export const ObjectDetectionDialog = lazy(() =>
  import("../processing/ObjectDetectionDialog")
    .then((module) => ({
      default: module.ObjectDetectionDialog,
    }))
    .catch((error) => {
      console.error("Failed to load ObjectDetectionDialog", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/ObjectDetectionDialog").ObjectDetectionDialog;
      return { default: Fallback };
    }),
);

export const SegmentEverythingPanel = lazy(() =>
  import("../processing/SegmentEverythingPanel")
    .then((module) => ({
      default: module.SegmentEverythingPanel,
    }))
    .catch((error) => {
      console.error("Failed to load SegmentEverythingPanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../processing/SegmentEverythingPanel").SegmentEverythingPanel;
      return { default: Fallback };
    }),
);

export const SqlWorkspacePanel = lazy(() =>
  import("../panels/SqlWorkspacePanel")
    .then((module) => ({
      default: module.SqlWorkspacePanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as ProcessingDialog above.
      console.error("Failed to load SqlWorkspacePanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/SqlWorkspacePanel").SqlWorkspacePanel;
      return { default: Fallback };
    }),
);

export const NotebookPanel = lazy(() =>
  import("../panels/NotebookPanel")
    .then((module) => ({
      default: module.NotebookPanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as the dialogs above.
      console.error("Failed to load NotebookPanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/NotebookPanel").NotebookPanel;
      return { default: Fallback };
    }),
);

export const AssistantPanel = lazy(() =>
  import("../panels/AssistantPanel")
    .then((module) => ({
      default: module.AssistantPanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as the dialogs above.
      console.error("Failed to load AssistantPanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/AssistantPanel").AssistantPanel;
      return { default: Fallback };
    }),
);

export const DashboardPanel = lazy(() =>
  import("../panels/DashboardPanel")
    .then((module) => ({
      default: module.DashboardPanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as the dialogs above.
      console.error("Failed to load DashboardPanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/DashboardPanel").DashboardPanel;
      return { default: Fallback };
    }),
);

export const PythonConsolePanel = lazy(() =>
  import("../panels/PythonConsolePanel")
    .then((module) => ({
      default: module.PythonConsolePanel,
    }))
    .catch((error) => {
      // Same chunk-load fallback rationale as the dialogs above.
      console.error("Failed to load PythonConsolePanel", error);
      const Fallback = (() =>
        null) as unknown as typeof import("../panels/PythonConsolePanel").PythonConsolePanel;
      return { default: Fallback };
    }),
);
