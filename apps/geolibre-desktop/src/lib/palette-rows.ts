import type { Command } from "./commands";

/** A group heading in the palette list. `index` is its position in the rows. */
export interface PaletteGroupRow {
  kind: "group";
  label: string;
  index: number;
}

/** A selectable command. `index` is its position in the filtered commands. */
export interface PaletteCommandRow {
  kind: "command";
  command: Command;
  index: number;
}

export type PaletteRow = PaletteGroupRow | PaletteCommandRow;

/**
 * Gather ranked commands into contiguous groups, so a group never renders as
 * two sections. Groups appear in the order of their best-ranked command, and
 * commands keep their ranked order within a group. Without this, a query such
 * as "reclass" (an exact Whitebox match, then a Processing prefix match, then
 * more Whitebox prefix matches) would show the Whitebox heading twice.
 *
 * @param commands - Commands in ranked order.
 * @returns The same commands, stably grouped.
 */
export function groupRankedCommands(commands: readonly Command[]): Command[] {
  const groups = new Map<string, Command[]>();
  for (const command of commands) {
    const members = groups.get(command.group);
    if (members) members.push(command);
    else groups.set(command.group, [command]);
  }
  return [...groups.values()].flat();
}

/**
 * Flatten the filtered commands into the rows the virtualized list renders: a
 * heading wherever the group changes from the previous command, then the
 * command itself.
 *
 * @param commands - The filtered, ranked commands.
 * @returns The rows, and for each command index the row it renders in (so
 *   keyboard navigation can scroll a not-yet-mounted row into view).
 */
export function paletteRows(commands: readonly Command[]): {
  rows: PaletteRow[];
  rowOfCommand: number[];
} {
  const rows: PaletteRow[] = [];
  const rowOfCommand: number[] = [];
  commands.forEach((command, index) => {
    if (command.group !== commands[index - 1]?.group) {
      rows.push({ kind: "group", label: command.group, index: rows.length });
    }
    rowOfCommand.push(rows.length);
    rows.push({ kind: "command", command, index });
  });
  return { rows, rowOfCommand };
}
