/**
 * "Get directions to the health centre" — a Google Maps deep link.
 *
 * ### Why a link rather than an embedded map
 *
 * This is the piece of map functionality that actually matters to the problem statement:
 * the platform is about rural health *access*, and a referral is worthless if the patient
 * cannot find the PHC. A deep link solves that better than an embedded map would:
 *
 *   - **No API key and no billing account.** Google requires a payment method even for the
 *     free Maps tier; a plain `maps/dir/?api=1` link requires neither.
 *   - **Hands off to an app that already has offline maps.** The user's Google Maps app has
 *     their region cached and does turn-by-turn navigation. Nothing we could embed would
 *     come close.
 *   - **Keeps the bundle small.** Maps JS is 200 KB+ before a single tile loads, on a
 *     bundle that has to be cached for offline use on a low-end Android.
 *
 * Rendered as an `<a>`, not a button, so long-press/"open in new tab" behave normally and
 * assistive tech announces it as a link.
 */

import { directionsUrl } from '@/components/PhcMap';

export interface DirectionsButtonProps {
  lat: number | null | undefined;
  lng: number | null | undefined;
  /** Health centre name, shown in the label. */
  placeName?: string;
  label: string;
  hint?: string;
  variant?: 'primary' | 'secondary' | 'ghost';
}

export function DirectionsButton({
  lat,
  lng,
  placeName,
  label,
  hint,
  variant = 'secondary',
}: DirectionsButtonProps) {
  // No coordinates recorded for this PHC: render nothing rather than a dead button.
  if (typeof lat !== 'number' || typeof lng !== 'number') return null;

  const className =
    variant === 'primary'
      ? 'button button--block'
      : variant === 'ghost'
        ? 'button button--ghost button--block'
        : 'button button--secondary button--block';

  return (
    <div className="stack stack--tight">
      <a
        className={className}
        href={directionsUrl(lat, lng)}
        target="_blank"
        rel="noopener noreferrer"
      >
        <span aria-hidden="true">{'\u27A4'}</span>
        {placeName ? `${label}: ${placeName}` : label}
      </a>
      {hint ? <p className="faint">{hint}</p> : null}
    </div>
  );
}
