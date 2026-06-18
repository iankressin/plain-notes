import { Extension, wrappingInputRule } from '@tiptap/core';
import BulletList from '@tiptap/extension-bullet-list';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

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