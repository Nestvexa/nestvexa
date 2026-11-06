<script lang="ts">
  let { title }: { title: string } = $props();
</script>

<svelte:head><title>{title}</title></svelte:head>
<h1>{title}</h1>
<p>Rendered by Svelte through Inertia.</p>
