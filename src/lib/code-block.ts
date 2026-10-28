import CodeBlock from '@tiptap/extension-code-block';
import type { Editor } from '@tiptap/core';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';
import { Plugin } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type NodeView } from '@tiptap/pm/view';
import type MermaidAPI from 'mermaid';

// Code blocks, plus a rendered diagram for ```mermaid blocks. A diagram shows
// alone until the caret enters it (click it, or arrow into it); then its
// source shows below and the diagram follows the edits.

let mermaidLoad: Promise<typeof MermaidAPI> | null = null;

// Mermaid is large, so it loads the first time a note shows a diagram rather
// than at boot.
function loadMermaid() {
  mermaidLoad ??= import('mermaid').then(({ default: mermaid }) => {
    mermaid.initialize({
      startOnLoad: false,
      // Notes can be written by other tools (the MCP server), so no scripts or
      // raw HTML in diagrams.
      securityLevel: 'strict',
      // Plain SVG text instead of HTML labels, which an <img> may not draw.
      flowchart: { htmlLabels: false },
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'default',
    });
    return mermaid;
  });
  return mermaidLoad;
}

let renderCount = 0;

const isMermaid = (node: ProseMirrorNode) => node.attrs.language === 'mermaid';

function plainView(node: ProseMirrorNode): NodeView {
  const dom = document.createElement('pre');
  const code = dom.appendChild(document.createElement('code'));
  if (node.attrs.language) code.className = `language-${node.attrs.language}`;
  return {
    dom,
    contentDOM: code,
    // A change of language redraws the block (it may become a diagram).
    update: (updated) => updated.type === node.type && updated.attrs.language === node.attrs.language,
  };
}

function mermaidView(
  node: ProseMirrorNode,
  editor: Editor,
  getPos: () => number | undefined,
  decorations: readonly Decoration[]
): NodeView {
  const dom = document.createElement('div');
  dom.className = 'mermaid-block';
  const diagram = dom.appendChild(document.createElement('div'));
  diagram.className = 'mermaid-diagram';
  diagram.contentEditable = 'false';
  const pre = dom.appendChild(document.createElement('pre'));
  const code = pre.appendChild(document.createElement('code'));
  code.className = 'language-mermaid';

  const setEditing = (decos: readonly Decoration[]) =>
    dom.classList.toggle('is-editing', decos.some((d) => d.spec.editing));
  setEditing(decorations);

  let current = node;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = 0; // only the newest render may draw

  const show = (state: 'is-empty' | 'has-error' | null, text?: string) => {
    diagram.classList.remove('is-empty', 'has-error');
    if (state) diagram.classList.add(state);
    if (text !== undefined) diagram.textContent = text;
  };

  const render = async () => {
    const ticket = ++latest;
    const source = current.textContent.trim();
    if (!source) return show('is-empty', 'Empty diagram. Click to edit.');
    try {
      const mermaid = await loadMermaid();
      // Checked first: a failed render leaves error markup in the page.
      if (!(await mermaid.parse(source, { suppressErrors: true }))) {
        if (ticket === latest) show('has-error', 'This diagram has a syntax error.');
        return;
      }
      const { svg } = await mermaid.render(`mermaid-${++renderCount}`, source);
      if (ticket !== latest) return;
      // Shown as an image, so nothing in the SVG can run or reach the page,
      // whatever got past mermaid's own sanitizing.
      const img = document.createElement('img');
      img.alt = 'Diagram';
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
      const maxWidth = svg.match(/max-width:\s*([\d.]+)px/)?.[1];
      if (maxWidth) img.style.maxWidth = `${maxWidth}px`;
      show(null);
      diagram.replaceChildren(img);
    } catch (e) {
      if (ticket === latest) show('has-error', `Could not draw this diagram: ${e}`);
    }
  };
  render();

  // Clicking the diagram puts the caret at the end of its source.
  diagram.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const pos = getPos();
    if (pos !== undefined) {
      editor.chain().focus().setTextSelection(pos + 1 + current.content.size).run();
    }
  });

  return {
    dom,
    contentDOM: code,
    update(updated, decos) {
      if (updated.type !== current.type || !isMermaid(updated)) return false;
      const changed = updated.textContent !== current.textContent;
      current = updated;
      setEditing(decos);
      if (changed) {
        clearTimeout(timer);
        timer = setTimeout(render, 300);
      }
      return true;
    },
    // Drawing the diagram changes the DOM outside the source; that isn't an edit.
    ignoreMutation: (m) => !code.contains(m.target),
    destroy() {
      clearTimeout(timer);
      latest++;
    },
  };
}

export const MermaidCodeBlock = CodeBlock.extend({
  addNodeView() {
    return ({ node, editor, getPos, decorations }) =>
      isMermaid(node) ? mermaidView(node, editor, getPos, decorations) : plainView(node);
  },

  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      // Mark the diagram holding the caret, so its view shows the source.
      new Plugin({
        props: {
          decorations: (state) => {
            const { $from } = state.selection;
            for (let depth = $from.depth; depth > 0; depth--) {
              const node = $from.node(depth);
              if (node.type.name === this.name && isMermaid(node)) {
                const pos = $from.before(depth);
                return DecorationSet.create(state.doc, [
                  Decoration.node(pos, pos + node.nodeSize, {}, { editing: true }),
                ]);
              }
            }
            return DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
