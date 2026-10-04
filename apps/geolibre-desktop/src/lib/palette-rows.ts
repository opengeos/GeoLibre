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
