/**
 * Geographic view of the PHCs in a district.
 *
 * ### Why this is hand-drawn SVG and not Google Maps
 *
 * Two hard reasons, both specific to this project:
 *
 * 1. **Offline.** The whole product claim is that it keeps working with no signal. The
 *    Google Maps JS API is a remote script and its terms prohibit caching map tiles, so a
 *    tile-based map would be the one screen that goes blank offline — in an app whose
 *    headline feature is that it does not. This renders from coordinates already stored in
 *    MongoDB, so it works with the network off like everything else.
 *
 * 2. **No API key, no billing account.** Google requires a payment method on file even for
 *    the free Maps tier. Nothing else in this codebase needs a key or an account, and that
 *    is worth preserving.
 *
 * Navigation, which is the part that genuinely needs a real map, is handled by
 * `directionsUrl()` below: a Google Maps deep link that opens the user's own installed
 * Maps app. That needs no key and gives turn-by-turn directions to the health centre.
 *
 * ### What it shows
 *
 * Position = actual latitude/longitude. Bubble area = screening volume. Bubble colour =
 * high-risk rate, so a centre flagging an unusual share of patients is visible spatially
 * rather than only as a table row.
 */

import { useMemo } from 'react';

export interface PhcMapPoint {
  phcId: string;
  code: string;
  name: string;
  lat: number | null;
  lng: number | null;
  /** Screening volume in the selected window; drives bubble size. */
  total: number;
  /** 0..1 share of screenings flagged HIGH; drives bubble colour. */
  highRiskRate: number;
  openHighRisk: number;
}

/**
 * Google Maps directions deep link.
 *
 * Deliberately a link and not an embedded map: it needs no API key, costs nothing, and
 * hands off to the Maps app the user already has (which has their own offline map data
 * downloaded, far better than anything we could ship).
 */
export function directionsUrl(lat: number, lng: number): string {
  const query = new URLSearchParams({ api: '1', destination: `${lat},${lng}` });
  return `https://www.google.com/maps/dir/?${query}`;
}

const VIEWBOX = { width: 100, height: 100 };
const PADDING = 14;

/** Bubble radius from volume, on a square-root scale so area (not radius) tracks count. */
function radiusFor(total: number, maxTotal: number): number {
  const minR = 2.6;
  const maxR = 8;
  if (maxTotal <= 0) return minR;
  return minR + (maxR - minR) * Math.sqrt(total / maxTotal);
}

function colourFor(highRiskRate: number): string {
  if (highRiskRate >= 0.4) return 'var(--colour-risk-high)';
  if (highRiskRate >= 0.2) return 'var(--colour-risk-moderate)';
  return 'var(--colour-risk-low)';
}

export interface PhcMapProps {
  points: PhcMapPoint[];
  /** Rendered under the map; pass a translated string. */
  caption: string;
  labels: {
    screenings: string;
    highRisk: string;
    openCases: string;
    noCoordinates: string;
  };
}

export function PhcMap({ points, caption, labels }: PhcMapProps) {
  const plotted = useMemo(
    () =>
      points.filter(
        (point): point is PhcMapPoint & { lat: number; lng: number } =>
          typeof point.lat === 'number' && typeof point.lng === 'number',
      ),
    [points],
  );

  const projected = useMemo(() => {
    if (plotted.length === 0) return [];

    const lats = plotted.map((p) => p.lat);
    const lngs = plotted.map((p) => p.lng);

    // Guard the single-point and perfectly-collinear cases, where the span is zero and a
    // naive normalisation divides by zero.
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const latSpan = maxLat - minLat || 0.02;
    const lngSpan = maxLng - minLng || 0.02;

    const usableWidth = VIEWBOX.width - PADDING * 2;
    const usableHeight = VIEWBOX.height - PADDING * 2;
    const maxTotal = Math.max(...plotted.map((p) => p.total), 0);

    return plotted.map((point) => ({
      ...point,
      // Equirectangular projection. Fine at district scale; the distortion over ~50 km is
      // far smaller than the bubbles themselves.
      x: PADDING + ((point.lng - minLng) / lngSpan) * usableWidth,
      // SVG y grows downward, latitude grows northward — so invert.
      y: PADDING + (1 - (point.lat - minLat) / latSpan) * usableHeight,
      r: radiusFor(point.total, maxTotal),
      fill: colourFor(point.highRiskRate),
    }));
  }, [plotted]);

  if (projected.length === 0) {
    return <p className="faint">{labels.noCoordinates}</p>;
  }

  return (
    <div>
      <svg
        viewBox={`0 0 ${VIEWBOX.width} ${VIEWBOX.height}`}
        role="img"
        aria-label={caption}
        style={{
          width: '100%',
          height: 'auto',
          maxHeight: 320,
          background: 'var(--colour-surface-sunken)',
          border: '1px solid var(--colour-border)',
          borderRadius: 'var(--radius)',
        }}
      >
        {/* Faint grid so the plot reads as a map rather than a floating scatter. */}
        <g stroke="var(--colour-border)" strokeWidth="0.2" opacity="0.6">
          {[25, 50, 75].map((v) => (
            <line key={`v${v}`} x1={v} y1="0" x2={v} y2={VIEWBOX.height} />
          ))}
          {[25, 50, 75].map((v) => (
            <line key={`h${v}`} x1="0" y1={v} x2={VIEWBOX.width} y2={v} />
          ))}
        </g>

        {projected.map((point) => (
          <g key={point.phcId}>
            <circle cx={point.x} cy={point.y} r={point.r} fill={point.fill} opacity="0.75" />
            <circle
              cx={point.x}
              cy={point.y}
              r={point.r}
              fill="none"
              stroke={point.fill}
              strokeWidth="0.5"
            />
            <text
              x={point.x}
              y={point.y + point.r + 4}
              textAnchor="middle"
              fontSize="3.4"
              fill="var(--colour-text)"
              fontWeight="600"
            >
              {point.code}
            </text>
          </g>
        ))}
      </svg>

      <p className="faint" style={{ marginTop: 'var(--space-2)' }}>
        {caption}
      </p>

      {/*
        The SVG is aria-label'd but a scatter plot is not readable non-visually. This table
        carries the same data for screen readers and is visually hidden.
      */}
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">PHC</th>
            <th scope="col">{labels.screenings}</th>
            <th scope="col">{labels.highRisk}</th>
            <th scope="col">{labels.openCases}</th>
          </tr>
        </thead>
        <tbody>
          {projected.map((point) => (
            <tr key={point.phcId}>
              <th scope="row">{point.name}</th>
              <td>{point.total}</td>
              <td>{Math.round(point.highRiskRate * 100)}%</td>
              <td>{point.openHighRisk}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
