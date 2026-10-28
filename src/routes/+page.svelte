<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';

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
  import { simpleMarkdownToHtml, htmlToSimpleMarkdown } from '$lib/markdown';

  // State
  type NoteInfo = { id: string; path: string; title: string; mtime: number; pinned: boolean };

  let content = $state('');
  let currentPath = $state('');
  let noteTitle = $state('Plain Notes');
  let notes = $state<NoteInfo[]>([]);
  let showList = $state(false);
  let isLoadingNote = $state(false);
  // Live-sync: unsaved edits exist (isDirty), and the open note changed on disk
  // while we had unsaved edits (externalChangePending → show conflict banner).
  let isDirty = $state(false);
  let externalChangePending = $state(false);
  let connectStatus = $state('');
  let unlistenNotesChanged: UnlistenFn | null = null;

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

  // The exact text we last wrote to disk. Used to recognise our own save echoes
  // coming back through the file watcher so we don't tear the editor down and
  // re-create it mid-edit (which reset the caret to the top).
  let lastSavedContent = '';

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
      lastSavedContent = text; // disk and memory now agree
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
      const saved = content;
      await invoke('write_note', { path: currentPath, content: saved });
      lastSavedContent = saved;
      isDirty = false;
    } catch (e) {
      console.error('save failed', e);
    }
  }

  // Live-sync conflict resolution (shown only when the open note changed on disk
  // while it had unsaved edits).
  async function reloadFromDisk() {
    externalChangePending = false;
    if (currentPath) {
      await loadNote(currentPath);
      isDirty = false;
    }
  }
  async function keepMyVersion() {
    externalChangePending = false;
    await saveCurrent(); // overwrite disk with the in-memory version
  }

  // Register the bundled MCP server with Claude Desktop (writes its config).
  async function connectToClaude() {
    connectStatus = 'Connecting…';
    try {
      connectStatus = (await invoke('connect_claude_desktop')) as string;
    } catch (e) {
      connectStatus = `Failed: ${e}`;
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
    isDirty = true;
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
    // Basic in-app shortcuts (Cmd/Ctrl + key)
    const handleKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // ESC fully quits the app (terminates the process)
      if (e.key === 'Escape') {
        e.preventDefault();
        invoke('quit_app');
        return;
      }
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

    // Live-sync: when notes change on disk (e.g. via the bundled MCP server),
    // refresh the list and reconcile the open note without losing unsaved edits.
    unlistenNotesChanged = await listen<{ paths: string[] }>('notes-changed', async (event) => {
      const changed = event.payload?.paths ?? [];
      await refreshNotes();
      if (currentPath && !showList && changed.includes(currentPath)) {
        // Re-read the note and compare against what we already have. If disk
        // matches our in-memory content (or the last thing we saved), this event
        // is just the echo of our own write bouncing back through the watcher —
        // reloading here would destroy and re-create the editor mid-edit, which
        // resets the caret to the top. Only reconcile on a genuine divergence.
        let disk: string;
        try {
          disk = (await invoke('read_note', { path: currentPath })) as string;
        } catch {
          return;
        }
        if (disk === content || disk === lastSavedContent) return;
        if (!isDirty) {
          await loadNote(currentPath); // clean: silently reload from disk
        } else {
          externalChangePending = true; // unsaved edits: ask the user
        }
      }
    });

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

    // Global shortcut. Registered last: typing in the open note doesn't need it.
    try {
      await register('Option+N', toggleWindow);
    } catch (e) {
      try { await register('Alt+N', toggleWindow); } catch {}
    }
  });

  onDestroy(async () => {
    if (unlistenNotesChanged) { unlistenNotesChanged(); unlistenNotesChanged = null; }
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
      <div class="connect-bar">
        <button class="connect-btn" onclick={connectToClaude}>Connect to Claude</button>
        {#if connectStatus}<span class="connect-status">{connectStatus}</span>{/if}
      </div>
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

  {#if externalChangePending && !showList}
    <div class="external-change-banner">
      <span>This note changed on disk.</span>
      <button onclick={reloadFromDisk}>Reload from disk</button>
      <button onclick={keepMyVersion}>Keep my version</button>
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
.external-change-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  background: rgba(255, 200, 0, 0.15);
  border-bottom: 1px solid rgba(255, 200, 0, 0.3);
}
.external-change-banner button {
  padding: 2px 8px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.12);
  cursor: pointer;
}
.external-change-banner button:hover {
  background: rgba(255, 255, 255, 0.22);
}
.connect-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 2px 4px 8px;
}
.connect-btn {
  font-size: 12px;
  padding: 3px 10px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
  cursor: pointer;
}
.connect-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}
.connect-status {
  font-size: 11px;
  opacity: 0.7;
}
</style>
