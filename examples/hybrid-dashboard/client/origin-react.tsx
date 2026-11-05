import { reactIsland } from '@nestvexa/islands/react';

/** Deliberate hydration mismatch (diagnostics page): text differs per side. */
export function Origin() {
  return (
    <p className="origin">
      Rendered in {typeof window === 'undefined' ? 'server' : 'browser'}
    </p>
  );
}
export default reactIsland(Origin);
