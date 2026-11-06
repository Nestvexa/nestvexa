import { useEffect, useMemo, useState } from 'react';
import { reactIsland } from '@nestvexa/islands/react';
import { createActionHooks } from './generated/actions-client.react.js';
import type { DashboardIsland, DashboardServices } from './services.js';
import { track } from './track.js';

interface Props {
  readonly title: string;
  readonly values: readonly number[];
  readonly island: DashboardIsland;
}
export function RevenueChart({ title, values, island }: Props) {
  const [selected, setSelected] = useState<number | null>(null);
  const [report, setReport] = useState('No report yet');
  // Generated, typed React hook for dashboard.record-event.
  const hooks = useMemo(
    () => createActionHooks(island.services.actions),
    [island],
  );
  const record = hooks.useDashboardRecordEvent();
  useEffect(() => {
    track('revenue-chart', 'mount');
    return () => track('revenue-chart', 'unmount');
  }, []);
  const max = Math.max(1, ...values);
  async function exportReport() {
    setReport('Export queued');
    try {
      // Job action: 202 ticket, then polling with progress.
      const job = await island.services.actions.dashboard.exportReport({
        rows: values.length,
      });
      const file = await job.wait({
        intervalMs: 100,
        signal: island.signal,
        onProgress: (snapshot) => setReport(`Export ${snapshot.progress}%`),
      });
      setReport(`Report ready: ${file.url} (${file.rows} rows)`);
    } catch {
      if (!island.signal.aborted) setReport('Export failed');
    }
  }
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
            style={{ fill: 'var(--nv-accent, #333)' }}
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
              void record.run({
                kind: 'chart.selected',
                label: `Quarter ${index + 1}`,
              });
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
      <p id="chart-events">
        {record.pending
          ? 'Saving…'
          : record.data
            ? `${record.data.total} events recorded`
            : 'No events recorded'}
      </p>
      <button type="button" onClick={() => void exportReport()}>
        Export report
      </button>
      <p id="report-status" role="status">
        {report}
      </p>
    </figure>
  );
}
export default reactIsland<Omit<Props, 'island'>, DashboardServices>(
  RevenueChart,
);
