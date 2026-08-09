/**
 * The screening form — the screen an ASHA worker actually uses in the field.
 *
 * ### The one design decision everything else follows from
 *
 * **The risk is computed on the device, locally, before any network call.** The bundled
 * decision tree (`@shared/risk`) is the same code the API runs, so scoring needs no
 * connection at all. The record is then written to IndexedDB, and only after both of those
 * have succeeded does the app try to upload.
 *
 * The ordering is the entire offline story:
 *
 *   score locally -> save locally -> navigate to the result -> try to sync in the background
 *
 * There is no state in which the worker is blocked, no spinner waiting on a request that
 * cannot succeed, and no way for a completed screening to be lost because the upload failed.
 * Submitting with the wifi off behaves identically to submitting with it on, apart from a
 * badge saying the record is queued.
 *
 * ### Other choices worth knowing
 *
 * - Height and weight are collected, BMI is computed. Asking a health worker to do kg/m²
 *   arithmetic on paper is how you get bad data.
 * - Pregnancy count only appears for female patients.
 * - Skin-fold thickness and insulin are optional, because no village health post has a
 *   calliper or an insulin assay. When left blank the engine substitutes the dataset median
 *   and the result page says so explicitly.
 * - `inputMethod` records whether the worker typed or dictated, which is how the district
 *   view can report whether voice entry is actually being adopted.
 */

import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { AppShell } from '@/components/AppShell';
import { ChoiceGroup, NumberField, TextField } from '@/components/forms';
import { Card, Collapsible, Notice } from '@/components/ui';
import { useI18n } from '@/i18n';
import { assessDiabetesRisk, calculateBmi, INPUT_RANGES } from '@shared/risk/index.js';
import type { AssessmentInput, GlucoseMeasurementType, Sex } from '@shared/risk/index.js';
import { saveAssessmentLocally, type LocalAssessment } from '@/lib/db';
import { useAuth } from '@/state/AuthContext';
import { syncManager, useSyncState } from '@/state/useSyncState';
import { useToast } from '@/state/ToastContext';

interface FormState {
  patientName: string;
  village: string;
  phone: string;
  sex: Sex | null;
  age: string;
  glucoseMgDl: string;
  glucoseMeasurementType: GlucoseMeasurementType;
  diastolicBpMmHg: string;
  heightCm: string;
  weightKg: string;
  familyHistoryDiabetes: 'yes' | 'no' | null;
  pregnancies: string;
  skinThicknessMm: string;
  insulinMuUml: string;
}

const EMPTY_FORM: FormState = {
  patientName: '',
  village: '',
  phone: '',
  sex: null,
  age: '',
  glucoseMgDl: '',
  glucoseMeasurementType: 'fasting',
  diastolicBpMmHg: '',
  heightCm: '',
  weightKg: '',
  familyHistoryDiabetes: null,
  pregnancies: '',
  skinThicknessMm: '',
  insulinMuUml: '',
};

/** `crypto.randomUUID` needs a secure context; localhost counts, plain-HTTP LAN does not. */
function newId(prefix: string): string {
  const random =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  return `${prefix}_${random}`;
}

export function AssessmentFormPage() {
  const { t, tDynamic, language } = useI18n();
  const { user } = useAuth();
  const { show } = useToast();
  const sync = useSyncState();
  const navigate = useNavigate();

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [usedVoice, setUsedVoice] = useState(false);
  const [usedTyping, setUsedTyping] = useState(false);

  const villageOptions = useMemo(() => {
    const fromUser = user?.villages ?? [];
    const fromPhc = user?.phc?.villages ?? [];
    return Array.from(new Set([...fromUser, ...fromPhc]));
  }, [user]);

  const set = useCallback(
    <K extends keyof FormState>(key: K) =>
      (value: FormState[K]) => {
        setForm((current) => ({ ...current, [key]: value }));
        // Clear the error as soon as the worker starts fixing the field, rather than making
        // them re-submit to find out whether it is happy now.
        setErrors((current) => {
          if (!current[key as string]) return current;
          const next = { ...current };
          delete next[key as string];
          return next;
        });
      },
    [],
  );

  /** Typing counts as manual entry; used to distinguish 'voice' from 'mixed'. */
  const setTyped = useCallback(
    <K extends keyof FormState>(key: K) =>
      (value: FormState[K]) => {
        setUsedTyping(true);
        set(key)(value);
      },
    [set],
  );

  const bmi = useMemo(
    () => calculateBmi(Number(form.heightCm), Number(form.weightKg)),
    [form.heightCm, form.weightKg],
  );

  const buildEngineInput = useCallback(
    (): AssessmentInput => ({
      sex: (form.sex ?? 'female') as Sex,
      age: form.age,
      glucoseMgDl: form.glucoseMgDl,
      glucoseMeasurementType: form.glucoseMeasurementType,
      diastolicBpMmHg: form.diastolicBpMmHg,
      heightCm: form.heightCm,
      weightKg: form.weightKg,
      familyHistoryDiabetes: form.familyHistoryDiabetes === 'yes',
      pregnancies: form.sex === 'female' ? form.pregnancies : 0,
      skinThicknessMm: form.skinThicknessMm === '' ? null : form.skinThicknessMm,
      insulinMuUml: form.insulinMuUml === '' ? null : form.insulinMuUml,
    }),
    [form],
  );

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (submitting || !user) return;

    /* Local, non-engine validation first ---------------------------------- */
    const localErrors: Record<string, string> = {};
    if (!form.patientName.trim()) localErrors.patientName = t('validation.nameRequired');
    if (!form.sex) localErrors.sex = t('validation.selectOption');
    if (form.familyHistoryDiabetes === null) {
      localErrors.familyHistoryDiabetes = t('validation.selectOption');
    }

    /* Then the shared engine's own validation ------------------------------ */
    let result;
    try {
      result = assessDiabetesRisk(buildEngineInput());
    } catch (error) {
      const validationErrors = (error as { validationErrors?: { field: string; i18nKey: string; params?: Record<string, unknown> }[] })
        .validationErrors;

      if (Array.isArray(validationErrors)) {
        for (const item of validationErrors) {
          localErrors[item.field] = tDynamic(
            item.i18nKey,
            item.params as Record<string, string | number> | undefined,
          );
        }
      } else {
        show(t('errors.generic'), 'error');
        return;
      }
    }

    if (Object.keys(localErrors).length > 0 || !result) {
      setErrors(localErrors);
      show(t('form.fixErrors'), 'error');
      // Move focus to the first problem so it is not left off-screen below the fold.
      const firstField = Object.keys(localErrors)[0];
      document.querySelector<HTMLElement>(`[aria-invalid="true"], [data-field="${firstField}"]`)?.focus();
      return;
    }

    setSubmitting(true);

    const capturedAt = new Date().toISOString();
    const record: LocalAssessment = {
      clientId: newId('as'),
      userId: user.id,
      patientClientId: newId('pt'),
      patientName: form.patientName.trim(),
      patientAge: Number(form.age),
      patientSex: form.sex as Sex,
      patientVillage: form.village.trim(),
      patientPhone: form.phone.trim(),
      input: {
        sex: form.sex as Sex,
        age: Number(form.age),
        glucoseMgDl: Number(form.glucoseMgDl),
        glucoseMeasurementType: form.glucoseMeasurementType,
        diastolicBpMmHg: Number(form.diastolicBpMmHg),
        heightCm: Number(form.heightCm),
        weightKg: Number(form.weightKg),
        familyHistoryDiabetes: form.familyHistoryDiabetes === 'yes',
        pregnancies: form.sex === 'female' ? Number(form.pregnancies) || 0 : 0,
        skinThicknessMm: form.skinThicknessMm === '' ? null : Number(form.skinThicknessMm),
        insulinMuUml: form.insulinMuUml === '' ? null : Number(form.insulinMuUml),
      },
      riskBand: result.riskBand,
      riskPercent: result.riskPercent,
      probability: result.probability,
      derived: result.derived,
      imputedFields: result.imputedFields,
      reasons: result.reasons,
      recommendations: result.recommendations,
      decisionPath: result.decisionPath,
      // Scored on-device alongside the tree, so the result screen can show the second
      // opinion and the attributions with the network off.
      secondOpinion: result.secondOpinion,
      attributions: result.attributions,
      capturedAt,
      language,
      inputMethod: usedVoice ? (usedTyping ? 'mixed' : 'voice') : 'typed',
      createdOffline: !sync.online,
      syncState: 'pending',
      attempts: 0,
      lastAttemptAt: null,
      lastError: null,
      serverId: null,
      serverPatientId: null,
    };

    try {
      // Durable before anything else can go wrong.
      await saveAssessmentLocally(record);
    } catch (error) {
      setSubmitting(false);
      show(t('errors.generic'), 'error');
      console.error('[screening] could not save locally', error);
      return;
    }

    show(sync.online ? t('form.savedOnline') : t('form.savedOffline'), 'success');

    // Fire and forget. The result screen must not wait on the network, and the sync manager
    // owns retries from here on.
    void syncManager.flush();

    navigate(`/result/${record.clientId}`, { replace: true });
  };

  return (
    <AppShell title={t('form.title')} subtitle={user?.phc?.name}>
      <form className="stack" onSubmit={handleSubmit} noValidate>
        {!sync.online ? <Notice tone="offline">{t('connection.offlineBanner')}</Notice> : null}

        <Card title={t('form.sectionPatient')}>
          <div className="stack">
            <TextField
              label={t('form.patientName')}
              placeholder={t('form.patientNamePlaceholder')}
              value={form.patientName}
              onChange={setTyped('patientName')}
              error={errors.patientName}
              required
              autoComplete="off"
              maxLength={80}
            />

            <ChoiceGroup<Sex>
              label={t('form.sex')}
              value={form.sex}
              onChange={set('sex')}
              error={errors.sex}
              required
              options={[
                { value: 'female', label: t('common.female'), icon: '\u2640' },
                { value: 'male', label: t('common.male'), icon: '\u2642' },
              ]}
            />

            <NumberField
              label={t('form.age')}
              unit={t('common.years')}
              value={form.age}
              onChange={setTyped('age')}
              error={errors.age}
              required
              voicePromptKey="voice.speakAge"
              onVoiceUsed={() => setUsedVoice(true)}
            />

            {villageOptions.length > 0 ? (
              <div className="field">
                <label className="field__label" htmlFor="village-select">
                  {t('form.village')}
                </label>
                <select
                  id="village-select"
                  className="select"
                  value={form.village}
                  onChange={(event) => set('village')(event.target.value)}
                >
                  <option value="">{t('common.unknown')}</option>
                  {villageOptions.map((village) => (
                    <option key={village} value={village}>
                      {village}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <TextField
                label={t('form.village')}
                placeholder={t('form.villagePlaceholder')}
                value={form.village}
                onChange={setTyped('village')}
              />
            )}

            <TextField
              label={t('form.phone')}
              hint={t('form.phoneHint')}
              type="tel"
              value={form.phone}
              onChange={setTyped('phone')}
              maxLength={15}
            />
          </div>
        </Card>

        <Card title={t('form.sectionVitals')}>
          <div className="stack">
            <NumberField
              label={t('form.glucose')}
              hint={t('form.glucoseHint')}
              unit={t('form.glucoseUnit')}
              value={form.glucoseMgDl}
              onChange={setTyped('glucoseMgDl')}
              error={errors.glucoseMgDl}
              required
              voicePromptKey="voice.speakGlucose"
              onVoiceUsed={() => setUsedVoice(true)}
            />

            {/*
              The Pima dataset's glucose column is a 2-hour post-load OGTT value, but a
              worker on a home visit usually has a fasting or random capillary reading.
              Recording which kind was taken lets the explanation use the correct clinical
              range instead of silently applying the wrong one.
            */}
            <ChoiceGroup<GlucoseMeasurementType>
              label={t('form.glucoseType')}
              value={form.glucoseMeasurementType}
              onChange={set('glucoseMeasurementType')}
              stacked
              options={[
                { value: 'fasting', label: t('form.glucoseTypeFasting') },
                { value: 'ogtt2h', label: t('form.glucoseTypeOgtt2h') },
                { value: 'random', label: t('form.glucoseTypeRandom') },
              ]}
            />

            <NumberField
              label={t('form.diastolicBp')}
              hint={t('form.diastolicBpHint')}
              unit={t('form.diastolicBpUnit')}
              value={form.diastolicBpMmHg}
              onChange={setTyped('diastolicBpMmHg')}
              error={errors.diastolicBpMmHg}
              required
              voicePromptKey="voice.speakBp"
              onVoiceUsed={() => setUsedVoice(true)}
            />

            <NumberField
              label={t('form.height')}
              unit={t('form.heightUnit')}
              value={form.heightCm}
              onChange={setTyped('heightCm')}
              error={errors.heightCm}
              required
              voicePromptKey="voice.speakHeight"
              onVoiceUsed={() => setUsedVoice(true)}
            />

            <NumberField
              label={t('form.weight')}
              unit={t('form.weightUnit')}
              value={form.weightKg}
              onChange={setTyped('weightKg')}
              error={errors.weightKg}
              required
              allowDecimal
              voicePromptKey="voice.speakWeight"
              onVoiceUsed={() => setUsedVoice(true)}
            />

            {/* Immediate feedback that the app did the arithmetic, so nobody does it twice. */}
            <Notice tone="info">
              {bmi ? t('form.bmiComputed', { bmi }) : t('form.bmiPending')}
            </Notice>
          </div>
        </Card>

        <Card title={t('form.sectionHistory')}>
          <div className="stack">
            <ChoiceGroup<'yes' | 'no'>
              label={t('form.familyHistory')}
              hint={t('form.familyHistoryHint')}
              value={form.familyHistoryDiabetes}
              onChange={set('familyHistoryDiabetes')}
              error={errors.familyHistoryDiabetes}
              required
              options={[
                { value: 'yes', label: t('common.yes'), icon: '\u2713' },
                { value: 'no', label: t('common.no'), icon: '\u2715' },
              ]}
            />

            {form.sex === 'female' ? (
              <NumberField
                label={t('form.pregnancies')}
                hint={t('form.pregnanciesHint')}
                value={form.pregnancies}
                onChange={setTyped('pregnancies')}
                error={errors.pregnancies}
                required
                voicePromptKey="voice.speakNumber"
                onVoiceUsed={() => setUsedVoice(true)}
              />
            ) : null}
          </div>
        </Card>

        {/*
          Collapsed by default. These two are almost never available in the field, and
          putting them in the main flow would imply they are expected — which makes a worker
          feel the form is incomplete when it is not.
        */}
        <Card>
          <Collapsible summary={t('form.sectionOptional')}>
            <div className="stack" style={{ paddingTop: 'var(--space-3)' }}>
              <p className="field__hint">{t('form.sectionOptionalHint')}</p>

              <NumberField
                label={t('form.skinThickness')}
                unit={t('form.skinThicknessUnit')}
                value={form.skinThicknessMm}
                onChange={setTyped('skinThicknessMm')}
                error={errors.skinThicknessMm}
                placeholder={`${INPUT_RANGES.skinThicknessMm.min}\u2013${INPUT_RANGES.skinThicknessMm.max}`}
              />

              <NumberField
                label={t('form.insulin')}
                unit={t('form.insulinUnit')}
                value={form.insulinMuUml}
                onChange={setTyped('insulinMuUml')}
                error={errors.insulinMuUml}
                placeholder={`${INPUT_RANGES.insulinMuUml.min}\u2013${INPUT_RANGES.insulinMuUml.max}`}
              />
            </div>
          </Collapsible>
        </Card>

        <button type="submit" className="button button--hero button--block" disabled={submitting}>
          {submitting ? t('form.calculating') : t('form.calculate')}
        </button>
      </form>
    </AppShell>
  );
}
