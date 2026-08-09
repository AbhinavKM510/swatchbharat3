/**
 * District health officer view.
 *
 * An officer oversees many PHCs, so this screen answers comparison questions rather than
 * individual ones: which centre is flagging an unusual share of high-risk patients, which
 * risk factors dominate locally, is screening volume actually rising.
 *
 * Deliberately aggregate-only — no patient names appear here, because identifying
 * individuals is not part of the job. The API enforces that too; this is not just a UI
 * choice.
 *
 * It also reports adoption honestly, including how much data arrives from offline capture.
 * That number is the real measure of whether the offline-first design was necessary.
 */

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { BandLegend, BarChart, StackedSparkline } from '@/components/charts';
import { PhcMap, type PhcMapPoint } from '@/components/PhcMap';
import { Card, EmptyState, Spinner, StatCard } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { formatPercent } from '@/lib/format';
import { useAuth } from '@/state/AuthContext';
import { useToast } from '@/state/ToastContext';
import type { DistrictTrends, Phc } from '@/types';

const WINDOWS = [7, 30, 90] as const;

/** Maps a risk-reason code back to its translation key, for the "top factors" chart. */
const REASON_KEY_BY_CODE: Record<string, string> = {
  GLUCOSE_DIABETES_RANGE: 'reason.glucose.diabetesRange',
  GLUCOSE_PREDIABETES_RANGE: 'reason.glucose.prediabetesRange',
  BMI_OBESE: 'reason.bmi.obese',
  BMI_OVERWEIGHT: 'reason.bmi.overweight',
  BMI_UNDERWEIGHT: 'reason.bmi.underweight',
  FAMILY_HISTORY_PRESENT: 'reason.familyHistory.present',
  BP_HIGH: 'reason.bp.high',
  BP_ELEVATED: 'reason.bp.elevated',
  AGE_ELEVATED: 'reason.age.elevated',
  AGE_ADVISORY: 'reason.age.advisory',
  HIGH_PARITY: 'reason.pregnancies.high',
};

/** Placeholder markers that survive interpolation so they can be found and removed. */
const VALUE_SENTINEL = '\u0000VALUE\u0000';
const THRESHOLD_SENTINEL = '\u0000THRESHOLD\u0000';

/**
 * Reason strings are written as full sentences with interpolated values ("BMI 31 is in the
 * obese range"), which is right on a result page and wrong on a chart axis. Here the
 * placeholders are stripped so the label reads as a category.
 *
 * Blanking both placeholders is not always enough: a few reasons (age-related ones) put
 * `{threshold}` at the very end of the sentence — "risk rises after {threshold}" — and
 * blanking it leaves a dangling clause ("risk rises after") rather than a category. When
 * that happens the whole trailing clause is dropped instead, keeping only the part of the
 * sentence that still reads as a complete category on its own.
 *
 * Sentinels rather than empty strings, because searching for "where the value was" after
 * the fact is impossible once it has been blanked — and it has to work identically in
 * Bengali and Hindi, where the clause order differs from English.
 */
function factorLabel(code: string, translate: (key: string, params?: Record<string, string | number>) => string): string {
  const key = REASON_KEY_BY_CODE[code];
  if (!key) return code;

  let text = translate(key, { value: VALUE_SENTINEL, threshold: THRESHOLD_SENTINEL });

  // Some reasons put the whole "why" clause after an em-dash with {threshold} as its only
  // variable — "Age 55 — risk rises after 45". If the segment after the last em-dash has the
  // threshold but not the value, that clause is explanation rather than category, so drop it.
  const lastDash = text.lastIndexOf('\u2014');
  if (lastDash !== -1) {
    const afterDash = text.slice(lastDash + 1);
    if (afterDash.includes(THRESHOLD_SENTINEL) && !afterDash.includes(VALUE_SENTINEL)) {
      text = text.slice(0, lastDash);
    }
  }

  return text
    .replaceAll(VALUE_SENTINEL, '')
    .replaceAll(THRESHOLD_SENTINEL, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.])/g, '$1')
    .replace(/[\u2014,]\s*$/, '')
    .trim();
}

export function DistrictTrendsPage() {
  const { t, tDynamic } = useI18n();
  const { user } = useAuth();
  const { show } = useToast();

  const [days, setDays] = useState<(typeof WINDOWS)[number]>(30);
  const [data, setData] = useState<DistrictTrends | null>(null);
  const [phcs, setPhcs] = useState<Phc[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // Coordinates live on the PHC directory, not the trends aggregation, so the two are
      // fetched together and joined below. Directory failure must not blank the whole
      // screen — the map is an enhancement, the numbers are the point.
      const [trends, directory] = await Promise.all([
        api.district.trends(days),
        api.district.phcs().catch(() => ({ items: [] as Phc[] })),
      ]);
      setData(trends);
      setPhcs(directory.items);
    } catch {
      show(t('errors.network'), 'error');
    } finally {
      setLoading(false);
    }
  }, [days, show, t]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return (
      <AppShell title={t('trends.title')} wide>
        <div className="centre-screen">
          <Spinner label={t('common.loading')} />
        </div>
      </AppShell>
    );
  }

  if (!data) {
    return (
      <AppShell title={t('trends.title')} wide>
        <EmptyState icon={'\u2014'} title={t('errors.network')} />
      </AppShell>
    );
  }

  const totalInWindow = data.dailySeries.reduce((sum, day) => sum + day.total, 0);
  const highInWindow = data.dailySeries.reduce((sum, day) => sum + day.HIGH, 0);

  // Join the trends aggregation onto the PHC directory to get coordinates.
  const mapPoints: PhcMapPoint[] = data.perPhc.map((row) => {
    const directory = phcs.find((phc) => phc.id === row.phcId);
    return {
      phcId: row.phcId,
      code: row.code,
      name: row.name,
      lat: directory?.location?.lat ?? null,
      lng: directory?.location?.lng ?? null,
      total: row.total,
      highRiskRate: row.highRiskRate,
      openHighRisk: row.openHighRisk,
    };
  });

  return (
    <AppShell
      title={t('trends.title')}
      subtitle={t('trends.subtitle', { district: user?.district ?? data.district })}
      wide
    >
      <div className="stack">
        <div className="choice-group">
          {WINDOWS.map((option) => (
            <button
              key={option}
              type="button"
              className="choice"
              aria-pressed={days === option}
              onClick={() => setDays(option)}
            >
              {t('trends.window', { days: option })}
            </button>
          ))}
        </div>

        <div className="stat-grid">
          <StatCard value={totalInWindow} label={t('trends.totalScreenings')} />
          <StatCard
            value={formatPercent(totalInWindow > 0 ? highInWindow / totalInWindow : 0)}
            label={t('trends.highRiskShare')}
            alert={totalInWindow > 0 && highInWindow / totalInWindow > 0.3}
          />
          <StatCard value={data.perPhc.length} label={t('trends.perPhcTitle')} />
          <StatCard
            value={data.perPhc.reduce((sum, phc) => sum + phc.openHighRisk, 0)}
            label={t('trends.tableOpen')}
          />
        </div>

        {totalInWindow === 0 ? (
          <Card>
            <EmptyState icon={'\u2014'} title={t('trends.empty')} />
          </Card>
        ) : (
          <>
            <Card title={t('trends.dailyTitle')}>
              <StackedSparkline days={data.dailySeries} caption={t('trends.dailyTitle')} />
              <BandLegend
                labels={{
                  HIGH: t('result.band.HIGH'),
                  MODERATE: t('result.band.MODERATE'),
                  LOW: t('result.band.LOW'),
                }}
              />
            </Card>

            {/*
              Geography, rendered from stored coordinates rather than a tile service — so it
              still works offline. See the note at the top of components/PhcMap.tsx.
            */}
            <Card title={t('trends.mapTitle')}>
              <PhcMap
                points={mapPoints}
                caption={t('trends.mapHint')}
                labels={{
                  screenings: t('trends.tableScreenings'),
                  highRisk: t('trends.tableHighRisk'),
                  openCases: t('trends.tableOpen'),
                  noCoordinates: t('trends.mapNoCoordinates'),
                }}
              />
              <div style={{ marginTop: 'var(--space-3)' }}>
                <BandLegend
                  labels={{
                    HIGH: t('result.band.HIGH'),
                    MODERATE: t('result.band.MODERATE'),
                    LOW: t('result.band.LOW'),
                  }}
                />
              </div>
            </Card>

            <Card title={t('trends.perPhcTitle')}>
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th scope="col">{t('trends.tablePhc')}</th>
                      <th scope="col" className="numeric">
                        {t('trends.tableScreenings')}
                      </th>
                      <th scope="col" className="numeric">
                        {t('trends.tableHighRisk')}
                      </th>
                      <th scope="col" className="numeric">
                        {t('trends.tableRate')}
                      </th>
                      <th scope="col" className="numeric">
                        {t('trends.tableOpen')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.perPhc.map((phc) => (
                      <tr key={phc.phcId}>
                        <td>
                          <strong>{phc.name}</strong>
                          <div className="text-xs muted">{phc.code}</div>
                        </td>
                        <td className="numeric">{phc.total}</td>
                        <td className="numeric">{phc.high}</td>
                        <td className="numeric">{formatPercent(phc.highRiskRate)}</td>
                        <td className="numeric">{phc.openHighRisk}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>

            {data.topRiskFactors.length > 0 ? (
              <Card title={t('trends.topFactorsTitle')}>
                <BarChart
                  data={data.topRiskFactors.map((factor) => ({
                    label: factorLabel(factor.code, tDynamic),
                    value: factor.count,
                  }))}
                />
              </Card>
            ) : null}

            <Card title={t('trends.ageBandsTitle')}>
              <BarChart
                data={data.byAgeBand.map((entry) => ({
                  label: tDynamic(`trends.ageBand.${entry.band}`, undefined, entry.band),
                  value: Math.round(entry.highRiskRate * 100),
                  display: `${formatPercent(entry.highRiskRate)} (${entry.high}/${entry.total})`,
                  band: 'HIGH' as const,
                }))}
                max={100}
              />
            </Card>

            {/*
              Adoption, including the offline share. If most records arrive from offline
              capture, that is the evidence that building offline-first was the right call
              rather than a nice-to-have.
            */}
            <Card title={t('trends.adoptionTitle')}>
              <BarChart
                max={100}
                data={[
                  {
                    label: t('trends.voiceShare'),
                    value: Math.round(data.adoption.voiceEntryShare * 100),
                    display: formatPercent(data.adoption.voiceEntryShare),
                  },
                  {
                    label: t('trends.offlineShare'),
                    value: Math.round(data.adoption.offlineCaptureShare * 100),
                    display: formatPercent(data.adoption.offlineCaptureShare),
                  },
                  {
                    label: 'বাংলা',
                    value: Math.round(data.adoption.languageShare.bn * 100),
                    display: formatPercent(data.adoption.languageShare.bn),
                  },
                  {
                    label: 'हिन्दी',
                    value: Math.round(data.adoption.languageShare.hi * 100),
                    display: formatPercent(data.adoption.languageShare.hi),
                  },
                ]}
              />
            </Card>
          </>
        )}
      </div>
    </AppShell>
  );
}
