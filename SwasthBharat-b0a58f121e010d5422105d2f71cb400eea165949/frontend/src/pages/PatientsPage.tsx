/**
 * Patient list and history.
 *
 * Server-backed, because the point is to find a patient someone screened weeks ago —
 * possibly a different worker at the same PHC. The API scopes the results: an ASHA worker
 * sees only her own patients, a doctor sees the whole PHC.
 *
 * The history view matters clinically: a single glucose reading is a snapshot, and two
 * readings three months apart are a trend. That is the difference between "she has high
 * sugar" and "her sugar is rising despite advice".
 */

import { useCallback, useEffect, useState } from 'react';
import { AppShell } from '@/components/AppShell';
import { ReasonList, RiskChip } from '@/components/risk';
import { Card, Collapsible, EmptyState, Spinner, Tag } from '@/components/ui';
import { useI18n } from '@/i18n';
import { api } from '@/lib/api';
import { formatNumber, formatRelativeTime } from '@/lib/format';
import { useToast } from '@/state/ToastContext';
import type { Assessment, Patient } from '@/types';

export function PatientsPage() {
  const { t, language } = useI18n();
  const { show } = useToast();

  const [search, setSearch] = useState('');
  const [patients, setPatients] = useState<Patient[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<{ patient: Patient; assessments: Assessment[] } | null>(null);

  const load = useCallback(
    async (term: string) => {
      setLoading(true);
      try {
        const result = await api.patients.list({ search: term || undefined, limit: 50 });
        setPatients(result.items);
      } catch {
        show(t('errors.network'), 'error');
      } finally {
        setLoading(false);
      }
    },
    [show, t],
  );

  // Debounced so typing a name does not fire a request per keystroke on a slow link.
  useEffect(() => {
    const timer = window.setTimeout(() => void load(search), search ? 350 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search]);

  const openPatient = async (patient: Patient) => {
    try {
      setSelected({ patient, assessments: [] });
      const detail = await api.patients.get(patient.id);
      setSelected(detail);
    } catch {
      show(t('errors.network'), 'error');
      setSelected(null);
    }
  };

  if (selected) {
    return (
      <AppShell
        title={selected.patient.name}
        subtitle={`${selected.patient.age} ${t('common.years')}${
          selected.patient.village ? ` \u00b7 ${selected.patient.village}` : ''
        }`}
        headerAction={
          <button type="button" className="button button--header" onClick={() => setSelected(null)}>
            {t('common.back')}
          </button>
        }
      >
        <div className="stack">
          <Card title={t('patients.historyTitle')}>
            {selected.assessments.length === 0 ? (
              <div className="centre-screen" style={{ minHeight: 120 }}>
                <Spinner label={t('common.loading')} />
              </div>
            ) : (
              <div className="stack stack--tight">
                {selected.assessments.map((assessment) => (
                  <article
                    key={assessment.id}
                    className={`patient-card patient-card--${assessment.riskBand}`}
                    style={{ cursor: 'default' }}
                  >
                    <div className="row row--between row--wrap">
                      <span style={{ fontWeight: 600 }}>
                        {formatRelativeTime(assessment.capturedAt, language)}
                      </span>
                      <RiskChip band={assessment.riskBand} percent={assessment.riskPercent} />
                    </div>

                    <dl className="definition-list">
                      <dt>{t('field.glucoseMgDl')}</dt>
                      <dd>
                        {formatNumber(assessment.input.glucoseMgDl)} {t('form.glucoseUnit')}
                      </dd>
                      <dt>{t('feature.bmi')}</dt>
                      <dd>{formatNumber(assessment.derived?.bmi)}</dd>
                      <dt>{t('field.diastolicBpMmHg')}</dt>
                      <dd>
                        {formatNumber(assessment.input.diastolicBpMmHg)} {t('form.diastolicBpUnit')}
                      </dd>
                    </dl>

                    <div className="tag-row">
                      <Tag>{t(`dashboard.status.${assessment.reviewStatus}`)}</Tag>
                      {assessment.source === 'offline-sync' ? (
                        <Tag tone="offline" icon={'\u2601'}>
                          {t('dashboard.syncedFromOffline')}
                        </Tag>
                      ) : null}
                    </div>

                    {assessment.reasons?.length ? (
                      <Collapsible summary={t('result.whyTitle')}>
                        <ReasonList reasons={assessment.reasons} />
                      </Collapsible>
                    ) : null}
                  </article>
                ))}
              </div>
            )}
          </Card>
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell title={t('patients.title')}>
      <div className="stack">
        <label className="field">
          <span className="sr-only">{t('common.search')}</span>
          <input
            className="input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={t('patients.searchPlaceholder')}
          />
        </label>

        {loading ? (
          <div className="centre-screen" style={{ minHeight: 160 }}>
            <Spinner label={t('common.loading')} />
          </div>
        ) : patients.length === 0 ? (
          <EmptyState icon={'\u2014'} title={t('patients.empty')} />
        ) : (
          <div className="stack stack--tight">
            {patients.map((patient) => (
              <button
                key={patient.id}
                type="button"
                className="patient-card"
                onClick={() => void openPatient(patient)}
              >
                <div className="row row--between row--wrap">
                  <span className="patient-card__name">{patient.name}</span>
                  <span className="text-sm muted">
                    {formatRelativeTime(patient.capturedAt, language)}
                  </span>
                </div>
                <div className="row row--wrap text-sm muted">
                  <span>
                    {patient.age} {t('common.years')}
                  </span>
                  <span>&middot; {patient.sex === 'female' ? t('common.female') : t('common.male')}</span>
                  {patient.village ? <span>&middot; {patient.village}</span> : null}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </AppShell>
  );
}
