/**
 * Charts, hand-rolled in CSS.
 *
 * No charting library. Recharts or Chart.js would each add well over 100 KB gzipped to a
 * bundle that has to be downloadable over a rural 2G connection and cached for offline
 * use. These three primitives cover every visualisation the district view needs, cost
 * nothing, and render correctly at 320px wide.
 *
 * All of them are also readable as text by a screen reader, which a canvas-based chart
 * library is not without extra work.
 */

import type { RiskBand } from '@shared/risk/index.js';

export interface BarDatum {
  label: string;
  value: number;
  /** Displayed at the end of the row; defaults to the raw value. */
  display?: string;
  band?: RiskBand;
}

/** Horizontal bars, scaled to the largest value in the set. */
export function BarChart({ data, max }: { data: BarDatum[]; max?: number }) {
  const ceiling = max ?? Math.max(1, ...data.map((datum) => datum.value));

  return (
    <div className="bar-chart">
      {data.map((datum) => {
        const percent = Math.min(100, (datum.value / ceiling) * 100);
        return (
          <div className="bar-row" key={datum.label}>
            <span>{datum.label}</span>
            <div
              className="bar-track"
              role="meter"
              aria-valuenow={datum.value}
              aria-valuemin={0}
              aria-valuemax={ceiling}
              aria-label={datum.label}
            >
              <div
                className={`bar-fill${datum.band ? ` bar-fill--${datum.band}` : ''}`}
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="bar-value">{datum.display ?? datum.value}</span>
          </div>
        );
      })}
    </div>
  );
}

export interface StackedDay {
  date: string;
  LOW: number;
  MODERATE: number;
  HIGH: number;
  total: number;
}

/**
 * Daily volume as stacked columns.
 *
 * A table follows it in the DOM (visually hidden) so the same data is available
 * non-visually — the chart itself is decorative for assistive tech.
 */
export function StackedSparkline({ days, caption }: { days: StackedDay[]; caption: string }) {
  const ceiling = Math.max(1, ...days.map((day) => day.total));

  return (
    <div>
      <div className="sparkline" aria-hidden="true">
        {days.map((day) => (
          <div className="sparkline__col" key={day.date} title={`${day.date}: ${day.total}`}>
            {(['HIGH', 'MODERATE', 'LOW'] as const).map((band) =>
              day[band] > 0 ? (
                <div
                  key={band}
                  className={`sparkline__seg sparkline__seg--${band}`}
                  style={{ height: `${(day[band] / ceiling) * 100}%` }}
                />
              ) : null,
            )}
          </div>
        ))}
      </div>

      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">High</th>
            <th scope="col">Moderate</th>
            <th scope="col">Low</th>
          </tr>
        </thead>
        <tbody>
          {days.map((day) => (
            <tr key={day.date}>
              <th scope="row">{day.date}</th>
              <td>{day.HIGH}</td>
              <td>{day.MODERATE}</td>
              <td>{day.LOW}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function BandLegend({ labels }: { labels: Record<RiskBand, string> }) {
  return (
    <div className="legend">
      {(['HIGH', 'MODERATE', 'LOW'] as const).map((band) => (
        <span className="legend__item" key={band}>
          <span
            className="legend__swatch"
            style={{ background: `var(--colour-risk-${band.toLowerCase()})` }}
            aria-hidden="true"
          />
          {labels[band]}
        </span>
      ))}
    </div>
  );
}
