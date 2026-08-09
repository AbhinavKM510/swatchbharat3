/**
 * The result screen — the payload of the whole product.
 *
 * The order of the page is the argument: **the word first, the reasons second, the number
 * third, the model's internals last and collapsed.** A percentage alone tells a health
 * worker nothing they can say to a patient. "High risk, because her blood sugar is 165 and
 * her BMI is 31 and her mother is diabetic" is something she can act on and repeat.
 *
 * It reads from IndexedDB, not from the API, so it renders identically with the wifi off.
 * Anything that genuinely needs a connection (booking a consultation) is clearly gated
 * rather than silently broken.
 */

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { DirectionsButton } from '@/components/DirectionsButton';
import {
  AttributionList,
  DecisionPath,
  ReasonList,
  RecommendationList,
  RiskBanner,
  SecondOpinionSummary,
} from '@/components/risk';
import { Card, Collapsible, EmptyState, Notice, Spinner, Tag } from '@/components/ui';
import { useI18n } from '@/i18n';
import { MODEL_META } from '@shared/risk/index.js';
import { getAssessment, type LocalAssessment } from '@/lib/db';
import { formatNumber } from '@/lib/format';
import { useAuth } from '@/state/AuthContext';
import { useSyncState } from '@/state/useSyncState';

export function RiskResultPage() {
  const { clientId = '' } = useParams();
  const { t, tDynamic } = useI18n();
  const { user } = useAuth();
  const sync = useSyncState();

  const [record, setRecord] = useState<LocalAssessment | null>(null);
  const [loading, setLoading] = useState(true);

  // Re-read when the sync state changes: once the record uploads it gains a serverId, which
  // is what the teleconsult booking needs.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const found = await getAssessment(clientId);
      if (!cancelled) {
        setRecord(found ?? null);
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Also re-reads after a post-login restore, so a link to a screening from an earlier
    // session resolves once that record has been pulled back into the local store.
  }, [clientId, sync.pending, sync.lastSyncedAt, sync.lastRestoredAt]);

  if (loading) {
    return (
      <AppShell title={t('result.title')}>
        <div className="centre-screen">
          <Spinner label={t('common.loading')} />
        </div>
      </AppShell>
    );
  }

  if (!record) {
    return (
      <AppShell title={t('result.title')}>
        <EmptyState
          icon={'\u2014'}
          title={t('errors.notFound')}
          action={
            <Link className="button" to="/">
              {t('errors.goHome')}
            </Link>
          }
        />
      </AppShell>
    );
  }

  const canBookConsult = sync.online && record.serverId !== null;

  return (
    <AppShell title={t('result.title')} subtitle={record.patientName}>
      <div className="stack">
        {/* 1. The word, large, with an icon and a colour. */}
        <RiskBanner band={record.riskBand} percent={record.riskPercent} />

        <div className="tag-row">
          <Tag>{`${record.patientName}, ${record.patientAge} ${t('common.years')}`}</Tag>
          {record.patientVillage ? <Tag>{record.patientVillage}</Tag> : null}
          {record.syncState !== 'synced' ? (
            <Tag tone="offline" icon={'\u2601'}>
              {t('connection.pendingOne')}
            </Tag>
          ) : null}
          {record.inputMethod !== 'typed' ? <Tag icon={'\u{1F3A4}'}>{t('form.usingVoice')}</Tag> : null}
        </div>

        {/* 2. Why. This is the part that makes the tool usable by a non-clinician. */}
        <Card title={t('result.whyTitle')}>
          <ReasonList reasons={record.reasons} />
        </Card>

        {/* 3. What to do. A risk score with no next step is just anxiety. */}
        <Card title={t('result.adviceTitle')}>
          <RecommendationList recommendations={record.recommendations} />
        </Card>

        <div className="stack stack--tight">
          {record.riskBand === 'HIGH' ? (
            canBookConsult ? (
              <Link className="button button--block" to={`/teleconsult/${record.clientId}`}>
                {t('result.bookConsult')}
              </Link>
            ) : (
              <>
                <button type="button" className="button button--block" disabled>
                  {t('result.bookConsult')}
                </button>
                <Notice tone="offline">{t('teleconsult.offlineBlocked')}</Notice>
              </>
            )
          ) : null}

          {/*
            Directions to the PHC. Shown for MODERATE and HIGH, because those are the bands
            whose advice actually tells the patient to travel there — a LOW result says
            "screen again in a year", so routing them today would be noise.

            A deep link, not an embedded map: no API key, and it hands off to the maps app
            the patient already has. See components/DirectionsButton.tsx.
          */}
          {record.riskBand !== 'LOW' ? (
            <DirectionsButton
              lat={user?.phc?.location?.lat}
              lng={user?.phc?.location?.lng}
              placeName={user?.phc?.name}
              label={t('result.getDirections')}
              hint={t('result.directionsHint')}
            />
          ) : null}

          <Link className="button button--secondary button--block" to="/help">
            {t('result.askChatbot')}
          </Link>
          <Link className="button button--ghost button--block" to="/screening">
            {t('result.newScreening')}
          </Link>
        </div>

        {/* 4. Honesty section. Deliberately not hidden behind a link nobody clicks. */}
        <Notice tone="warning" title={t('result.notADiagnosis')}>
          {t('result.prototypeNotice')}{' '}
          <Link to="/model">{t('result.readLimitations')}</Link>
        </Notice>

        <Card>
          <Collapsible summary={t('result.decisionTitle')}>
            <div className="stack" style={{ paddingTop: 'var(--space-2)' }}>
              <DecisionPath steps={record.decisionPath} />

              <p className="faint">
                {t('result.confidenceNote', { percent: record.riskPercent })}
              </p>

              {/*
                The neural second opinion and its attributions live HERE, inside the
                collapsed audit section, rather than next to the headline band.

                That is a deliberate call. The worker's job at the patient's door is to act
                on one band and one set of reasons; two percentages to reconcile would make
                that harder, not more transparent. A doctor, an officer or a judge asking
                "what else does it think, and which readings drove it?" opens this section
                and gets a complete answer.

                Both blocks are conditional. Records captured before engine 1.1.0 have
                neither field, and the engine returns a null second opinion rather than
                failing a screening if the neural artefact cannot be evaluated.
              */}
              {record.secondOpinion ? (
                <>
                  <hr className="divider" />
                  <h3 className="section-heading">{t('result.secondOpinionTitle')}</h3>
                  <SecondOpinionSummary
                    secondOpinion={record.secondOpinion}
                    primaryBand={record.riskBand}
                  />
                </>
              ) : null}

              {record.attributions && record.attributions.length > 0 ? (
                <>
                  <hr className="divider" />
                  <h3 className="section-heading">{t('result.attributionTitle')}</h3>
                  <AttributionList attributions={record.attributions} />
                </>
              ) : null}

              <hr className="divider" />

              <dl className="definition-list">
                <dt>{tDynamic('feature.bmi')}</dt>
                <dd>{formatNumber(record.derived.bmi)}</dd>

                <dt>{tDynamic('field.glucoseMgDl')}</dt>
                <dd>
                  {formatNumber(record.input.glucoseMgDl)} {t('form.glucoseUnit')}
                </dd>

                <dt>{tDynamic('field.diastolicBpMmHg')}</dt>
                <dd>
                  {formatNumber(record.input.diastolicBpMmHg)} {t('form.diastolicBpUnit')}
                </dd>

                <dt>{tDynamic('field.skinThicknessMm')}</dt>
                <dd>
                  {record.imputedFields.includes('skinThicknessMm')
                    ? t('common.notMeasured')
                    : formatNumber(record.input.skinThicknessMm)}
                </dd>

                <dt>{tDynamic('field.insulinMuUml')}</dt>
                <dd>
                  {record.imputedFields.includes('insulinMuUml')
                    ? t('common.notMeasured')
                    : formatNumber(record.input.insulinMuUml)}
                </dd>
              </dl>

              <p className="faint">
                {MODEL_META.dataset.name} &middot;{' '}
                {t('modelCard.metricAccuracy')} {Math.round(MODEL_META.metrics.test.accuracy * 100)}% &middot;{' '}
                {t('modelCard.metricRecall')} {Math.round(MODEL_META.metrics.test.recall * 100)}%
              </p>
            </div>
          </Collapsible>
        </Card>
      </div>
    </AppShell>
  );
}
