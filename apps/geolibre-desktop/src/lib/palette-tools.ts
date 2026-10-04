// The command palette's per-tool entries: one command per client-side
// processing tool and per Whitebox toolbox tool, so Ctrl+K reaches "Buffer" or
// "Fill Depressions" directly instead of only the dialogs that list them.
//
// About 1,100 entries, built from the processing registries and the generated
// Whitebox menu catalog. Neither belongs in the toolbar's chunk, so the palette
// imports this module dynamically the first time it opens
// (`usePaletteCommands`); nothing here is reachable from a static import.

import type { NetworkToolKind, StatisticsToolKind, VectorToolKind } from "@geolibre/core";
import { NETWORK_TOOLS, STATISTICS_TOOLS, VECTOR_TOOLS } from "@geolibre/processing";
import type { ParseKeys, TFunction } from "i18next";
import type { LucideIcon } from "lucide-react";
import type { Command } from "./commands";
import {
  type ProcessingToolCatalog,
  translateToolGroup,
  translateToolName,
  whiteboxMenuSubcategorySlug,
} from "./processing-tool-i18n";
import { WHITEBOX_MENU_CATALOG } from "./whitebox-menu-catalog";

/** What a tool command opens, and the handlers that open it. */
export interface PaletteToolContext {
  t: TFunction;
  /**
   * Ids already in the fixed command registry. A tool that the registry lists
   * under the same id (the Vector tools with a Processing-menu command) is not
   * repeated.
   */
  existingIds: ReadonlySet<string>;
  /**
   * Icon shown beside every tool. Passed in rather than imported: a lucide
   * import here makes the bundler split lucide's shared runtime out of the
   * boot chunk into a chunk of its own.
   */
  icon?: LucideIcon;
  /** Open the Whitebox toolbox with `toolId` preselected. */
  openWhiteboxTool: (toolId: string) => void;
  openVectorTool: (kind: VectorToolKind) => void;
  /** Open a network tool, through the routing-consent notice when needed. */
  openNetworkTool: (kind: NetworkToolKind) => void;
  openStatisticsTool: (kind: StatisticsToolKind) => void;
}

/** A registry tool reduced to what a palette entry needs. */
interface RegistryTool {
  id: string;
  name: string;
  group?: string;
}

/**
 * Turn a Whitebox tool id into searchable words (`fill_depressions` →
 * `fill depressions`), so a query typed from the docs or a script still hits.
 *
 * @param id - The tool id.
 * @returns The id with separators replaced by spaces.
 */
function idWords(id: string): string {
  return id.replace(/[_-]+/g, " ");
}

/**
 * Build one command per client-side tool and per Whitebox tool.
 *
 * Every command id sits under its family's `proc.` prefix (`proc.vector.`,
 * `proc.network.`, `proc.statistics.`, `proc.whitebox.`), so the deployment,
 * privilege, UI-profile and mobile gates that already key on those prefixes
 * apply to these entries unchanged.
 *
 * @param context - Translation, the fixed registry's ids, and the openers.
 * @returns The tool commands, client-side tools first, then Whitebox.
 */
export function buildPaletteToolCommands(context: PaletteToolContext): Command[] {
  const { t, existingIds } = context;
  const toolsGroup = t("toolbar.commandGroup.tools");
  const commands: Command[] = [];

  const addRegistry = <K extends string>(
    catalog: ProcessingToolCatalog,
    tools: readonly RegistryTool[],
    open: (kind: K) => void,
  ) => {
    for (const tool of tools) {
      const id = `proc.${catalog}.${tool.id}`;
      if (existingIds.has(id)) continue;
      const group = tool.group ? translateToolGroup(t, tool.group) : "";
      commands.push({
        id,
        title: translateToolName(t, catalog, tool),
        group: toolsGroup,
        // The English name and group stay searchable in every locale, like the
        // English keywords on the fixed commands.
        keywords: `${tool.name} ${group} ${tool.group ?? ""} ${idWords(tool.id)} ${catalog} tool`,
        icon: context.icon,
        run: () => open(tool.id as K),
      });
    }
  };
  addRegistry<VectorToolKind>("vector", VECTOR_TOOLS, context.openVectorTool);
  addRegistry<NetworkToolKind>("network", NETWORK_TOOLS, context.openNetworkTool);
  addRegistry<StatisticsToolKind>("statistics", STATISTICS_TOOLS, context.openStatisticsTool);

  const whiteboxGroup = t("processing.whitebox.toolbox");
  const seen = new Set<string>();
  for (const category of WHITEBOX_MENU_CATALOG) {
    const categoryLabel = t(category.labelKey);
    for (const subcategory of category.subcategories) {
      const subcategoryLabel = t(
        `processing.whitebox.menuSubcategory.${whiteboxMenuSubcategorySlug(
          subcategory.label,
        )}` as ParseKeys,
        { defaultValue: subcategory.label },
      );
      for (const tool of subcategory.tools) {
        // A tool listed under two categories gets one entry.
        if (seen.has(tool.id)) continue;
        seen.add(tool.id);
        const id = `proc.whitebox.${tool.id}`;
        if (existingIds.has(id)) continue;
        commands.push({
          id,
          title: t(`processing.whitebox.menuTool.${tool.id}` as ParseKeys, {
            defaultValue: tool.name,
          }),
          group: whiteboxGroup,
          keywords: `${tool.name} ${idWords(tool.id)} ${categoryLabel} ${subcategoryLabel} ${subcategory.label} whitebox tool`,
          icon: context.icon,
          run: () => context.openWhiteboxTool(tool.id),
        });
      }
    }
  }
  return commands;
}
