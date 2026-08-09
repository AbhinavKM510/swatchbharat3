/**
 * Model card — the honesty page.
 *
 * This screen exists because the app tells people they may be at high risk of a chronic
 * disease. Anyone on the receiving end of that claim, or evaluating it, should be able to
 * see what it rests on without reading the source code: the dataset, its known bias, the
 * held-out metrics, and the fact that this is a prototype.
 *
 * It renders from the **bundled** model metadata first, so it works offline, and enriches
 * from `GET /api/model` when a connection exists. The limitations are therefore always
 * visible — they are never the part that fails to load.
 */

import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { BarChart } from '@/components/charts';
import { Card, Notice } from '@/components/ui';
import { useI18n } from '@/i18n';
import { MODEL_META, NEURAL_META } from '@shared/risk/index.js';
import { api } from '@/lib/api';
import { formatPercent } from '@/lib/format';
import type { ModelCard as ModelCardData } from '@/types';

/**
 * Fallback limitations, in English, taken from the training metadata bundled with the app.
 *
 * These are intentionally not translated. They are a precise technical provenance
 * statement, and a loose translation of "the cohort is Pima Native American women, so the
 * cut-offs are not calibrated for India" risks softening it. The plain-language warning that
 * a health worker actually needs ("this is a prototype, a lab test is required") IS
 * translated and appears on the result screen.
 */
const BUNDLED_LIMITATIONS = [
  MODEL_META.dataset.knownLimitation,
  'The dataset Glucose column is a 2-hour oral glucose tolerance value, not a fasting reading.',
  'Skin thickness and insulin are usually unmeasured in the field and default to the training-split median.',
  'This is a screening aid. It does not diagnose. A confirmatory laboratory test is always required.',
];

export function ModelCardPage() {
  const { t, tDynamic } = useI18n();
  const [remote, setRemote] = useState<ModelCardData | null>(null);

  useEffect(() => {
    // Best effort. Everything important is already bundled.
    void api
      .modelCard()
      .then(setRemote)
      .catch(() => undefined);
  }, []);

  const metrics = remote?.metrics.test ?? MODEL_META.metrics.test;
  const limitations = remote?.limitations ?? BUNDLED_LIMITATIONS;
  const importances = remote?.featureImportances ?? MODEL_META.featureImportances;

  const toImportanceData = (source: Record<string, number>) =>
    Object.entries(source)
      .sort((a, b) => b[1] - a[1])
      .filter(([, value]) => value > 0)
      .map(([feature, value]) => ({
        label: tDynamic(`feature.${feature}`, undefined, feature),
        value: Math.round(value * 100),
        display: formatPercent(value),
      }));

  const importanceData = toImportanceData(importances);

  /**
   * The neural second opinion, bundled-first exactly like everything else on this page, so
   * the section still renders with the network off.
   */
  const neural = remote?.secondOpinion ?? {
    role: NEURAL_META.role,
    authoritativeForRiskBand: NEURAL_META.authoritativeForRiskBand,
    algorithm: NEURAL_META.algorithm,
    framework: `${NEURAL_META.framework} ${NEURAL_META.frameworkVersion}`,
    parameterCount: NEURAL_META.parameterCount,
    hyperparameters: NEURAL_META.hyperparameters,
    trainedAt: NEURAL_META.generatedAt,
    featureImportances: NEURAL_META.featureImportances,
    metrics: NEURAL_META.metrics,
    heldOutBandSummary: NEURAL_META.heldOutBandSummary,
    attributionMethod: NEURAL_META.attributionMethod,
    attributionBaseline: Object.fromEntries(
      NEURAL_META.featureOrder.map((name, i) => [name, NEURAL_META.attributionBaseline[i]]),
    ),
    metricsMeasuredBy: 'the exported JavaScript forward pass, not the training framework',
    crossCheck: NEURAL_META.crossCheck,
    limitations: [],
  };

  const neuralMetrics = neural.metrics.test;
  const neuralImportanceData = toImportanceData(neural.featureImportances);

  return (
    <AppShell title={t('modelCard.title')}>
      <div className="stack">
        <Notice tone="warning" title={t('app.prototypeBadge')}>
          {t('modelCard.notDiagnosis')}
        </Notice>

        <Card>
          <p>{t('modelCard.intro')}</p>
        </Card>

        <Card title={t('modelCard.algorithmTitle')}>
          <div className="stack stack--tight">
            <p>{t('modelCard.algorithmBody')}</p>
            <dl className="definition-list">
              <dt>{t('modelCard.algorithmTitle')}</dt>
              <dd>{remote?.algorithm ?? MODEL_META.algorithm}</dd>
              <dt>max_depth</dt>
              <dd>{String(MODEL_META.hyperparameters.maxDepth ?? '\u2014')}</dd>
              <dt>min_samples_leaf</dt>
              <dd>{String(MODEL_META.hyperparameters.minSamplesLeaf ?? '\u2014')}</dd>
              <dt>class_weight</dt>
              <dd>{String(MODEL_META.hyperparameters.classWeight ?? '\u2014')}</dd>
            </dl>
          </div>
        </Card>

        <Card title={t('modelCard.datasetTitle')}>
          <dl className="definition-list">
            <dt>{t('modelCard.datasetTitle')}</dt>
            <dd>{remote?.dataset.name ?? MODEL_META.dataset.name}</dd>
            <dt>{t('trends.totalScreenings')}</dt>
            <dd>{remote?.dataset.records ?? MODEL_META.dataset.records}</dd>
          </dl>
        </Card>

        <Card title={t('modelCard.metricsTitle')} hint={t('modelCard.metricsHint')}>
          <div className="stack stack--tight">
            <dl className="definition-list">
              <dt>{t('modelCard.metricAccuracy')}</dt>
              <dd>{formatPercent(metrics.accuracy, 1)}</dd>
              <dt>{t('modelCard.metricRecall')}</dt>
              <dd>{formatPercent(metrics.recall, 1)}</dd>
              <dt>{t('modelCard.metricPrecision')}</dt>
              <dd>{formatPercent(metrics.precision, 1)}</dd>
              <dt>{t('modelCard.metricRocAuc')}</dt>
              <dd>{metrics.rocAuc.toFixed(3)}</dd>
            </dl>

            {/* The trade-off, stated rather than buried: recall is higher than precision on
                purpose, because a missed diabetic is worse than a false alarm. */}
            <Notice tone="info">{t('modelCard.recallNote')}</Notice>
          </div>
        </Card>

        {importanceData.length > 0 ? (
          <Card title={t('modelCard.featureImportanceTitle')}>
            <BarChart data={importanceData} max={100} />
          </Card>
        ) : null}

        {/*
          The second model. Disclosed here rather than left implicit, because the app does
          compute a neural score for every patient and a transparency page that omitted it
          would be incomplete.

          The first line states what it is NOT: it does not decide the band. That ordering
          is deliberate — it is the fact most likely to be misread.
        */}
        <Card title={t('modelCard.secondOpinionTitle')} hint={t('modelCard.secondOpinionHint')}>
          <div className="stack stack--tight">
            <Notice tone="info">{t('modelCard.secondOpinionNotPrimary')}</Notice>

            <p>{t('modelCard.secondOpinionBody')}</p>

            <dl className="definition-list">
              <dt>{t('modelCard.algorithmTitle')}</dt>
              <dd>{neural.algorithm}</dd>
              <dt>{t('modelCard.secondOpinionFramework')}</dt>
              <dd>{neural.framework}</dd>
              <dt>{t('modelCard.secondOpinionParameters')}</dt>
              <dd>{neural.parameterCount}</dd>
              <dt>{t('modelCard.metricAccuracy')}</dt>
              <dd>{formatPercent(neuralMetrics.accuracy, 1)}</dd>
              <dt>{t('modelCard.metricRecall')}</dt>
              <dd>{formatPercent(neuralMetrics.recall, 1)}</dd>
              <dt>{t('modelCard.metricRocAuc')}</dt>
              <dd>{neuralMetrics.rocAuc.toFixed(3)}</dd>
            </dl>

            {/* Where the numbers came from. The shipped JS, not the training framework. */}
            <p className="faint">{t('modelCard.secondOpinionMeasuredBy')}</p>

            <Notice tone="info">{t('modelCard.secondOpinionTradeoff')}</Notice>
          </div>
        </Card>

        {neuralImportanceData.length > 0 ? (
          <Card
            title={t('modelCard.neuralImportanceTitle')}
            hint={t('modelCard.neuralImportanceHint')}
          >
            <div className="stack stack--tight">
              <BarChart data={neuralImportanceData} max={100} />
              <p className="faint">{t('modelCard.neuralImportanceNote')}</p>
            </div>
          </Card>
        ) : null}

        <Card title={t('modelCard.limitationsTitle')}>
          <ul className="stack stack--tight" style={{ paddingLeft: '1.1rem' }}>
            {limitations.map((limitation) => (
              <li key={limitation}>{limitation}</li>
            ))}
          </ul>
        </Card>

        {remote?.explanationReferences ? (
          <Card title={t('modelCard.referencesTitle')}>
            <ul className="stack stack--tight" style={{ paddingLeft: '1.1rem' }}>
              {Object.entries(remote.explanationReferences).map(([key, value]) => (
                <li key={key}>
                  <strong>{tDynamic(`feature.${key}`, undefined, key)}:</strong> {value}
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <Link className="button button--ghost button--block" to="/">
          {t('errors.goHome')}
        </Link>
      </div>
    </AppShell>
  );
}
