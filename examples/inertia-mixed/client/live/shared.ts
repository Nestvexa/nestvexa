// Shared by both Live-page entries, so Vite emits it as its own chunk and the
// manifest lists it as a static import (rendered as a modulepreload tag).
export function markEnhanced(feature: string): void {
  const root = document.documentElement;
  const features = new Set((root.dataset['enhanced'] ?? '').split(' '));
  features.add(feature);
  root.dataset['enhanced'] = [...features].filter(Boolean).sort().join(' ');
}
