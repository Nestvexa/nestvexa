import { useEffect, useState } from 'react';
import type { IslandContext } from '@nestvexa/islands/client';
import { reactIsland } from '@nestvexa/islands/react';
import { track } from './track.js';

interface Props {
  readonly title: string;
  readonly values: readonly number[];
  readonly island: IslandContext;
}
function RevenueChart({ title, values, island }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  useEffect(() => {
    track('revenue-chart', 'mount');
    return () => track('revenue-chart', 'unmount');
  }, []);
  const max = Math.max(1, ...values);
  return (
    <figure>
      <figcaption id="chart-title">{title}</figcaption>
      <svg width="200" height="80" role="img" aria-labelledby="chart-title">
        {values.map((value, index) => (
          <rect
            key={index}
            x={index * 40 + 5}
            y={80 - (value / max) * 75}
            width="30"
            height={(value / max) * 75}
          />
        ))}
      </svg>
      <div>
        {values.map((value, index) => (
          <button
            key={index}
            type="button"
            aria-pressed={selected === index}
            onClick={() => {
              setSelected(index);
              island.emit('chart.selected', { index, value });
            }}
          >
            Quarter {index + 1}
          </button>
        ))}
      </div>
      <p id="chart-selected">
        {selected === null
          ? 'No quarter selected'
          : `Selected quarter ${selected + 1}`}
      </p>
    </figure>
  );
}
export default reactIsland(RevenueChart);
