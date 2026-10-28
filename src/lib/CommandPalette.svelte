<script lang="ts" module>
  // An item with `ask` takes a line of input (e.g. a URL) before it runs.
  export type PaletteItem = {
    id: string;
    label: string;
    hint?: string;
    run?: () => void;
    ask?: { placeholder: string; submit: (value: string) => void };
  };
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import fuzzysort from 'fuzzysort';

  let {
    notes,
    commands,
    onCreate,
    onClose,
  }: {
    notes: PaletteItem[]; // most relevant first: shown as-is when nothing is typed
    commands: PaletteItem[];
    onCreate: (title: string) => void;
    onClose: () => void;
  } = $props();

  const RECENT_NOTES = 5;
  const MAX_MATCHES = 12;

  let query = $state('');
  let selected = $state(0);
  let asking = $state<PaletteItem['ask'] | null>(null);
  let input: HTMLInputElement;
  let list: HTMLDivElement | undefined = $state();

  let items = $derived.by((): PaletteItem[] => {
    if (asking) return [];
    const q = query.trim();
    if (!q) return [...notes.slice(0, RECENT_NOTES), ...commands];
    const matches = fuzzysort
      .go(q, [...notes, ...commands], { key: 'label', limit: MAX_MATCHES })
      .map((r) => r.obj);
    return [...matches, { id: 'create', label: `Create note “${q}”`, run: () => onCreate(q) }];
  });

  $effect(() => {
    list?.children[selected]?.scrollIntoView({ block: 'nearest' });
  });

  onMount(() => input.focus());

  function run(item: PaletteItem) {
    if (item.ask) {
      asking = item.ask;
      query = '';
      input.focus();
      return;
    }
    onClose();
    item.run?.();
  }

  // Escape, ⌘N and ⌘P bubble up to the page's window handler.
  function onKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      const value = query.trim();
      if (asking) {
        if (!value) return;
        onClose();
        asking.submit(value);
      } else if (items[selected]) {
        run(items[selected]);
      }
    } else if (items.length && e.key === 'ArrowDown') {
      e.preventDefault();
      selected = (selected + 1) % items.length;
    } else if (items.length && e.key === 'ArrowUp') {
      e.preventDefault();
      selected = (selected - 1 + items.length) % items.length;
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="palette-backdrop" onclick={onClose}></div>
<div class="palette" role="dialog" aria-label="Command palette">
  <input
    bind:this={input}
    bind:value={query}
    oninput={() => (selected = 0)}
    onkeydown={onKeydown}
    class="palette-input"
    placeholder={asking?.placeholder ?? 'Search notes or run a command…'}
    spellcheck="false"
    autocomplete="off"
  />
  {#if items.length}
    <div bind:this={list} class="palette-list" role="listbox">
      {#each items as item, i (item.id)}
        <button
          class="palette-item"
          class:selected={i === selected}
          role="option"
          aria-selected={i === selected}
          onmousemove={() => (selected = i)}
          onclick={() => run(item)}
        >
          <span class="truncate">{item.label}</span>
          {#if item.hint}<span class="palette-hint">{item.hint}</span>{/if}
        </button>
      {/each}
    </div>
  {/if}
</div>
