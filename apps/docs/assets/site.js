// Progressive enhancement: filter the sidebar by page title. The site is fully
// usable without this script.
const { document } = globalThis;
const input = document.getElementById('nav-filter');
if (input) {
  input.addEventListener('input', () => {
    const query = input.value.trim().toLowerCase();
    for (const section of document.querySelectorAll('.sidebar details')) {
      let visible = 0;
      for (const item of section.querySelectorAll('li')) {
        const match = !query || item.textContent.toLowerCase().includes(query);
        item.hidden = !match;
        if (match) visible++;
      }
      section.hidden = visible === 0;
      if (query) section.open = visible > 0;
    }
  });
}
