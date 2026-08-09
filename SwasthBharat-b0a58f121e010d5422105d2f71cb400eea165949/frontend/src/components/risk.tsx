/**
 * Risk presentation.
 *
 * This is where the project's central claim lives: the output is an explanation, not a
 * number. A health worker cannot act on "0.95". They can act on "blood sugar 165 is in the
 * diabetes range, BMI 31 is obese, a parent has diabetes — send her to the PHC this week".
 *
 * Accessibility notes that are functional here, not decorative:
 *
 * - Each band has a **distinct icon as well as a distinct colour**, because red/amber/green
 *   is invisible to a red-green colour-blind user and this is the one screen they cannot
 *   afford to misread.
 * - The percentage is shown as supporting detail, never as the headline. The headline is a
 *   word.
 */

import type {
  DecisionPathStep,
  FeatureAttribution,
  RiskBand,
  RiskReason,
  RiskRecommendation,
  SecondOpinion,
} from '@shared/risk/index.js';
import { useI18n } from '@/i18n';
import { formatNumber, operatorSymbol } from '@/lib/format';

/** Shape as well as colour, so the band survives greyscale and colour blindness. */
const BAND_ICON: Record<RiskBand, string> = {
  HIGH: '\u26a0', // warning triangle
  MODERATE: '\u25cf', // filled circle
  LOW: '\u2713', // check mark
};

const SEVERITY_ICON: Record<string, string> = {
  high: '\u26a0',
  moderate: '\u25cf',
  info: '\u2139',
  good: '\u2713',
  note: '\u2022',
};

export function RiskChip({ band, percent }: { band: RiskBand; percent?: number }) {
  const { t } = useI18n();
  return (
    <span className={`risk-chip risk-chip--${band}`}>
      <span aria-hidden="true">{BAND_ICON[band]}</span>
      {t(`result.band.${band}`)}
      {percent !== undefined ? <span>{` ${percent}%`}</span> : null}
    </span>
  );
}

/**
 * The headline result.
 *
 * `role="status"` rather than `role="alert"`: the worker deliberately navigated here, so
 * an assertive interruption would be wrong, but the content still needs announcing.
 */
export function RiskBanner({ band, percent }: { band: RiskBand; percent: number }) {
  const { t } = useI18n();

  return (
    <div className={`risk-banner risk-banner--${band}`} role="status">
      <span className="risk-banner__icon" aria-hidden="true">
        {BAND_ICON[band]}
      </span>
      <div className="risk-banner__label">{t(`result.band.${band}`)}</div>
      <div className="risk-banner__percent">
        {t('result.riskLabel')}: {percent}%
      </div>
      <p className="risk-banner__meaning">{t(`result.bandMeaning.${band}`)}</p>
    </div>
  );
}

/**
 * The "why".
 *
 * Reasons arrive from the shared engine already ordered by severity and already carrying
 * i18n keys plus interpolation params, so this component only renders — it never decides
 * what counts as a reason. That keeps the clinical logic in one place, shared with the API.
 */
export function ReasonList({ reasons }: { reasons: RiskReason[] }) {
  const { tDynamic } = useI18n();

  return (
    <ul className="reason-list">
      {reasons.map((reason) => (
        <li key={reason.code} className={`reason reason--${reason.severity}`}>
          <span className="reason__icon" aria-hidden="true">
            {SEVERITY_ICON[reason.severity] ?? '\u2022'}
          </span>
          <span>
            {tDynamic(
              reason.i18nKey,
              // The engine's params are unknown-typed; the interpolator only needs strings
              // and numbers, and anything else is coerced by String() downstream.
              reason.params as Record<string, string | number> | undefined,
              reason.fallbackEn,
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function RecommendationList({ recommendations }: { recommendations: RiskRecommendation[] }) {
  const { tDynamic } = useI18n();

  return (
    <ol className="reason-list">
      {recommendations.map((recommendation, index) => (
        <li key={recommendation.code} className="reason reason--info">
          <span className="reason__icon" aria-hidden="true">
            {index + 1}
          </span>
          <span>{tDynamic(recommendation.i18nKey)}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * The literal path taken through the trained tree.
 *
 * Kept behind a collapsible on the worker's screen because they do not need it, and shown
 * because a doctor, a district officer or a judge asking "how did it decide?" deserves a
 * real answer rather than a hand-wave about machine learning.
 */
export function DecisionPath({ steps }: { steps: DecisionPathStep[] }) {
  const { t, tDynamic } = useI18n();

  return (
    <div>
      <p className="faint" style={{ marginBottom: 'var(--space-2)' }}>
        {t('result.decisionHint')}
      </p>
      <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {steps.map((step, index) => (
          <li className="decision-step" key={`${step.feature}-${index}`}>
            <span className="decision-step__index" aria-hidden="true">
              {index + 1}
            </span>
            <span>
              {t('result.decisionStep', {
                feature: tDynamic(`feature.${step.feature}`, undefined, step.feature),
                operator: operatorSymbol(step.operator),
                threshold: formatNumber(step.threshold),
                value: formatNumber(step.value),
              })}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The neural model's independent read, and whether it agrees with the tree.
 *
 * Placement matters more than the content here. This sits inside the collapsed audit
 * section, never in the primary result area, because a worker acting on a referral needs
 * one band and one set of reasons — not two percentages to reconcile at a patient's door.
 *
 * When the two models disagree that is surfaced rather than smoothed over: a patient the
 * tree and the network place in different bands is near a decision boundary, which is a
 * reason for a doctor to look sooner. It is deliberately not phrased as an error.
 */
export function SecondOpinionSummary({
  secondOpinion,
  primaryBand,
}: {
  secondOpinion: SecondOpinion;
  primaryBand: RiskBand;
}) {
  const { t } = useI18n();
  const agrees = secondOpinion.agreesWithPrimary;

  return (
    <div className="stack stack--tight">
      <p className="faint">{t('result.secondOpinionHint')}</p>

      <div className="tag-row">
        <span className="faint">{t('result.secondOpinionModel')}</span>
        <RiskChip band={secondOpinion.riskBand} percent={secondOpinion.riskPercent} />
      </div>

      <p className={agrees ? 'faint' : undefined}>
        {agrees
          ? t('result.secondOpinionAgrees', { band: t(`result.band.${primaryBand}`) })
          : t('result.secondOpinionDiffers', {
              primary: t(`result.band.${primaryBand}`),
              second: t(`result.band.${secondOpinion.riskBand}`),
            })}
      </p>

      {!agrees ? <p className="faint">{t('result.secondOpinionBoundary')}</p> : null}

      <p className="faint">
        {t('result.secondOpinionProvenance', {
          algorithm: secondOpinion.algorithm,
          framework: secondOpinion.framework,
        })}
      </p>
    </div>
  );
}

/**
 * Per-feature contributions to the neural score.
 *
 * Every row shows the patient's value AND the value it is being compared against, because
 * without the second number the list reads as self-contradictory. A worked example from the
 * scripted demo case: BMI 31 shows a small *downward* contribution, since the training
 * cohort's median BMI is 32.3 — while the reason list above simultaneously and correctly
 * reports that BMI 31 is in the obese range against the Indian cut-off of 25. Both are
 * true. Only showing the baseline makes that legible instead of alarming.
 *
 * Unmeasured features are labelled and sort to the bottom with a contribution of exactly
 * zero, which is the honest result: the substituted value *is* the baseline, so a default
 * told the model nothing.
 */
export function AttributionList({
  attributions,
  baselineNote,
}: {
  attributions: FeatureAttribution[];
  baselineNote?: string;
}) {
  const { t, tDynamic } = useI18n();

  // Non-zero contributions first, largest first; zero/imputed rows last.
  const ordered = [...attributions].sort(
    (a, b) => Math.abs(b.contribution) - Math.abs(a.contribution),
  );
  const moved = ordered.filter((entry) => entry.direction !== 'neutral');
  const unmoved = ordered.filter((entry) => entry.direction === 'neutral');

  const row = (entry: FeatureAttribution) => {
    const label = tDynamic(`feature.${entry.feature}`, undefined, entry.feature);
    const width = Math.round(entry.share * 100);

    return (
      <li className="attribution" key={entry.feature}>
        <div className="attribution__head">
          <span className="attribution__feature">{label}</span>
          <span className="attribution__arrow" aria-hidden="true">
            {entry.direction === 'increases' ? '\u2191' : entry.direction === 'decreases' ? '\u2193' : '\u2013'}
          </span>
          <span className="attribution__share">{entry.direction === 'neutral' ? '\u2014' : `${width}%`}</span>
        </div>

        <div
          className="bar-track"
          role="meter"
          aria-valuenow={width}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${label} ${t(`result.attributionDirection.${entry.direction}`)}`}
        >
          <div
            className={`bar-fill bar-fill--attribution-${entry.direction}`}
            style={{ width: `${width}%` }}
          />
        </div>

        <p className="attribution__detail faint">
          {entry.imputed
            ? t('result.attributionNotMeasured')
            : t('result.attributionComparison', {
                value: formatNumber(entry.value),
                baseline: entry.baseline === null ? '\u2014' : formatNumber(entry.baseline),
                direction: t(`result.attributionDirection.${entry.direction}`),
              })}
        </p>
      </li>
    );
  };

  return (
    <div className="stack stack--tight">
      <p className="faint">{baselineNote ?? t('result.attributionHint')}</p>
      <ul className="attribution-list">{moved.map(row)}</ul>

      {unmoved.length > 0 ? (
        <>
          <p className="faint">{t('result.attributionNoEffect')}</p>
          <ul className="attribution-list">{unmoved.map(row)}</ul>
        </>
      ) : null}

      <p className="faint">{t('result.attributionCaveat')}</p>
    </div>
  );
}
