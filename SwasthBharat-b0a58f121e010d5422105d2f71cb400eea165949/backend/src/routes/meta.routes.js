/**
 * Health check and model transparency.
 *
 * `/api/model` is public on purpose. If a system tells someone they are at high risk of
 * diabetes, the basis for that claim — the dataset, its known bias, the held-out
 * accuracy, the exact tree — should be inspectable without a login. The app links to it
 * from the risk result screen.
 */

import express from 'express';
import {
  DECISION_TREE,
  INPUT_RANGES,
  MODEL_META,
  NEURAL_META,
  NEURAL_WEIGHTS,
  RISK_ENGINE_VERSION,
} from '../../../shared/risk/index.js';
import { CHATBOT_VERSION, SUPPORTED_CHATBOT_LANGUAGES } from '../../../shared/chatbot/index.js';
import { config } from '../config/env.js';
import { firebaseStatus } from '../config/firebase.js';
import { databaseStatus } from '../db/connect.js';
import { pushStatus } from '../services/pushService.js';
import { realtimeStats } from '../realtime/io.js';
import { asyncHandler } from '../utils/asyncHandler.js';

export const metaRouter = express.Router();

const startedAt = Date.now();

metaRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const db = databaseStatus();
    const realtime = await realtimeStats();
    const healthy = db.state === 'connected';

    res.status(healthy ? 200 : 503).json({
      status: healthy ? 'ok' : 'degraded',
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      database: db,
      realtime,
      /**
       * Whether phone-OTP sign-in is available, and whether it is pointed at the emulator.
       * Reported because "why does the OTP button do nothing" is otherwise a slow thing to
       * diagnose, and because an emulator flag showing up on a real deployment is a
       * finding, not a detail.
       */
      firebase: firebaseStatus(),
      /** Background push (FCM). Independent of phone sign-in; both are optional. */
      push: pushStatus(),
      riskEngineVersion: RISK_ENGINE_VERSION,
      chatbotVersion: CHATBOT_VERSION,
      languages: SUPPORTED_CHATBOT_LANGUAGES,
      /**
       * Whether the chatbot's Gemini fallback is switched on. Not whether it will actually
       * succeed on the next call — a free-tier quota can still return 429 per-request, and
       * that degrades quietly to the rule engine's own fallback (see geminiChat.js).
       * Reported so "why did that question get a generated answer" is answerable from one
       * endpoint instead of grepping backend/.env.
       */
      chatbotGeminiEnabled: config.geminiEnabled && Boolean(config.geminiApiKey),
      serverTime: new Date().toISOString(),
    });
  }),
);

metaRouter.get('/model', (_req, res) => {
  res.json({
    engineVersion: RISK_ENGINE_VERSION,
    disease: 'type-2-diabetes',
    isPrototype: true,

    /** Which model decides the risk band. The neural one below does not. */
    primaryModel: 'tree',

    algorithm: MODEL_META.algorithm,
    hyperparameters: MODEL_META.hyperparameters,
    trainedAt: MODEL_META.generatedAt,

    featureOrder: MODEL_META.featureOrder,
    featureImportances: MODEL_META.featureImportances,
    imputationMedians: MODEL_META.imputationMedians,
    riskBands: MODEL_META.riskBands,

    metrics: MODEL_META.metrics,

    dataset: MODEL_META.dataset,

    /**
     * The neural second opinion, disclosed on the same public endpoint as the tree.
     *
     * Two things stated here rather than left to be inferred: that it does not decide the
     * band, and that its metrics were measured by the exported JavaScript rather than by
     * PyTorch. The second matters because the JavaScript is what scores patients, and
     * publishing the framework's numbers for a model served by something else would be
     * describing code that is not deployed.
     */
    secondOpinion: {
      role: NEURAL_META.role,
      authoritativeForRiskBand: NEURAL_META.authoritativeForRiskBand,
      algorithm: NEURAL_META.algorithm,
      framework: `${NEURAL_META.framework} ${NEURAL_META.frameworkVersion}`,
      parameterCount: NEURAL_META.parameterCount,
      hyperparameters: NEURAL_META.hyperparameters,
      epochSelection: NEURAL_META.epochSelection,
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
      limitations: [
        'Not authoritative: the decision tree decides the risk band. This is a second opinion and an attribution source.',
        'Attributions are relative to the median patient of the training split, so a value below that median contributes negatively even when it is clinically abnormal by Indian reference ranges.',
        'Features that were not measured contribute exactly zero, because the substituted value is the baseline.',
        'The network learned a small negative coefficient for diastolic blood pressure, which does not match clinical direction. It accounts for roughly 4% of attributed movement and is shown as model internals, not as advice.',
      ],
    },

    /**
     * The limitation stated plainly, in the API, not just in documentation.
     */
    limitations: [
      'Trained on the Pima Indians Diabetes dataset: adult Pima Native American women, not an Indian cohort.',
      'Feature-to-risk directions transfer across populations; the absolute cut-offs are not calibrated for India.',
      'Two models are trained on this data. The decision tree decides the risk band; a neural network runs alongside it as a second opinion and to attribute the score across all eight inputs.',
      'The dataset Glucose column is a 2-hour oral glucose tolerance value, not a fasting reading.',
      'Skin thickness and insulin are usually unmeasured in the field and default to the training-split median.',
      'This is a screening aid. It does not diagnose. A confirmatory laboratory test is always required.',
      'Production deployment would retrain on ICMR-INDIAB or NFHS-5 style Indian cohort data.',
    ],

    /** Clinical reference ranges used for the plain-language explanations. */
    explanationReferences: {
      bmi: 'WHO Asian-Indian cut-offs (overweight >= 23, obese >= 25) rather than the international 25/30.',
      glucose: 'WHO/ICMR diagnostic ranges, selected by the sample type the worker recorded.',
      diastolicBp: 'Elevated >= 80 mm Hg, high >= 90 mm Hg.',
      screeningAge: 'Routine screening advised from 35; risk noted as elevated from 45.',
    },

    inputRanges: INPUT_RANGES,
  });
});

/** The fitted tree itself, for anyone who wants to audit the actual decision logic. */
metaRouter.get('/model/tree', (_req, res) => {
  res.json({ featureOrder: MODEL_META.featureOrder, riskBands: MODEL_META.riskBands, tree: DECISION_TREE });
});

/**
 * The neural network's actual weights, for the same reason `/model/tree` exposes the tree.
 *
 * There is no confidentiality argument for withholding them: the model is trained on a
 * public dataset, it is already shipped to every browser inside the PWA bundle, and a
 * reviewer who wants to reproduce a prediction by hand should be able to. 289 numbers.
 */
metaRouter.get('/model/network', (_req, res) => {
  res.json({
    featureOrder: NEURAL_META.featureOrder,
    riskBands: NEURAL_META.riskBands,
    standardisation: NEURAL_META.standardisation,
    attributionBaseline: NEURAL_META.attributionBaseline,
    architecture: NEURAL_META.algorithm,
    parameterCount: NEURAL_META.parameterCount,
    authoritativeForRiskBand: NEURAL_META.authoritativeForRiskBand,
    weights: NEURAL_WEIGHTS,
  });
});
