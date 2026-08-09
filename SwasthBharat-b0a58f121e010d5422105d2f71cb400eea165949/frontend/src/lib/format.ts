/**
 * Formatting helpers.
 *
 * Measured values keep Latin digits deliberately (see the note in src/i18n/index.tsx): a
 * worker is transcribing from a glucometer that shows "165", so showing "১৬৫" beside it
 * invites errors. Dates and relative times DO use the locale, because they are prose.
 */

import type { Language } from '@/i18n';

const LOCALE_TAGS: Record<Language, string> = {
  bn: 'bn-IN',
  hi: 'hi-IN',
  en: 'en-IN',
};

export function localeTag(language: Language): string {
  return LOCALE_TAGS[language] ?? 'en-IN';
}

/** "12 Aug 2026" in the user's language. */
export function formatDate(iso: string | null | undefined, language: Language): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(localeTag(language), {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  }).format(date);
}

export function formatDateTime(iso: string | null | undefined, language: Language): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(localeTag(language), {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/**
 * "2 hours ago" in the user's language, via Intl.RelativeTimeFormat.
 *
 * Relative time matters more than absolute time on the doctor's queue: "screened 3 days
 * ago and still not contacted" is the signal a doctor acts on.
 */
export function formatRelativeTime(iso: string | null | undefined, language: Language): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';

  const formatter = new Intl.RelativeTimeFormat(localeTag(language), { numeric: 'auto' });
  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const absolute = Math.abs(seconds);

  if (absolute < 60) return formatter.format(Math.round(seconds), 'second');
  if (absolute < 3600) return formatter.format(Math.round(seconds / 60), 'minute');
  if (absolute < 86400) return formatter.format(Math.round(seconds / 3600), 'hour');
  if (absolute < 2592000) return formatter.format(Math.round(seconds / 86400), 'day');
  return formatDate(iso, language);
}

/** 0.6061 -> "61%" */
export function formatPercent(value: number | null | undefined, fractionDigits = 0): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(fractionDigits)}%`;
}

/** Seconds -> "7:02", for the simulated call timer. */
export function formatDuration(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Renders a decision-tree comparison operator as something readable. */
export function operatorSymbol(operator: string): string {
  if (operator === '<=') return '\u2264';
  if (operator === '>=') return '\u2265';
  return operator;
}

/** Trims a number for display without showing "31.0". */
export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10);
}
