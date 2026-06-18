<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
  import { invoke } from '@tauri-apps/api/core';

  // Tiptap rich editor for proper markdown rendering + editing
  import { Editor } from '@tiptap/core';
  import StarterKit from '@tiptap/starter-kit';
  import TaskList from '@tiptap/extension-task-list';
  import TaskItem from '@tiptap/extension-task-item';
  import OrderedList from '@tiptap/extension-ordered-list';
  import ListItem from '@tiptap/extension-list-item';
  import { ListKeymap } from '@tiptap/extension-list/keymap';
  import Underline from '@tiptap/extension-underline';
  import Placeholder from '@tiptap/extension-placeholder';
  import Link from '@tiptap/extension-link';
  import {
    getTaskItemContentPos,
    SafeBulletList,
    TaskMarkdownInput,
  } from '$lib/task-editor';

  // State
  type NoteInfo = { id: string; path: string; title: string; mtime: number; pinned: boolean };

  let content = $state('');
  let currentPath = $state('');
  let noteTitle = $state('Plain Notes');
  let notes = $state<NoteInfo[]>([]);
  let showList = $state(false);
  let isLoadingNote = $state(false);

  // Plain-text character count (Raycast-style): strip markdown syntax so we count
  // visible characters, not the `#`, `-`, `[ ]`, `*` tokens.
  let charCount = $derived(
    (content || '')
      .replace(/^#{1,6}\s+/gm, '')
      .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/gm, '')
      .replace(/^\s*\d+\.\s+/gm, '')
      .replace(/[*_`~]/g, '')
      .length
  );

  const win = getCurrentWindow();
  let isVisible = true;

  // Tiptap editor instance (replaces raw textarea for rendering)
  let editor: Editor | null = null;
  let editorElement = $state<HTMLDivElement | null>(null);

  function simpleMarkdownToHtml(md: string): string {
    if (!md || !md.trim()) return '<p></p>';

    const lines = md.split(/\r?\n/);
    let html = '';
    let i = 0;
    let inTaskList = false;
    let inBulletList = false;
    let inOl = false;

    const closeLists = () => {
      if (inTaskList) { html += '</ul>'; inTaskList = false; }
      if (inBulletList) { html += '</ul>'; inBulletList = false; }
      if (inOl) { html += '</ol>'; inOl = false; }
    };

    const escape = (s: string) => s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

    while (i < lines.length) {
      let line = lines[i];

      // headings
      const h3 = line.match(/^###\s+(.*)$/);
      if (h3) { closeLists(); html += `<h3>${escape(h3[1])}</h3>`; i++; continue; }
      const h2 = line.match(/^##\s+(.*)$/);
      if (h2) { closeLists(); html += `<h2>${escape(h2[1])}</h2>`; i++; continue; }
      const h1 = line.match(/^#\s+(.*)$/);
      if (h1) { closeLists(); html += `<h1>${escape(h1[1])}</h1>`; i++; continue; }

      // task item: - [ ] or - [x]
      const task = line.match(/^(\s*)- \[( |x)\]\s+(.*)$/);
      if (task) {
        const indent = task[1] || '';
        const checked = task[2].trim() === 'x';
        const text = escape(task[3]);
        const level = Math.floor(indent.length / 2);
        const pad = '  '.repeat(level);
        if (!inTaskList) {
          closeLists();
          html += `${pad}<ul data-type="taskList">`;
          inTaskList = true;
        }
        // Emit structure that closely matches what Tiptap TaskItem serializes
        // (label + input + span + content div). This is critical for caret to
        // land inside the task item and for being able to click back into it.
        const checkedStr = checked ? 'true' : 'false';
        const checkedAttr = checked ? ' checked' : '';
        // Emit as close as possible to Tiptap's own toDOM for reliable parsing on setContent.
        html += `<li data-type="taskItem" data-checked="${checkedStr}">` +
                `<label contenteditable="false"><input type="checkbox"${checkedAttr} /></label>` +
                `<div>${text ? `<p>${text}</p>` : ''}</div></li>`;
        i++; continue;
      }

      // bullet - item
      const bullet = line.match(/^(\s*)- (?!\[)(.*)$/);
      if (bullet) {
        const indent = bullet[1] || '';
        const text = escape(bullet[2]);
        const level = Math.floor(indent.length / 2);
        const pad = '  '.repeat(level);
        if (!inBulletList) {
          closeLists();
          html += `${pad}<ul>`;
          inBulletList = true;
        }
        html += `<li><p>${text}</p></li>`;
        i++; continue;
      }

      // ordered
      const ord = line.match(/^(\s*)\d+\.\s+(.*)$/);
      if (ord) {
        const text = escape(ord[2]);
        if (!inOl) {
          closeLists();
          html += '<ol>';
          inOl = true;
        }
        html += `<li><p>${text}</p></li>`;
        i++; continue;
      }

      // blank line
      if (!line.trim()) {
        // Do not close lists on blank lines inside a list. This keeps items that have
        // blank lines between them (very common in user MD) inside one <ul data-type="taskList">.
        // Non-list content or a different list type will trigger close via closeLists().
        if (!inTaskList && !inBulletList && !inOl) {
          closeLists();
        }
        // insert paragraph break marker we will collapse later or just skip extra
        html += '\n\n';
        i++; continue;
      }

      // plain paragraph line (or continuation)
      closeLists();
      // collect consecutive non-special lines as one p
      let para = escape(line);
      i++;
      while (i < lines.length) {
        const next = lines[i];
        if (!next.trim() || next.match(/^#{1,3}\s/) || next.match(/^(\s*)- /) || next.match(/^(\s*)\d+\. /)) break;
        para += ' ' + escape(next);
        i++;
      }
      // inline ** * ` for loaded plain md (Tiptap will see rich nodes)
      para = para.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\*(.*?)\*/g, '<em>$1</em>').replace(/`(.*?)`/g, '<code>$1</code>');
      html += `<p>${para}</p>`;
    }

    closeLists();

    // cleanup: turn blank markers into proper p-breaks but avoid wrapping blocks
    html = html.replace(/\n\n+/g, '</p><p>');
    // remove empty p
    html = html.replace(/<p>\s*<\/p>/g, '');
    // strip leading/trailing stray p tags
    html = html.replace(/^<\/?p>/g, '').replace(/<\/?p>$/g, '');
    // remove </p><p> immediately before/after block tags (headings + lists)
    html = html.replace(/<\/p><p>\s*(?=<h[1-6]|<ul|<ol)/g, '');
    html = html.replace(/(<\/h[1-6]>|<\/ul>|<\/ol>)\s*<\/p><p>/g, '$1');

    if (!html.trim()) return '<p></p>';
    // defensive wrap for any remaining leading loose text
    html = html.replace(/^(?![<\s])(.+?)(?=<|$)/gm, '<p>$1</p>');
    return html;
  }

  function htmlToSimpleMarkdown(html: string): string {
    if (!html) return '';
    // Use real DOM parsing for fidelity (prevents tag leakage into .md)
    const container = document.createElement('div');
    container.innerHTML = html;

    const lines: string[] = [];

    function walk(node: Node, listType?: 'bullet' | 'task' | 'ol', checked?: boolean) {
      if (node.nodeType === Node.TEXT_NODE) {
        const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) lines.push(t);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return;
      const el = node as HTMLElement;
      const tag = el.tagName.toLowerCase();

      if (tag === 'h1') { lines.push('# ' + el.textContent?.trim()); lines.push(''); return; }
      if (tag === 'h2') { lines.push('## ' + el.textContent?.trim()); lines.push(''); return; }
      if (tag === 'h3') { lines.push('### ' + el.textContent?.trim()); lines.push(''); return; }

      if (tag === 'strong' || tag === 'b') { /* handled in p context */ }
      if (tag === 'em' || tag === 'i') { /* handled */ }
      if (tag === 'code') { /* handled */ }

      if (tag === 'p') {
        // build inline md for paragraph
        let txt = '';
        const processInline = (n: Node): string => {
          if (n.nodeType === Node.TEXT_NODE) return (n.textContent || '');
          const e = n as HTMLElement;
          if (!e) return '';
          const t = e.tagName ? e.tagName.toLowerCase() : '';
          const inner = Array.from(e.childNodes).map(processInline).join('');
          if (t === 'strong' || t === 'b') return '**' + inner + '**';
          if (t === 'em' || t === 'i') return '*' + inner + '*';
          if (t === 'code') return '`' + inner + '`';
          return inner;
        };
        txt = Array.from(el.childNodes).map(processInline).join('').replace(/\s+/g, ' ').trim();
        if (txt) lines.push(txt);
        lines.push('');
        return;
      }

      if (tag === 'ul') {
        const isTask = el.getAttribute('data-type') === 'taskList';
        Array.from(el.children).forEach((li) => {
          if ((li as HTMLElement).tagName.toLowerCase() !== 'li') return;
          const liEl = li as HTMLElement;
          const isTaskItem = liEl.getAttribute('data-type') === 'taskItem';
          const ch = liEl.getAttribute('data-checked') === 'true';
          // extract text, ignoring the checkbox label UI
          let itemText = '';
          const contentEl = liEl.querySelector('div, p') || liEl;
          itemText = (contentEl.textContent || '').replace(/\s+/g, ' ').trim();
          if (isTask || isTaskItem) {
            lines.push(`- [${ch ? 'x' : ' '}] ${itemText}`);
          } else {
            lines.push(`- ${itemText}`);
          }
        });
        lines.push('');
        return;
      }

      if (tag === 'ol') {
        let n = 1;
        Array.from(el.children).forEach((li) => {
          if ((li as HTMLElement).tagName.toLowerCase() !== 'li') return;
          const txt = ((li as HTMLElement).textContent || '').replace(/\s+/g, ' ').trim();
          lines.push(`${n}. ${txt}`);
          n++;
        });
        lines.push('');
        return;
      }

      if (tag === 'li') {
        // fallback if li outside recognized list
        const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
        lines.push(`- ${txt}`);
        return;
      }

      if (tag === 'br') { lines.push(''); return; }

      // recurse for other containers
      Array.from(el.childNodes).forEach((c) => walk(c));
    }

    Array.from(container.childNodes).forEach((n) => walk(n));

    let md = lines.join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return md;
  }

  let taskItemClickHandler: ((event: MouseEvent) => void) | null = null;

  function initEditor(initialContent: string) {
    if (editor) {
      if (taskItemClickHandler && editor.view?.dom) {
        editor.view.dom.removeEventListener('click', taskItemClickHandler, { capture: true });
      }
      editor.destroy();
    }

    const htmlContent = simpleMarkdownToHtml(initialContent);

    editor = new Editor({
      element: editorElement,
      extensions: [
        StarterKit.configure({
          bulletList: false,
          orderedList: false,
          listItem: false,
        }),
        TaskMarkdownInput,
        SafeBulletList,
        OrderedList,
        ListItem,
        ListKeymap,
        TaskList,
        TaskItem.configure({ nested: true }),
        Underline,
        Link.configure({ openOnClick: false }),
        Placeholder.configure({ placeholder: 'Type markdown here. # for headings, - lists, - [ ] tasks...' }),
      ],
      content: htmlContent,
      onCreate: ({ editor: ed }) => {
        taskItemClickHandler = (event: MouseEvent) => {
          const target = event.target as HTMLElement;
          const li = target.closest('li[data-type="taskItem"]') as HTMLElement | null;
          if (!li) return;
          if (target.closest('label')) return;

          try {
            const pos = ed.view.posAtDOM(li, 0);
            const resolved = ed.state.doc.resolve(pos);
            let taskDepth = -1;
            for (let d = resolved.depth; d >= 0; d--) {
              if (resolved.node(d).type.name === 'taskItem') {
                taskDepth = d;
                break;
              }
            }
            if (taskDepth >= 0) {
              const taskStart = resolved.before(taskDepth);
              const contentPos = getTaskItemContentPos(ed.state.doc, taskStart);
              if (contentPos !== null) {
                ed.commands.setTextSelection(contentPos);
                ed.commands.focus();
                event.preventDefault();
              }
            }
          } catch {
            ed.commands.focus();
          }
        };
        ed.view.dom.addEventListener('click', taskItemClickHandler, { capture: true });
      },
      onUpdate: ({ editor: ed }) => {
        if (isLoadingNote) {
          isLoadingNote = false;
          return;
        }
        currentEditorHtml = ed.getHTML();
        setTimeout(() => {
          if (editor && !isLoadingNote) {
            content = htmlToSimpleMarkdown(currentEditorHtml);
            onContentInput();
          }
        }, 0);
      },
    });
    setTimeout(() => { try { editor?.commands.focus(); } catch {} }, 0);
  }

  let currentEditorHtml = '';

  // Reliable drag support for frameless window on macOS
  function startWindowDrag(e: MouseEvent) {
    if (e.button === 0) { // left click only
      win.startDragging();
    }
  }

  // Derived title
  $effect(() => {
    const firstLine = (content || '').split('\n').find((l) => l.trim()) || 'Untitled Note';
    noteTitle = firstLine.replace(/^#+\s*/, '').trim() || 'Untitled Note';
  });

  async function loadNote(path: string) {
    try {
      const text = (await invoke('read_note', { path })) as string;
      content = text;
      currentPath = path;
      showList = false;
      isLoadingNote = true;

      const htmlContent = simpleMarkdownToHtml(text);

      // Ensure we have a live editor mounted on the (persistent) element.
      // Destroy previous if any (in case of prior element swap edge cases).
      if (editor) {
        editor.destroy();
        editor = null;
      }

      if (editorElement) {
        initEditor(text); // always fresh init on current element for reliability
        // set explicit content (init already did, but ensure)
        // init used the md->html path already
      } else {
        // element not bound yet (very early); defer a tick in caller if needed
        // try init anyway on next paint via the post mount effect
      }

      // Focus the editor so caret is ready. Using plain focus() to avoid forcing
      // the caret to the very end (which could make task items in the middle
      // appear unreachable).
      setTimeout(() => {
        if (editor) {
          try { editor.commands.focus(); } catch {}
        }
        isLoadingNote = false;
      }, 10);
    } catch (e) {
      console.error(e);
      isLoadingNote = false;
    }
  }

  async function saveCurrent() {
    if (!currentPath || !content) return;
    try {
      await invoke('write_note', { path: currentPath, content });
    } catch (e) {
      console.error('save failed', e);
    }
  }

  async function createNewNote() {
    try {
      const newNote = (await invoke('create_note')) as NoteInfo;
      await refreshNotes();
      isLoadingNote = true;
      await loadNote(newNote.path);
    } catch (e) {
      console.error(e);
      isLoadingNote = false;
    }
  }

  async function refreshNotes() {
    try {
      notes = (await invoke('list_notes')) as NoteInfo[];
    } catch (e) {
      console.error(e);
      notes = [];
    }
  }

  function onContentInput() {
    // Debounce in real version
    saveCurrent();
  }

  async function toggleWindow() {
    try {
      if (isVisible) {
        await win.hide();
        isVisible = false;
      } else {
        await win.show();
        await win.setFocus();
        isVisible = true;
      }
    } catch (e) {
      console.error('toggle failed', e);
    }
  }

  async function toggleBrowser() {
    showList = !showList;
    if (showList) await refreshNotes();
  }

  onMount(async () => {
    // Global shortcut
    try {
      await register('Option+N', toggleWindow);
    } catch (e) {
      try { await register('Alt+N', toggleWindow); } catch {}
    }

    // Basic in-app shortcuts (Cmd/Ctrl + key)
    const handleKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        toggleBrowser();
      }
      if (mod && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        createNewNote();
      }
      // Cmd/Ctrl + K stub for palette (expand later)
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        alert('⌘K palette (to be expanded with cmdk)');
      }
    };
    window.addEventListener('keydown', handleKey);

    await win.show();

    // Bootstrap: load default notes + open/create one
    await refreshNotes();
    if (notes.length > 0) {
      isLoadingNote = true;
      await loadNote(notes[0].path);
    } else {
      await createNewNote();
    }

    // Final safety net (in case bind:this raced the first async load)
    if (editorElement && !editor && content) {
      isLoadingNote = true;
      initEditor(content);
      setTimeout(() => {
        if (editor) { try { editor.commands.focus(); } catch {} }
        isLoadingNote = false;
      }, 10);
    }
  });

  onDestroy(async () => {
    if (editor) {
      if (taskItemClickHandler && editor.view?.dom) {
        editor.view.dom.removeEventListener('click', taskItemClickHandler, { capture: true });
      }
      editor.destroy();
      editor = null;
    }
    try { await unregister('Option+N'); } catch {}
    try { await unregister('Alt+N'); } catch {}
  });
</script>

<div class="note-window">
  <!-- Minimal centered title (Raycast Notes style) - draggable area.
       Browse/new-note are reachable via Cmd/Ctrl+P and Cmd/Ctrl+N. -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="titlebar" role="presentation" data-tauri-drag-region onmousedown={startWindowDrag}>
    <span class="title-dim" title={noteTitle} data-tauri-drag-region>{noteTitle}</span>
  </div>

  <!-- List (Browse) - only shown when active. Editor container is ALWAYS in DOM so bind:this + Tiptap instance survive toggles. -->
  {#if showList}
    <div class="editor-container overflow-auto p-2">
      {#each notes as n}
        <button 
          class="w-full text-left px-3 py-1.5 rounded hover:bg-black/5 dark:hover:bg-white/10 mb-0.5 flex justify-between text-sm"
          onclick={() => loadNote(n.path)}>
          <span class="truncate">{n.title}</span>
          {#if n.pinned}<span class="text-[10px] opacity-50">📌</span>{/if}
        </button>
      {/each}
      {#if notes.length === 0}
        <div class="opacity-50 p-4 text-sm">No notes yet. Create one.</div>
      {/if}
    </div>
  {/if}

  <!-- Editor area is kept mounted at all times (hidden via class when browsing).
       This fixes being unable to load previous/landing notes after showList toggle. -->
  <div class:hidden={showList} class="editor-container">
    <div bind:this={editorElement} class="tiptap-editor prose dark:prose-invert max-w-none focus:outline-none"></div>
  </div>

  <div class="statusbar">
    <span class="charcount">{charCount} {charCount === 1 ? 'character' : 'characters'}</span>
  </div>
</div>

<style>
/* All styles in src/app.css (Tailwind + custom .note-window etc.) */
</style>
