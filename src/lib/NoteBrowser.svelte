<script lang="ts">
  import { Folder, ChevronRight, Pin } from 'lucide-svelte';
  import type { FolderInfo, NoteInfo } from './notes';

  let { notes, folders, folder, loading, error, onFolder, onOpen, onNewFolder, onNewNote, onRetry }: {
    notes: NoteInfo[];
    folders: FolderInfo[];
    folder: string;
    loading: boolean;
    error: string;
    onFolder: (path: string) => void;
    onOpen: (path: string) => void;
    onNewFolder: () => void;
    onNewNote: () => void;
    onRetry: () => void;
  } = $props();

  const parentOf = (path: string) => path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  let childFolders = $derived(folders.filter((entry) => parentOf(entry.path) === folder));
  let childNotes = $derived(notes.filter((note) => note.folder === folder));
  let crumbs = $derived(folder ? folder.split('/').map((name, i, parts) => ({ name, path: parts.slice(0, i + 1).join('/') })) : []);
</script>

<div class="note-browser" aria-busy={loading}>
  <nav aria-label="Folder location" class="breadcrumbs">
    <button onclick={() => onFolder('')} aria-current={folder === '' ? 'location' : undefined}>Notes</button>
    {#each crumbs as crumb (crumb.path)}
      <ChevronRight size={14} aria-hidden="true" />
      <button onclick={() => onFolder(crumb.path)} title={crumb.name}
        aria-current={crumb.path === folder ? 'location' : undefined}>{crumb.name}</button>
    {/each}
  </nav>
  <div class="browser-actions">
    <button onclick={onNewNote} disabled={loading}>New note</button>
    <button onclick={onNewFolder} disabled={loading}>New folder</button>
  </div>
  {#if error}
    <div class="browser-message" role="alert">
      <p>{error}</p>
      <button onclick={onRetry}>Retry</button>
    </div>
  {:else if loading}
    <p class="browser-message" role="status">Loading notes and folders…</p>
  {:else}
    <div class="browser-entries">
      {#each childFolders as entry (entry.path)}
        <button class="browser-row folder-row" aria-label={`Open folder ${entry.name}`} onclick={() => onFolder(entry.path)}>
          <Folder size={18} aria-hidden="true" />
          <span title={entry.name}>{entry.name}</span>
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      {/each}
      {#each childNotes as note (note.path)}
        <button class="browser-row" onclick={() => onOpen(note.path)}>
          <span title={note.title}>{note.title}</span>
          {#if note.pinned}<Pin size={14} aria-label="Pinned" />{/if}
        </button>
      {/each}
    </div>
    {#if childFolders.length === 0 && childNotes.length === 0}
      <div class="browser-message">
        <p>This folder is empty.</p>
        <p>Create a note or a subfolder here.</p>
      </div>
    {/if}
  {/if}
</div>

<style>
  .note-browser { min-width: 0; font-size: 13px; }
  .breadcrumbs { display: flex; align-items: center; flex-wrap: wrap; gap: 2px; margin-bottom: 8px; }
  .breadcrumbs button { max-width: 100%; padding: 4px 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .breadcrumbs [aria-current] { font-weight: 650; }
  .breadcrumbs :global(svg) { flex-shrink: 0; }
  button { min-height: 44px; border-radius: 6px; cursor: pointer; }
  button:hover { background: var(--rc-fill); }
  button:focus-visible { outline: 2px solid currentColor; outline-offset: -2px; }
  button:disabled { opacity: 0.6; cursor: wait; }
  .browser-actions { display: flex; flex-wrap: wrap; gap: 6px; padding-bottom: 12px; border-bottom: 1px solid var(--rc-line); margin-bottom: 8px; }
  .browser-actions button, .browser-message button { padding: 6px 12px; background: var(--rc-fill); }
  .browser-row { display: flex; width: 100%; min-width: 0; align-items: center; gap: 10px; padding: 8px 10px; text-align: left; }
  .browser-row span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .browser-row :global(svg) { flex-shrink: 0; }
  .folder-row { font-weight: 550; }
  .browser-message { padding: 16px 8px; overflow-wrap: anywhere; }
  .browser-message p { margin: 0 0 8px; }
</style>
