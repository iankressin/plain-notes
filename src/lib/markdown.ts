// Markdown <-> HTML conversion for the Tiptap editor.
//
// Notes are stored on disk as plain markdown but edited as rich HTML in Tiptap.
// These two functions are exact inverses for the constructs the editor supports
// (headings, paragraphs, task/bullet/ordered lists with nesting, code blocks,
// tables). Keeping them lossless matters because the app re-hydrates the editor
// from markdown whenever a note is (re)opened — any asymmetry shows up as
// corrupted content on reload. Tables are the one rewrite: their columns are
// padded to line up on save.

type ListType = 'task' | 'bullet' | 'ol';

/** The fence that opens a code block on this line (``` or ~~~, 3 or more), if any. */
function fenceOpen(line: string): { marker: string; lang: string } | null {
  const m = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
  // After a backtick fence, more backticks mean inline code, not a block.
  if (!m || (m[1][0] === '`' && m[2].includes('`'))) return null;
  return { marker: m[1], lang: m[2].trim().split(/\s+/)[0] };
}

function closesFence(line: string, marker: string): boolean {
  const t = line.trim();
  return t.length >= marker.length && t === marker[0].repeat(t.length);
}

// GFM table cells: split on pipes not escaped as `\|`.
function tableCells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/(?<!\\)\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim());
}

// The row under a table's header, like `| --- | :-: |`. It must hold a pipe, so
// a lone `---` stays a horizontal rule.
function isTableSeparator(line: string): boolean {
  return line.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);
}

function startsTable(lines: string[], i: number): boolean {
  return (
    lines[i].includes('|') &&
    i + 1 < lines.length &&
    isTableSeparator(lines[i + 1]) &&
    tableCells(lines[i]).length === tableCells(lines[i + 1]).length
  );
}

function columnAlign(separatorCell: string): string | null {
  const left = separatorCell.startsWith(':');
  const right = separatorCell.endsWith(':');
  return left && right ? 'center' : right ? 'right' : left ? 'left' : null;
}

/**
 * Convert stored markdown into HTML for Tiptap's initial content / setContent.
 *
 * Every block is emitted as a complete, well-formed tag. Blank lines are pure
 * paragraph separators and emit nothing — the previous implementation inserted a
 * `\n\n` marker and later rewrote it to `</p><p>`, which, applied to text that was
 * already `<p>`-wrapped, produced malformed markup (`</p></p><p><p>`) that the
 * browser normalised into phantom empty paragraphs.
 *
 * Task items keep their nested child list INSIDE the content `<div>` (Tiptap's
 * TaskItem `contentDOM`), so the markup round-trips through `setContent`/`getHTML`
 * unchanged.
 */
export function simpleMarkdownToHtml(md: string): string {
  if (!md || !md.trim()) return '<p></p>';

  const lines = md.split(/\r?\n/);
  let html = '';
  let i = 0;

  // Stack of open lists, innermost last. Each list's last <li> is left open so a
  // deeper list can nest inside it.
  const stack: { type: ListType; level: number }[] = [];

  const escape = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Runs on escaped text, so only `"` still needs escaping inside href.
  const inline = (s: string) =>
    s
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => `<a href="${href.replace(/"/g, '&quot;')}">${text}</a>`)
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>');

  const openTag = (type: ListType) =>
    type === 'ol' ? '<ol>' : type === 'task' ? '<ul data-type="taskList">' : '<ul>';
  const closeTag = (type: ListType) => (type === 'ol' ? '</ol>' : '</ul>');
  // Task items wrap their content in a <div>; close it together with the <li>.
  const closeLi = (type: ListType) => (type === 'task' ? '</div></li>' : '</li>');

  // Open an <li> and leave it open. For task items the content <div> is also left
  // open so a nested list lands inside it (closed later by closeLi).
  const openLi = (type: ListType, text: string, checked: boolean) => {
    if (type === 'task') {
      const checkedStr = checked ? 'true' : 'false';
      const checkedAttr = checked ? ' checked' : '';
      return (
        `<li data-type="taskItem" data-checked="${checkedStr}">` +
        `<label contenteditable="false"><input type="checkbox"${checkedAttr} /></label>` +
        `<div><p>${text}</p>`
      );
    }
    return `<li><p>${text}</p>`;
  };

  const closeToLevel = (targetLevel: number) => {
    while (stack.length && stack[stack.length - 1].level > targetLevel) {
      const f = stack.pop()!;
      html += closeLi(f.type) + closeTag(f.type);
    }
  };
  const closeAllLists = () => {
    while (stack.length) {
      const f = stack.pop()!;
      html += closeLi(f.type) + closeTag(f.type);
    }
  };

  const addListItem = (level: number, type: ListType, text: string, checked = false) => {
    closeToLevel(level);
    // Same level but a different list kind (bullet <-> ordered <-> task): close it.
    const top = stack[stack.length - 1];
    if (top && top.level === level && top.type !== type) {
      const f = stack.pop()!;
      html += closeLi(f.type) + closeTag(f.type);
    }
    const cur = stack[stack.length - 1];
    if (!cur || cur.level < level) {
      // Open a new (possibly nested) list inside the parent's still-open <li>.
      html += openTag(type);
      stack.push({ type, level });
      html += openLi(type, text, checked);
    } else {
      // Sibling within the same list: close the previous item, open a new one.
      html += closeLi(type) + openLi(type, text, checked);
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Code block: everything up to the closing fence, kept as written. An
    // unclosed fence runs to the end of the note.
    const fence = fenceOpen(line);
    if (fence) {
      closeAllLists();
      const code: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i], fence.marker)) code.push(lines[i++]);
      i++;
      const lang = fence.lang.replace(/[^\w+#.-]/g, '');
      html += `<pre><code${lang ? ` class="language-${lang}"` : ''}>${escape(code.join('\n'))}</code></pre>`;
      continue;
    }

    if (startsTable(lines, i)) {
      closeAllLists();
      const header = tableCells(line);
      const aligns = tableCells(lines[i + 1]).map(columnAlign);
      const cell = (tag: 'th' | 'td', text: string, col: number) =>
        `<${tag}${aligns[col] ? ` style="text-align: ${aligns[col]}"` : ''}>` +
        `<p>${inline(escape(text.replace(/\\\|/g, '|')))}</p></${tag}>`;
      let rows = `<tr>${header.map((c, col) => cell('th', c, col)).join('')}</tr>`;
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = tableCells(lines[i]);
        // As in GFM: extra cells are dropped, missing ones are empty.
        rows += `<tr>${header.map((_, col) => cell('td', cells[col] ?? '', col)).join('')}</tr>`;
        i++;
      }
      html += `<table><tbody>${rows}</tbody></table>`;
      continue;
    }

    const h3 = line.match(/^###\s+(.*)$/);
    if (h3) { closeAllLists(); html += `<h3>${escape(h3[1])}</h3>`; i++; continue; }
    const h2 = line.match(/^##\s+(.*)$/);
    if (h2) { closeAllLists(); html += `<h2>${escape(h2[1])}</h2>`; i++; continue; }
    const h1 = line.match(/^#\s+(.*)$/);
    if (h1) { closeAllLists(); html += `<h1>${escape(h1[1])}</h1>`; i++; continue; }

    // task item: - [ ] or - [x] (indentation -> nesting level)
    const task = line.match(/^(\s*)- \[( |x)\]\s+(.*)$/);
    if (task) {
      const level = Math.floor((task[1] || '').length / 2);
      addListItem(level, 'task', inline(escape(task[3])), task[2].trim() === 'x');
      i++; continue;
    }

    // bullet - item (indentation -> nesting level)
    const bullet = line.match(/^(\s*)- (?!\[)(.*)$/);
    if (bullet) {
      const level = Math.floor((bullet[1] || '').length / 2);
      addListItem(level, 'bullet', inline(escape(bullet[2])));
      i++; continue;
    }

    // ordered (indentation -> nesting level)
    const ord = line.match(/^(\s*)\d+\.\s+(.*)$/);
    if (ord) {
      const level = Math.floor((ord[1] || '').length / 2);
      addListItem(level, 'ol', inline(escape(ord[2])));
      i++; continue;
    }

    // Blank line: a paragraph separator. Blocks are already complete tags, so no
    // marker is needed (emitting one produced malformed markup + phantom blanks).
    if (!line.trim()) { i++; continue; }

    // Plain paragraph: collect consecutive plain lines into one <p>.
    closeAllLists();
    let para = escape(line);
    i++;
    while (i < lines.length) {
      const next = lines[i];
      if (
        !next.trim() ||
        next.match(/^#{1,3}\s/) ||
        next.match(/^(\s*)- /) ||
        next.match(/^(\s*)\d+\.\s/) ||
        fenceOpen(next) ||
        startsTable(lines, i)
      ) break;
      para += ' ' + escape(next);
      i++;
    }
    html += `<p>${inline(para)}</p>`;
  }

  closeAllLists();
  if (!html.trim()) return '<p></p>';
  return html;
}

const plainInline = (s: string) =>
  s
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/`(.+?)`/g, '$1');

/**
 * The note as plain text: heading marks, bullets, task boxes and
 * bold/italic/code marks removed, and links written as `text (url)`. Code
 * keeps its text as written, without the fences; table rows become
 * tab-separated cells. Line breaks, indentation and list numbers stay, so the
 * structure still reads once pasted.
 */
export function markdownToPlainText(md: string): string {
  const out: string[] = [];
  let fence: string | null = null; // the marker of the open code block
  for (const line of md.split('\n')) {
    if (fence) {
      if (closesFence(line, fence)) fence = null;
      else out.push(line);
      continue;
    }
    const open = fenceOpen(line);
    if (open) {
      fence = open.marker;
      continue;
    }
    if (isTableSeparator(line)) continue;
    if (line.trim().startsWith('|')) {
      out.push(tableCells(line).map((c) => plainInline(c.replace(/\\\|/g, '|'))).join('\t'));
      continue;
    }
    out.push(
      plainInline(line.replace(/^(\s*)#{1,6}\s+/, '$1').replace(/^(\s*)[-*+]\s+(\[[ xX]\]\s+)?/, '$1'))
    );
  }
  return out.join('\n');
}

/**
 * Convert Tiptap's HTML back into stored markdown. Uses real DOM parsing for
 * fidelity (prevents tag leakage into the .md file).
 */
export function htmlToSimpleMarkdown(html: string): string {
  if (!html) return '';
  const container = document.createElement('div');
  container.innerHTML = html;

  const lines: string[] = [];
  // Indexes into `lines` that hold code, where blank lines are content.
  const verbatim = new Set<number>();

  // Render inline marks (bold/italic/code) inside a paragraph back to markdown.
  const inlineMd = (n: Node): string => {
    if (n.nodeType === Node.TEXT_NODE) return n.textContent || '';
    if (n.nodeType !== Node.ELEMENT_NODE) return '';
    const e = n as HTMLElement;
    const t = e.tagName ? e.tagName.toLowerCase() : '';
    const inner = Array.from(e.childNodes).map(inlineMd).join('');
    if (t === 'strong' || t === 'b') return '**' + inner + '**';
    if (t === 'em' || t === 'i') return '*' + inner + '*';
    if (t === 'code') return '`' + inner + '`';
    if (t === 'a') {
      // A bare URL that links to itself stays bare.
      const href = e.getAttribute('href') ?? '';
      return href && href !== inner ? `[${inner}](${href})` : inner;
    }
    return inner;
  };

  function walk(node: Node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (t) lines.push(t);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    const tag = el.tagName.toLowerCase();

    if (tag === 'h1') { lines.push('# ' + (el.textContent || '').trim()); lines.push(''); return; }
    if (tag === 'h2') { lines.push('## ' + (el.textContent || '').trim()); lines.push(''); return; }
    if (tag === 'h3') { lines.push('### ' + (el.textContent || '').trim()); lines.push(''); return; }

    if (tag === 'p') {
      const txt = Array.from(el.childNodes).map(inlineMd).join('').replace(/\s+/g, ' ').trim();
      if (txt) lines.push(txt);
      lines.push('');
      return;
    }

    if (tag === 'ul' || tag === 'ol') {
      // Serialize the whole (possibly nested) list, then one trailing blank.
      serializeListItems(el, 0);
      lines.push('');
      return;
    }

    if (tag === 'pre') {
      const code = el.textContent ?? '';
      const lang = el.querySelector('code')?.className.match(/language-(\S+)/)?.[1] ?? '';
      // Longer than any run of backticks in the code, so the code can't close it.
      const longest = Math.max(0, ...(code.match(/`+/g) ?? []).map((run) => run.length));
      const fence = '`'.repeat(Math.max(3, longest + 1));
      lines.push(fence + lang);
      for (const line of code.split('\n')) {
        verbatim.add(lines.length);
        lines.push(line);
      }
      lines.push(fence, '');
      return;
    }

    if (tag === 'table') {
      serializeTable(el as HTMLTableElement);
      lines.push('');
      return;
    }

    if (tag === 'li') {
      // fallback if li outside recognized list
      lines.push(`- ${(el.textContent || '').replace(/\s+/g, ' ').trim()}`);
      return;
    }

    if (tag === 'br') { lines.push(''); return; }

    Array.from(el.childNodes).forEach((c) => walk(c));
  }

  // Serialize a <ul>/<ol> recursively, indenting nested lists two spaces per
  // level. Each item's OWN text comes from its first paragraph only; nested lists
  // (which for task items live inside the content <div>, and for plain items are
  // direct <li> children) are recursed separately so their text is never folded
  // into the parent item.
  function serializeListItems(listEl: HTMLElement, depth: number) {
    const isTask = listEl.getAttribute('data-type') === 'taskList';
    const isOrdered = listEl.tagName.toLowerCase() === 'ol';
    const indent = '  '.repeat(depth);
    let counter = 1;

    Array.from(listEl.children).forEach((child) => {
      const li = child as HTMLElement;
      if (li.tagName.toLowerCase() !== 'li') return;
      const isTaskItem = li.getAttribute('data-type') === 'taskItem';
      const ch = li.getAttribute('data-checked') === 'true';

      // Content host: a task item wraps its paragraph + nested list in a <div>
      // (Tiptap's contentDOM); a plain <li> holds them directly.
      const host =
        (Array.from(li.children).find(
          (c) => (c as HTMLElement).tagName.toLowerCase() === 'div'
        ) as HTMLElement | undefined) || li;

      // Own text = the first paragraph inside the host. host.textContent would
      // swallow nested-list text into this item (the old nesting bug).
      const firstP = Array.from(host.children).find(
        (c) => (c as HTMLElement).tagName.toLowerCase() === 'p'
      ) as HTMLElement | undefined;
      const itemText = (firstP ? Array.from(firstP.childNodes).map(inlineMd).join('') : '')
        .replace(/\s+/g, ' ')
        .trim();

      if (isTask || isTaskItem) {
        lines.push(`${indent}- [${ch ? 'x' : ' '}] ${itemText}`);
      } else if (isOrdered) {
        lines.push(`${indent}${counter}. ${itemText}`);
        counter++;
      } else {
        lines.push(`${indent}- ${itemText}`);
      }

      // Recurse into nested lists that live inside the content host.
      Array.from(host.children).forEach((sub) => {
        const t = (sub as HTMLElement).tagName.toLowerCase();
        if (t === 'ul' || t === 'ol') serializeListItems(sub as HTMLElement, depth + 1);
      });
    });
  }

  // GFM table with columns padded to line up. A cell's paragraphs join with a
  // space; pipes in cell text are escaped.
  function serializeTable(table: HTMLTableElement) {
    const rows = Array.from(table.rows).map((tr) =>
      Array.from(tr.cells).map((cell) =>
        Array.from(cell.children)
          .map((block) => Array.from(block.childNodes).map(inlineMd).join(''))
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim()
          .replace(/\|/g, '\\|')
      )
    );
    if (!rows.length) return;
    const aligns = Array.from(table.rows[0].cells).map((cell) => cell.style.textAlign);
    const cols = Math.max(...rows.map((r) => r.length));
    const widths = Array.from({ length: cols }, (_, col) =>
      Math.max(3, ...rows.map((r) => (r[col] ?? '').length))
    );
    const row = (cells: string[]) =>
      '| ' + widths.map((w, col) => (cells[col] ?? '').padEnd(w)).join(' | ') + ' |';
    const rule = widths.map((w, col) => {
      if (aligns[col] === 'center') return ':' + '-'.repeat(w - 2) + ':';
      if (aligns[col] === 'left') return ':' + '-'.repeat(w - 1);
      if (aligns[col] === 'right') return '-'.repeat(w - 1) + ':';
      return '-'.repeat(w);
    });
    lines.push(row(rows[0]), '| ' + rule.join(' | ') + ' |', ...rows.slice(1).map(row));
  }

  Array.from(container.childNodes).forEach((n) => walk(n));

  // Collapse runs of blank lines, except inside code.
  const out: string[] = [];
  lines.forEach((line, k) => {
    if (line === '' && out[out.length - 1] === '' && !verbatim.has(k)) return;
    out.push(line);
  });
  return out.join('\n').trim();
}
