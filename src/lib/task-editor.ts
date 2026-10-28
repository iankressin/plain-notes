import { Extension, wrappingInputRule, type Editor } from '@tiptap/core';
import BulletList from '@tiptap/extension-bullet-list';
import { Fragment, type Node as ProseMirrorNode } from '@tiptap/pm/model';

/** Position inside the first paragraph of a taskItem (where the text caret belongs). */
export function getTaskItemContentPos(doc: ProseMirrorNode, taskItemPos: number): number | null {
  const node = doc.nodeAt(taskItemPos);
  if (!node || node.type.name !== 'taskItem' || node.childCount === 0) return null;
  return taskItemPos + 2;
}

/** Matches full markdown task syntax: `- [ ] ` or `- [x] ` */
export const TaskMarkdownInput = Extension.create({
  name: 'taskMarkdownInput',

  addInputRules() {
    const taskItemType = this.editor.schema.nodes.taskItem;
    if (!taskItemType) return [];

    return [
      wrappingInputRule({
        find: /^\s*[-+*]\s+\[( |x)\]\s$/,
        type: taskItemType,
        getAttributes: (match) => ({
          checked: match[1] === 'x',
        }),
      }),
    ];
  },
});

/**
 * Bullet list input that does not fire on `- [ ]` task syntax.
 * Requires at least one character after the marker space that is not `[`.
 */
export const SafeBulletList = BulletList.extend({
  addInputRules() {
    return [
      wrappingInputRule({
        find: /^\s*([-+*])\s+(?!\[).+$/,
        type: this.type,
      }),
    ];
  },
});

// Note-wide task commands (command palette). Each is one transaction, so ⌘Z
// undoes it. They return false when there was nothing to change.

export function uncheckAllTasks(editor: Editor): boolean {
  const { tr, doc } = editor.state;
  doc.descendants((node, pos) => {
    if (node.type.name === 'taskItem' && node.attrs.checked) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, checked: false });
    }
  });
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

/**
 * Delete checked tasks together with their subtasks. A list left without
 * items goes too, since a list can't be empty.
 */
export function clearCheckedTasks(editor: Editor): boolean {
  const { tr, doc } = editor.state;
  const ranges: { from: number; to: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'taskList') return;
    const checked: { from: number; to: number }[] = [];
    node.forEach((item, offset) => {
      const from = pos + 1 + offset;
      if (item.attrs.checked) checked.push({ from, to: from + item.nodeSize });
    });
    if (checked.length === node.childCount) ranges.push({ from: pos, to: pos + node.nodeSize });
    else ranges.push(...checked);
  });
  // A range inside another goes with it. Deleting from the end keeps the
  // earlier positions valid.
  const outer = ranges.filter((r) => !ranges.some((o) => o !== r && o.from <= r.from && r.to <= o.to));
  if (!outer.length) return false;
  for (const r of outer.sort((a, b) => b.from - a.from)) tr.delete(r.from, r.to);
  editor.view.dispatch(tr);
  return true;
}

/** In every task list, move checked tasks below unchecked ones, keeping their order. */
export function moveCheckedTasksToBottom(editor: Editor): boolean {
  const { tr, doc } = editor.state;
  const lists: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'taskList') lists.push(pos);
  });
  // Last list first. Reordering keeps a list's size, so the positions of
  // lists before it (including its parents) stay valid.
  for (const pos of lists.reverse()) {
    const list = tr.doc.nodeAt(pos)!;
    const items: ProseMirrorNode[] = [];
    list.forEach((item) => items.push(item));
    const sorted = [...items.filter((i) => !i.attrs.checked), ...items.filter((i) => i.attrs.checked)];
    if (sorted.some((item, i) => item !== items[i])) {
      tr.replaceWith(pos + 1, pos + list.nodeSize - 1, Fragment.from(sorted));
    }
  }
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}
