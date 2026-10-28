import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';

// Column alignment from the markdown separator row (`:--`, `:-:`, `--:`), kept
// on every cell as `text-align` so it survives a save.
const align = {
  align: {
    default: null,
    parseHTML: (el: HTMLElement) => el.style.textAlign || null,
    renderHTML: (attrs: { align?: string | null }) =>
      attrs.align ? { style: `text-align: ${attrs.align}` } : {},
  },
};

export const TableExtensions = [
  Table.configure({ resizable: false }),
  TableRow,
  TableHeader.extend({
    addAttributes() {
      return { ...this.parent?.(), ...align };
    },
  }),
  TableCell.extend({
    addAttributes() {
      return { ...this.parent?.(), ...align };
    },
  }),
];
