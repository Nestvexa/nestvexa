import { useState } from 'react';
import { reactIsland } from '@nestvexa/islands/react';
import type { IslandContext } from '@nestvexa/islands/client';

interface Props {
  readonly label: string;
  readonly start: number;
  readonly island: IslandContext;
}

/** React island: server-rendered by the Vite SSR build, hydrated in the browser. */
export function CounterReact({ label, start, island }: Props) {
  const [count, setCount] = useState(start);
  return (
    <div className="counter" data-framework="react">
      <p id="react-count">
        {label}: {count}
      </p>
      <p id="react-locale">Locale {island.shared.locale ?? 'unknown'}</p>
      <button type="button" onClick={() => setCount((value) => value + 1)}>
        Increment React
      </button>
    </div>
  );
}

export default reactIsland<Omit<Props, 'island'>>(CounterReact);
