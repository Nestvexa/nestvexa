<script lang="ts">
  let { heading, framework }: { heading: string; framework: string } = $props();
</script>

<h1>{heading}</h1>
<p data-testid="framework">Rendered by {framework}</p>
