<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { register, unregister } from '@tauri-apps/plugin-global-shortcut';
  import { invoke } from '@tauri-apps/api/core';
  import { listen, type UnlistenFn } from '@tauri-apps/api/event';

  // Tiptap rich editor for proper markdown rendering + editing
  import { Editor, type ChainedCommands } from '@tiptap/core';
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
    clearCheckedTasks,
    moveCheckedTasksToBottom,
    uncheckAllTasks,
  } from '$lib/task-editor';
  import { simpleMarkdownToHtml, htmlToSimpleMarkdown, markdownToPlainText } from '$lib/markdown';
  import { splitFrontmatter, isPinned, setPinned } from '$lib/frontmatter';
  import { MermaidCodeBlock } from '$lib/code-block';
  import { TableExtensions } from '$lib/table';
  import CommandPalette, { type PaletteItem } from '$lib/CommandPalette.svelte';
  import NoteBrowser from '$lib/NoteBrowser.svelte';
  import FolderDialog from '$lib/FolderDialog.svelte';
  import type { NoteInfo, FolderInfo } from '$lib/notes';
  import { writeText } from '@tauri-apps/plugin-clipboard-manager';

  // The open note is `frontmatter + content`; the editor only edits `content`.
  let content = $state('');
  let frontmatter = $state('');
  let currentPath = $state('');
  let noteTitle = $state('Plain Notes');
  let notes = $state<NoteInfo[]>([]);
  let folders = $state<FolderInfo[]>([]);
  let activeFolder = $state('');
  let browserLoading = $state(true);
  let browserError = $state('');
  let folderDialog = $state<'create' | 'move' | null>(null);
  let isMoving = $state(false);
  let isCreating = false;
  let missingNote = $state(false);
  let saveQueue: Promise<boolean> = Promise.resolve(true);
  let refreshVersion = 0;
  let showList = $state(false);
  let isLoadingNote = $state(false);
  // Live-sync: unsaved edits exist (isDirty), and the open note changed on disk
  // while we had unsaved edits (externalChangePending → show conflict banner).
  let isDirty = $state(false);
  let externalChangePending = $state(false);
  let connectStatus = $state('');
  let unlistenNotesChanged: UnlistenFn | null = null;

  let showPalette = $state(false);
  // Whether the caret was in a table when the palette opened (shows the table commands).
  let inTable = $state(false);
  let statusMessage = $state('');
  // Notes opened this session, most recent first.
  let recentPaths = $state<string[]>([]);

  let pinned = $derived(isPinned(frontmatter));

  // Recently opened notes first, then the rest in list order (pinned, then
  // newest). The open note is left out: you're already there.
  let paletteNotes = $derived.by((): PaletteItem[] => {
    const recent = recentPaths
      .map((p) => notes.find((n) => n.path === p))
      .filter((n): n is NoteInfo => !!n);
    const rest = notes.filter((n) => !recentPaths.includes(n.path));
    return [...recent, ...rest]
      .filter((n) => n.path !== currentPath)
      .map((n) => ({
        id: n.path,
        label: n.title,
        hint: [n.folder || 'Notes', n.pinned ? 'Pinned' : ''].filter(Boolean).join(' · '),
        searchText: `${n.title} ${n.folder}`,
        run: () => loadNote(n.path),
      }));
  });

  let hasTasks = $derived(/^\s*- \[[ xX]\]/m.test(content));

  let paletteCommands = $derived<PaletteItem[]>([
    { id: 'new', label: 'New note', hint: '⌘N', run: () => createNewNote() },
    { id: 'browse', label: 'Browse notes and folders', hint: '⌘P', run: toggleBrowser },
    { id: 'new-folder', label: 'New folder', hint: activeFolder || 'Notes', run: () => openFolderDialog('create') },
    { id: 'move-folder', label: 'Move note to folder', hint: 'Command', run: () => openFolderDialog('move') },
    { id: 'pin', label: pinned ? 'Unpin note' : 'Pin note', hint: 'Command', run: togglePin },
    { id: 'copy-md', label: 'Copy as markdown', hint: 'Command', run: () => copyNote('markdown') },
    { id: 'copy-text', label: 'Copy as plain text', hint: 'Command', run: () => copyNote('text') },
    { id: 'trash', label: 'Move note to Trash', hint: 'Command', run: trashCurrentNote },
    ...(hasTasks
      ? [
          { id: 'tasks-clear', label: 'Clear checked tasks', hint: 'Command', run: () => taskCommand(clearCheckedTasks) },
          { id: 'tasks-sink', label: 'Move checked tasks to bottom', hint: 'Command', run: () => taskCommand(moveCheckedTasksToBottom) },
          { id: 'tasks-uncheck', label: 'Uncheck all tasks', hint: 'Command', run: () => taskCommand(uncheckAllTasks) },
        ]
      : []),
    { id: 'h1', label: 'Heading 1', hint: '⌥⌘1', run: format((c) => c.toggleHeading({ level: 1 })) },
    { id: 'h2', label: 'Heading 2', hint: '⌥⌘2', run: format((c) => c.toggleHeading({ level: 2 })) },
    { id: 'h3', label: 'Heading 3', hint: '⌥⌘3', run: format((c) => c.toggleHeading({ level: 3 })) },
    { id: 'bullets', label: 'Bullet list', hint: '⇧⌘8', run: format((c) => c.toggleBulletList()) },
    { id: 'numbers', label: 'Numbered list', hint: '⇧⌘7', run: format((c) => c.toggleOrderedList()) },
    { id: 'task-list', label: 'Task list', hint: '⇧⌘9', run: format((c) => c.toggleTaskList()) },
    { id: 'code', label: 'Code block', hint: '⌥⌘C', run: format((c) => c.toggleCodeBlock()) },
    { id: 'link', label: 'Insert link', hint: 'Command', ask: { placeholder: 'Paste a link and press Enter', submit: insertLink } },
    { id: 'table', label: 'Insert table', hint: 'Command', run: format((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true })) },
    ...(inTable
      ? [
          { id: 'row-add', label: 'Add row below', hint: 'Command', run: format((c) => c.addRowAfter()) },
          { id: 'col-add', label: 'Add column to the right', hint: 'Command', run: format((c) => c.addColumnAfter()) },
          { id: 'row-delete', label: 'Delete row', hint: 'Command', run: format((c) => c.deleteRow()) },
          { id: 'col-delete', label: 'Delete column', hint: 'Command', run: format((c) => c.deleteColumn()) },
          { id: 'table-delete', label: 'Delete table', hint: 'Command', run: format((c) => c.deleteTable()) },
        ]
      : []),
    { id: 'diagram', label: 'Insert diagram', hint: 'Command', run: insertDiagram },
    { id: 'folder', label: 'Open notes folder in Finder', hint: 'Command', run: () => invokeOrFlash('open_notes_folder') },
    { id: 'reveal', label: 'Reveal note in Finder', hint: 'Command', run: () => invokeOrFlash('reveal_note', { path: currentPath }) },
    { id: 'claude', label: 'Connect to Claude', hint: 'Command', run: connectToClaude },
    { id: 'quit', label: 'Quit Plain Notes', hint: 'esc', run: () => invoke('quit_app') },
  ]);

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

  function setEditorEditable(editable: boolean) {
    // setEditable emits a content update by default, which would rewrite untouched Markdown.
    editor?.setOptions({
      editable,
      editorProps: { attributes: { role: 'textbox', 'aria-readonly': String(!editable) } },
    });
  }

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
          codeBlock: false,
        }),
        MermaidCodeBlock.configure({ enableTabIndentation: true, tabSize: 2 }),
        ...TableExtensions,
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
        if (isLoadingNote || isMoving || missingNote) return;
        content = htmlToSimpleMarkdown(ed.getHTML());
        onContentInput();
      },
    });
    setTimeout(() => { try { editor?.commands.focus(); } catch {} }, 0);
  }

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
    if (isMoving || isLoadingNote) return;
    if (externalChangePending && isDirty) {
      flash('Resolve the changes on disk before switching notes.', 5000);
      return;
    }
    isLoadingNote = true;
    setEditorEditable(false);
    try {
      if (isDirty && !missingNote && !(await saveCurrent())) return;
      const text = (await invoke('read_note', { path })) as string;
      const parts = splitFrontmatter(text);
      frontmatter = parts.frontmatter;
      content = parts.body;
      lastSavedContent = text; // disk and memory now agree
      currentPath = path;
      activeFolder = notes.find((note) => note.path === path)?.folder ?? '';
      missingNote = false;
      isDirty = false;
      externalChangePending = false;
      recentPaths = [path, ...recentPaths.filter((p) => p !== path)];
      showList = false;
      if (editor) {
        editor.destroy();
        editor = null;
      }

      if (editorElement) {
        initEditor(parts.body);
      }
    } catch (e) {
      console.error(e);
      flash(`Could not open note: ${String(e)}`, 5000);
    } finally {
      isLoadingNote = false;
      setEditorEditable(!missingNote);
    }
  }

  function saveCurrent(): Promise<boolean> {
    if (!currentPath || missingNote || externalChangePending) return Promise.resolve(false);
    const path = currentPath;
    const saved = frontmatter + content;
    saveQueue = saveQueue.then(async () => {
      await invoke('write_note', { path, content: saved });
      if (currentPath === path) {
        lastSavedContent = saved;
        isDirty = frontmatter + content !== saved;
      }
      return true;
    }).catch((error) => {
      console.error('save failed', error);
      flash(`Could not save note: ${String(error)}`, 5000);
      return false;
    });
    return saveQueue;
  }

  // Live-sync conflict resolution (shown only when the open note changed on disk
  // while it had unsaved edits).
  async function reloadFromDisk() {
    externalChangePending = false;
    if (currentPath) {
      await saveQueue;
      isDirty = false;
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
    flash(connectStatus, 6000);
  }

  async function createNewNote(title?: string) {
    if (isMoving || isLoadingNote || isCreating) return;
    if (isDirty && !missingNote && !(await saveCurrent())) return;
    isCreating = true;
    try {
      const newNote = (await invoke('create_note', { title, folder: activeFolder })) as NoteInfo;
      await refreshNotes();
      await loadNote(newNote.path);
    } catch (e) {
      console.error(e);
      flash(`Could not create note: ${String(e)}`, 5000);
    } finally {
      isCreating = false;
    }
  }

  async function openFolderDialog(mode: 'create' | 'move') {
    if (isMoving || isLoadingNote || (mode === 'move' && (!currentPath || missingNote))) return;
    if (!(await refreshNotes())) {
      showList = true;
      return;
    }
    if (!isMoving && !isLoadingNote) folderDialog = mode;
  }

  async function submitFolder(value: string) {
    if (isLoadingNote) throw new Error('Wait for the note to finish opening, then try again.');
    if (folderDialog === 'create') {
      await invoke('create_folder', { parent: activeFolder, name: value });
      await refreshNotes();
      flash('Folder created');
      return;
    }
    if (!currentPath || missingNote) throw new Error('This note is no longer at its original location.');
    if (externalChangePending) throw new Error('Resolve the changes on disk before moving this note.');
    isMoving = true;
    setEditorEditable(false);
    try {
      const saved = isDirty ? await saveCurrent() : await saveQueue;
      if (!saved) throw new Error('Could not save your edits. Try again before moving the note.');
      const previousPath = currentPath;
      const moved = await invoke<NoteInfo>('move_note', { path: previousPath, folder: value });
      currentPath = moved.path;
      activeFolder = moved.folder;
      recentPaths = recentPaths.map((path) => path === previousPath ? moved.path : path);
      notes = notes.map((note) => note.path === previousPath ? moved : note);
      await refreshNotes();
      flash(`Moved to ${moved.folder || 'Notes'}`);
    } finally {
      isMoving = false;
      setEditorEditable(!missingNote);
    }
  }

  async function togglePin() {
    if (!currentPath || isLoadingNote || isMoving || missingNote) return;
    frontmatter = setPinned(frontmatter, !pinned);
    await saveCurrent();
    await refreshNotes();
    flash(pinned ? 'Pinned' : 'Unpinned');
  }

  async function copyNote(format: 'markdown' | 'text') {
    const text = format === 'markdown' ? content : markdownToPlainText(content);
    try {
      await writeText(text);
      flash(format === 'markdown' ? 'Copied as markdown' : 'Copied as plain text');
    } catch (e) {
      console.error('copy failed', e);
      flash('Copy failed');
    }
  }

  async function trashCurrentNote() {
    if (isMoving || isLoadingNote || missingNote) return;
    const path = currentPath;
    if (!path) return;
    isMoving = true;
    setEditorEditable(false);
    await saveQueue;
    currentPath = ''; // stop saves from writing the note back while it's trashed
    try {
      await invoke('delete_note', { path });
    } catch (e) {
      console.error('trash failed', e);
      currentPath = path;
      isMoving = false;
      setEditorEditable(true);
      flash('Could not move note to Trash');
      return;
    }
    recentPaths = recentPaths.filter((p) => p !== path);
    isMoving = false;
    await refreshNotes();
    const next = recentPaths.find((p) => notes.some((n) => n.path === p)) ?? notes[0]?.path;
    if (next) await loadNote(next);
    else await createNewNote();
    flash('Moved to Trash');
  }

  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  function flash(message: string, ms = 1500) {
    statusMessage = message;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(() => (statusMessage = ''), ms);
  }

  function taskCommand(command: (editor: Editor) => boolean) {
    if (editor && !command(editor)) flash('Nothing to change');
  }

  function format(apply: (chain: ChainedCommands) => ChainedCommands) {
    return () => {
      if (editor) apply(editor.chain().focus()).run();
    };
  }

  // Links the selected text, or inserts the link itself when nothing is selected.
  function insertLink(url: string) {
    if (!editor) return;
    const href = /^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`;
    const chain = editor.chain().focus();
    if (editor.state.selection.empty) {
      chain.insertContent({ type: 'text', text: url, marks: [{ type: 'link', attrs: { href } }] }).run();
    } else {
      chain.extendMarkRange('link').setLink({ href }).run();
    }
  }

  // A starter flowchart to edit from.
  function insertDiagram() {
    editor
      ?.chain()
      .focus()
      .insertContent({
        type: 'codeBlock',
        attrs: { language: 'mermaid' },
        content: [{ type: 'text', text: 'flowchart TD\n  A[Start] --> B[End]' }],
      })
      .run();
  }

  async function invokeOrFlash(command: string, args?: Record<string, unknown>) {
    try {
      await invoke(command, args);
    } catch (e) {
      console.error(command, e);
      flash(String(e), 4000);
    }
  }

  function closePalette() {
    showPalette = false;
    try { editor?.commands.focus(); } catch {}
  }

  async function refreshNotes() {
    const version = ++refreshVersion;
    browserLoading = true;
    try {
      const [nextNotes, nextFolders] = await Promise.all([
        invoke<NoteInfo[]>('list_notes'), invoke<FolderInfo[]>('list_folders'),
      ]);
      if (version !== refreshVersion) return true;
      notes = nextNotes;
      folders = nextFolders;
      browserError = '';
      while (activeFolder && !folders.some((folder) => folder.path === activeFolder)) {
        activeFolder = activeFolder.includes('/') ? activeFolder.slice(0, activeFolder.lastIndexOf('/')) : '';
      }
      return true;
    } catch (e) {
      console.error(e);
      if (version === refreshVersion) browserError = `Could not load notes and folders: ${String(e)}`;
      return false;
    } finally {
      if (version === refreshVersion) browserLoading = false;
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
    if (isMoving || isLoadingNote) return;
    showList = !showList;
    if (showList) await refreshNotes();
  }

  onMount(async () => {
    // Basic in-app shortcuts (Cmd/Ctrl + key)
    const handleKey = (e: KeyboardEvent) => {
      if (folderDialog) return;
      const mod = e.metaKey || e.ctrlKey;
      // ESC closes the palette if open, otherwise fully quits the app
      if (e.key === 'Escape') {
        e.preventDefault();
        if (showPalette) closePalette();
        else if (showList) { showList = false; editor?.commands.focus(); }
        else invoke('quit_app');
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
      if (mod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (showPalette) {
          closePalette();
        } else {
          inTable = !!editor?.isActive('table');
          showPalette = true;
        }
      }
    };
    window.addEventListener('keydown', handleKey);

    await win.show();

    // Live-sync: when notes change on disk (e.g. via the bundled MCP server),
    // refresh the list and reconcile the open note without losing unsaved edits.
    unlistenNotesChanged = await listen<{ paths: string[] }>('notes-changed', async (event) => {
      const changed = event.payload?.paths ?? [];
      if (!(await refreshNotes()) || isMoving) return;
      if (currentPath && !notes.some((note) => note.path === currentPath)) {
        missingNote = true;
        setEditorEditable(false);
        return;
      }
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
        if (disk === frontmatter + content || disk === lastSavedContent) return;
        if (!isDirty) {
          await loadNote(currentPath); // clean: silently reload from disk
        } else {
          externalChangePending = true; // unsaved edits: ask the user
        }
      }
    });

    // Bootstrap: load default notes + open/create one
    if (!(await refreshNotes())) {
      showList = true;
      return;
    }
    if (notes.length > 0) {
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
    <div class="editor-container browse-container">
      <NoteBrowser
        {notes} {folders} folder={activeFolder} loading={browserLoading || isLoadingNote} error={browserError}
        onFolder={(path) => { activeFolder = path; }} onOpen={loadNote}
        onNewFolder={() => openFolderDialog('create')} onNewNote={() => createNewNote()} onRetry={refreshNotes}
      />
      <div class="connect-bar">
        <button class="connect-btn" onclick={connectToClaude}>Connect to Claude</button>
        {#if connectStatus}<span class="connect-status">{connectStatus}</span>{/if}
      </div>
    </div>
  {/if}

  {#if missingNote && !showList}
    <div class="external-change-banner" role="status">
      <span>This note was moved or removed. You can still copy its text.</span>
      <button onclick={() => copyNote('markdown')}>Copy text</button>
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
    <button class="navigation-button" onclick={toggleBrowser} disabled={isMoving || isLoadingNote || (showList && !currentPath)} title="Browse notes and folders (⌘P)">
      {showList ? 'Back to note' : 'Browse notes'}
    </button>
    <span class="charcount" class:status-flash={!!statusMessage} role="status" title={statusMessage}>
      {statusMessage || `${charCount} ${charCount === 1 ? 'character' : 'characters'}`}
    </span>
    {#if !showList && currentPath}
      <button class="navigation-button" onclick={() => openFolderDialog('move')} disabled={isMoving || isLoadingNote || missingNote}>Move note</button>
    {/if}
  </div>

  {#if folderDialog}
    <FolderDialog mode={folderDialog} {folders}
      folder={folderDialog === 'create' ? activeFolder : notes.find((note) => note.path === currentPath)?.folder ?? ''}
      onSubmit={submitFolder} onClose={() => { folderDialog = null; }} />
  {/if}

  {#if showPalette}
    <CommandPalette
      notes={paletteNotes}
      commands={paletteCommands}
      onCreate={(title) => createNewNote(title)}
      onClose={closePalette}
    />
  {/if}
</div>

<style>
/* All styles in src/app.css (Tailwind + custom .note-window etc.) */
.browse-container { padding: 4px 16px 16px; }
.statusbar { gap: 6px; padding: 2px 12px; }
.charcount { flex: 1; min-width: 0; text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-flash { color: var(--rc-text); }
.navigation-button { flex-shrink: 0; min-height: 44px; padding: 4px 6px; font-size: 11px; border-radius: 6px; cursor: pointer; }
.navigation-button:hover { background: var(--rc-fill); }
.navigation-button:disabled { opacity: 0.5; cursor: default; }
.navigation-button:focus-visible, .connect-btn:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
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
  padding: 16px 4px 8px;
}
.connect-btn {
  min-height: 44px;
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
