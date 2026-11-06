import { useState } from 'react';
import type { IslandContext } from '@nestvexa/islands/client';
import { reactIsland } from '@nestvexa/islands/react';

interface Props {
  readonly label?: string;
  readonly island: IslandContext;
}
function Clicker({ label = 'Clicker', island }: Props) {
  const [count, setCount] = useState(0);
  return (
    <button
      type="button"
      onClick={() => {
        setCount(count + 1);
        island.emit('clicker.clicked', { count: count + 1 });
      }}
    >
      {label}: {count}
    </button>
  );
}
export default reactIsland(Clicker);
