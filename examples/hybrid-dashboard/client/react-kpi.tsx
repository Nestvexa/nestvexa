import { useEffect, useState } from 'react';
import { reactIsland } from '@nestvexa/islands/react';
import type { DashboardIsland, DashboardServices } from './services.js';
import { track } from './track.js';

interface Props {
  readonly label: string;
  readonly value: number;
  readonly island: DashboardIsland;
}
/** Server-rendered React island: hydrates without re-rendering its markup. */
export function Kpi({ label, value, island }: Props) {
  const [count, setCount] = useState(value);
  useEffect(() => {
    track('react-kpi', 'mount');
    return () => track('react-kpi', 'unmount');
  }, []);
  return (
    <div className="kpi">
      <p id="kpi-value">
        {label}: {count}
      </p>
      <p id="kpi-locale">Locale {island.shared.locale ?? 'unknown'}</p>
      <button type="button" onClick={() => setCount((current) => current + 1)}>
        Increment KPI
      </button>
    </div>
  );
}
export default reactIsland<Omit<Props, 'island'>, DashboardServices>(Kpi);
