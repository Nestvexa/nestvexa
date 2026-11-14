import { useEffect, useState } from 'react';
import type { IslandContext } from '@nestvexa/islands/client';
import { reactIsland } from '@nestvexa/islands/react';
import { Chart } from '@nestvexa/ui/react';

export interface MemberRow {
  readonly name: string;
  readonly focusLabel: string;
  readonly open: number;
  readonly done: number;
}
interface Props {
  readonly locale: string;
  readonly title: string;
  readonly category: string;
  readonly openLabel: string;
  readonly doneLabel: string;
  readonly typeLabel: string;
  readonly barsLabel: string;
  readonly linesLabel: string;
  readonly members: readonly MemberRow[];
  readonly island: IslandContext;
}

/**
 * Dashboard island (React): open and done tasks per member, drawn by the
 * @nestvexa/ui chart wrapper (SVG geometry with classes, no `style`
 * attribute, plus a data table), so it renders on the server and passes the
 * strict CSP. The chart type is local React state; "Focus on …" tells the
 * Svelte pulse widget through the islands event bridge. Live re-renders of
 * the page never reach this subtree.
 */
export function MemberChart(props: Props) {
  const [type, setType] = useState<'bar' | 'line'>('bar');
  const [focused, setFocused] = useState('');
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const pick = (value: 'bar' | 'line', label: string) => (
    <button
      type="button"
      id={`member-chart-${value}`}
      aria-pressed={type === value}
      onClick={() => setType(value)}
    >
      {label}
    </button>
  );
  return (
    <div className="island-chart" data-hydrated={hydrated ? 'true' : 'false'}>
      <p role="group" aria-label={props.typeLabel}>
        {pick('bar', props.barsLabel)} {pick('line', props.linesLabel)}
      </p>
      <Chart
        id="member-chart"
        type={type}
        title={props.title}
        categoryLabel={props.category}
        labels={props.members.map((member) => member.name)}
        series={[
          {
            name: props.openLabel,
            values: props.members.map((member) => member.open),
          },
          {
            name: props.doneLabel,
            values: props.members.map((member) => member.done),
          },
        ]}
        locale={props.locale}
      />
      <ul className="focus-list">
        {props.members.map((member) => (
          <li key={member.name}>
            <button
              type="button"
              aria-pressed={focused === member.name}
              onClick={() => {
                setFocused(member.name);
                props.island.emit('member.focus', {
                  name: member.name,
                  open: member.open,
                });
              }}
            >
              {member.focusLabel}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default reactIsland<Omit<Props, 'island'>>(MemberChart);
