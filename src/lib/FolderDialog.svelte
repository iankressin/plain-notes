<script lang="ts">
  import { onMount } from 'svelte';
  import type { FolderInfo } from './notes';

  let { mode, folder, folders, onSubmit, onClose }: {
    mode: 'create' | 'move';
    folder: string;
    folders: FolderInfo[];
    onSubmit: (value: string) => Promise<void>;
    onClose: () => void;
  } = $props();

  let dialog: HTMLDialogElement;
  let input = $state<HTMLInputElement>();
  let select = $state<HTMLSelectElement>();
  let name = $state('');
  let destination = $state('');
  let busy = $state(false);
  let error = $state('');

  onMount(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    destination = folder;
    dialog.showModal();
    if (mode === 'create') input?.focus();
    else select?.focus();
    return () => previousFocus?.focus({ preventScroll: true });
  });

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (busy || (mode === 'create' && !name.trim())) return;
    busy = true;
    error = '';
    try {
      await onSubmit(mode === 'create' ? name.trim() : destination);
      onClose();
    } catch (reason) {
      error = String(reason);
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialog} aria-labelledby="folder-dialog-title" oncancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
  <form onsubmit={submit} aria-busy={busy}>
    <h2 id="folder-dialog-title">{mode === 'create' ? 'New folder' : 'Move note to folder'}</h2>
    {#if mode === 'create'}
      <p class="location">Inside {folder || 'Notes'}</p>
      <label for="folder-name">Folder name</label>
      <input id="folder-name" bind:this={input} bind:value={name} autocomplete="off" required disabled={busy} />
    {:else}
      <label for="folder-destination">Destination folder</label>
      <select id="folder-destination" bind:this={select} bind:value={destination} disabled={busy}>
        <option value="">Notes (root)</option>
        {#each folders as entry (entry.path)}
          <option value={entry.path}>{entry.path}</option>
        {/each}
      </select>
    {/if}
    {#if error}<p role="alert" class="error">{error}</p>{/if}
    <div class="actions">
      <button type="button" onclick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" disabled={busy || (mode === 'create' ? !name.trim() : destination === folder)}>
        {busy ? (mode === 'create' ? 'Creating…' : 'Moving…') : (mode === 'create' ? 'Create folder' : 'Move note')}
      </button>
    </div>
  </form>
</dialog>

<style>
  dialog { width: min(360px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); padding: 20px; margin: auto; border: 1px solid var(--rc-line); border-radius: 12px; background: #fff; color: #1c1c1e; font-size: 13px; overflow-y: auto; box-shadow: 0 12px 40px #0003; }
  dialog::backdrop { background: #0005; }
  h2 { font-size: 16px; font-weight: 650; margin: 0 0 16px; }
  .location { overflow-wrap: anywhere; margin: -8px 0 16px; }
  label { display: block; margin-bottom: 6px; font-weight: 550; }
  input, select { display: block; width: 100%; min-width: 0; min-height: 44px; border: 1px solid #777; border-radius: 6px; background: transparent; padding: 8px; color: inherit; font: inherit; }
  .actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 20px; }
  button { min-height: 44px; padding: 8px 12px; border-radius: 6px; cursor: pointer; }
  button:hover { background: #0000000a; }
  button[type='submit'] { background: #1c1c1e; color: #f5f5f7; }
  button:disabled { opacity: 0.55; cursor: default; }
  :is(button, input, select):focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
  button[type='submit']:focus-visible { outline-color: #1c1c1e; }
  .error { margin: 12px 0 0; overflow-wrap: anywhere; }
  @media (prefers-color-scheme: dark) {
    dialog { background: #1c1c1e; color: #f5f5f7; color-scheme: dark; }
    input, select { border-color: #999; }
    button:hover { background: #ffffff14; }
    button[type='submit'] { background: #f5f5f7; color: #1c1c1e; }
    button[type='submit']:focus-visible { outline-color: #f5f5f7; }
  }
</style>
