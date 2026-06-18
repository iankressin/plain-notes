<script>
  import '../app.css';
  import { onMount } from 'svelte';

  // Make the whole app feel like a desktop utility
  onMount(() => {
    // Prevent context menu on right click if desired for notes feel
    // document.addEventListener('contextmenu', (e) => e.preventDefault());
  });
</script>

<slot />
