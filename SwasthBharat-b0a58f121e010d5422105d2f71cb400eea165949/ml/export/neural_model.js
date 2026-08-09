/* eslint-disable */
/**
 * AUTO-GENERATED FILE - DO NOT EDIT BY HAND.
 * Regenerate with:
 *   node ml/prepare_dataset.mjs && python ml/train_neural.py && node ml/export_neural.mjs
 *
 * Neural SECOND OPINION for the diabetes risk engine, trained in PyTorch and exported
 * as plain JavaScript so it runs synchronously, offline, inside the service-worker
 * cached PWA bundle and identically on the Express API. No tensor runtime is shipped
 * and no Python process sits in the request path: this file is 289 numbers and
 * about eighty lines of arithmetic.
 *
 * THE DECISION TREE REMAINS AUTHORITATIVE FOR THE RISK BAND.
 * This model does two things the tree cannot:
 *   1. per-feature signed attributions across all eight inputs (integrated gradients),
 *      where the tree can only report the <= 4 comparisons on the path it happened to take
 *   2. an independent second opinion, whose DISAGREEMENT with the tree is itself worth
 *      surfacing to a doctor
 * See ml/README.md for why it was not promoted to primary.
 *
 * Architecture: MLP 8-16-8-1, ReLU, sigmoid output
 * Generated:    2026-08-08T20:59:37.304431+00:00
 * Trained by:   ml/train_neural.py (PyTorch 2.13.0+cpu)
 *
 * Held-out (measured by THIS file's forward pass, not by PyTorch):
 *   accuracy 71.4% | recall 72.2% | precision 57.4% | ROC-AUC 0.8163
 *
 * Held-out band spread:
 *   LOW         63 patients ( 40.9% of held-out)  actually diabetic: 12.7%
 *   MODERATE    36 patients ( 23.4% of held-out)  actually diabetic: 30.6%
 *   HIGH        55 patients ( 35.7% of held-out)  actually diabetic: 63.6%
 *
 * Mean |integrated gradient| attribution over the training split:
 *   glucose        39.0%
 *   bmi            23.6%
 *   pregnancies    12.2%
 *   familyHistory  8.7%
 *   age            7.4%
 *   diastolicBp    4.3%
 *   insulin        2.5%
 *   skinThickness  2.4%
 *
 * Agreement with the PyTorch float32 reference on the held-out split:
 *   max probability delta 9.172e-8 (tolerance 0.00001)
 *
 * DATASET LIMITATION: trained on adult Pima Native American women, not an Indian
 * cohort. Feature-risk directions are medically valid cross-population, but the
 * absolute calibration is not. Prototype only.
 */

/** Feature vector order. Identical to FEATURE_ORDER in decision_tree_rules.js. */
export const NEURAL_FEATURE_ORDER = ["glucose","diastolicBp","bmi","age","pregnancies","familyHistory","skinThickness","insulin"];

/** Provenance, standardisation, metrics and attribution settings. */
export const NEURAL_META = {
  "generatedAt": "2026-08-08T20:59:37.304431+00:00",
  "generatedBy": "ml/train_neural.py (PyTorch 2.13.0+cpu) + ml/export_neural.mjs",
  "framework": "pytorch",
  "frameworkVersion": "2.13.0+cpu",
  "algorithm": "MLP 8-16-8-1, ReLU, sigmoid output",
  "role": "second-opinion",
  "authoritativeForRiskBand": false,
  "hyperparameters": {
    "hidden": [
      16,
      8
    ],
    "activation": "relu",
    "optimiser": "adam",
    "learningRate": 0.01,
    "weightDecay": 0.0001,
    "loss": "BCEWithLogitsLoss",
    "posWeight": 1.869159,
    "epochs": 49,
    "maxEpochs": 1200,
    "earlyStopPatience": 150,
    "validationFraction": 0.2,
    "batch": "full",
    "randomSeed": 42
  },
  "epochSelection": {
    "method": "best validation ROC-AUC on a stratified 20% slice of the train split",
    "bestEpoch": 49,
    "validationRocAuc": 0.7991,
    "note": "The held-out test split was not used to choose any hyperparameter."
  },
  "parameterCount": 289,
  "featureOrder": [
    "glucose",
    "diastolicBp",
    "bmi",
    "age",
    "pregnancies",
    "familyHistory",
    "skinThickness",
    "insulin"
  ],
  "standardisation": {
    "mean": [
      121.38762214983713,
      72.03745928338762,
      32.495276872964205,
      33.50651465798045,
      3.7996742671009773,
      0.5,
      29.65960912052117,
      141.1058631921824
    ],
    "std": [
      30.48227300104109,
      11.94982305597823,
      6.8996360550445734,
      11.924946748449992,
      3.354796249305478,
      0.5,
      8.937883570155881,
      89.66079871135346
    ]
  },
  "attributionBaseline": [
    117,
    72,
    32.3,
    29,
    3,
    0.5,
    30,
    125
  ],
  "attributionMethod": "integrated gradients, integrated exactly by subdividing the path at ReLU kinks",
  "attributionMaxDepth": 24,
  "attributionInitialSegments": 16,
  "riskBands": {
    "high": 0.6,
    "moderate": 0.3
  },
  "featureImportances": {
    "glucose": 0.389804,
    "diastolicBp": 0.043394,
    "bmi": 0.235529,
    "age": 0.073736,
    "pregnancies": 0.121899,
    "familyHistory": 0.08679,
    "skinThickness": 0.024067,
    "insulin": 0.024781
  },
  "metrics": {
    "train": {
      "accuracy": 0.7557,
      "precision": 0.6151,
      "recall": 0.7991,
      "specificity": 0.7325,
      "f1": 0.6951,
      "confusionMatrix": {
        "truePositive": 171,
        "falsePositive": 107,
        "trueNegative": 293,
        "falseNegative": 43
      },
      "rocAuc": 0.859
    },
    "test": {
      "accuracy": 0.7143,
      "precision": 0.5735,
      "recall": 0.7222,
      "specificity": 0.71,
      "f1": 0.6393,
      "confusionMatrix": {
        "truePositive": 39,
        "falsePositive": 29,
        "trueNegative": 71,
        "falseNegative": 15
      },
      "rocAuc": 0.8163
    }
  },
  "heldOutBandSummary": {
    "LOW": {
      "patients": 63,
      "actualDiabetic": 8,
      "actualDiabeticRate": 0.127,
      "share": 0.4091
    },
    "MODERATE": {
      "patients": 36,
      "actualDiabetic": 11,
      "actualDiabeticRate": 0.3056,
      "share": 0.2338
    },
    "HIGH": {
      "patients": 55,
      "actualDiabetic": 35,
      "actualDiabeticRate": 0.6364,
      "share": 0.3571
    }
  },
  "dataset": {
    "name": "Pima Indians Diabetes Database",
    "records": 768,
    "trainRecords": 614,
    "testRecords": 154,
    "knownLimitation": "Cohort is adult Pima Native American women. Not representative of rural India. Prototype only; retrain on ICMR-INDIAB or NFHS-5 before any real deployment."
  },
  "crossCheck": {
    "reference": "pytorch 2.13.0+cpu",
    "maxProbabilityDelta": 9.172e-8,
    "floatTolerance": 0.00001,
    "worstCompletenessGap": 9.953e-9,
    "attributionRegionsPerPath": {
      "max": 383,
      "mean": 221.79
    },
    "referenceMetrics": {
      "train": {
        "accuracy": 0.7557,
        "precision": 0.6151,
        "recall": 0.7991,
        "specificity": 0.7325,
        "f1": 0.6951,
        "confusionMatrix": {
          "truePositive": 171,
          "falsePositive": 107,
          "trueNegative": 293,
          "falseNegative": 43
        },
        "rocAuc": 0.859
      },
      "test": {
        "accuracy": 0.7143,
        "precision": 0.5735,
        "recall": 0.7222,
        "specificity": 0.71,
        "f1": 0.6393,
        "confusionMatrix": {
          "truePositive": 39,
          "falsePositive": 29,
          "trueNegative": 71,
          "falseNegative": 15
        },
        "rocAuc": 0.8163
      }
    },
    "note": "metrics in this artefact were computed by its own JavaScript forward pass over the held-out split; referenceMetrics are PyTorch float32 for comparison"
  }
};

/**
 * Trained parameters. `weight` is [outputs][inputs], matching PyTorch's nn.Linear
 * layout, so a reviewer can diff these against the checkpoint directly.
 */
export const NEURAL_WEIGHTS = {
  l1: {
    weight: [[0.501835286617279,0.1865476369857788,0.18409068882465363,0.17228688299655914,-0.11099858582019806,-0.21676667034626007,-0.08851902186870575,-0.03314455226063728],[0.3598499596118927,-0.40502575039863586,0.0987766906619072,-0.17191694676876068,0.34173375368118286,-0.2734460234642029,-0.1558075249195099,-0.16482216119766235],[0.060414090752601624,-0.30763137340545654,-0.5802270770072937,-0.21422535181045532,-0.39363470673561096,0.08912824094295502,-0.5124775171279907,0.051329340785741806],[-0.6331631541252136,-0.1896192580461502,-0.3254530131816864,-0.47035202383995056,-0.232527956366539,-0.3660331964492798,0.29971763491630554,-0.5280913710594177],[0.5829060077667236,0.22909721732139587,0.2453646957874298,0.10672074556350708,0.3591180741786957,0.5444350242614746,0.016688652336597443,-0.1104385033249855],[0.4729209244251251,-0.2737388014793396,0.2146051675081253,-0.06468535959720612,0.06245952472090721,-0.04321152716875076,-0.13965627551078796,-0.2242022603750229],[0.5660815834999084,0.08671090751886368,0.10814812034368515,-0.06956774741411209,0.19439777731895447,0.5158085227012634,0.3250216543674469,0.06016835570335388],[-0.2540314197540283,-0.020863257348537445,0.0576140470802784,-0.5529484748840332,-0.24005575478076935,-0.35888907313346863,-0.07378452271223068,-0.2827671766281128],[0.4425988793373108,-0.3843356668949127,0.4192110598087311,-0.03332797437906265,-0.24711944162845612,-0.07302795350551605,0.4313035309314728,-0.02101372927427292],[0.66424560546875,0.09746409952640533,0.10055306553840637,-0.16713185608386993,0.2036716490983963,0.5598676204681396,0.4112994968891144,0.2239869385957718],[-0.5783112645149231,-0.33415308594703674,-0.10573459416627884,-0.33706533908843994,-0.026495445519685745,-0.04146825894713402,0.08736824989318848,-0.487954705953598],[-0.4516678750514984,-0.00007302314043045044,-0.32597970962524414,0.18484210968017578,0.2418612390756607,0.26432371139526367,-0.5263088345527649,-0.1458224505186081],[0.036013469099998474,-0.3940452039241791,-0.5012429356575012,-0.5315491557121277,-0.3389046788215637,0.370997816324234,-0.36076927185058594,-0.3001002371311188],[-0.3242641091346741,-0.43326643109321594,-0.7080842852592468,-0.3540952503681183,-0.5015777945518494,-0.17604371905326843,0.13567891716957092,0.10260037332773209],[0.42029374837875366,-0.3914533853530884,0.1847253292798996,-0.27742159366607666,0.21805374324321747,-0.009454015642404556,-0.14638657867908478,-0.2534937560558319],[0.08119373768568039,-0.06223155930638313,-0.020436126738786697,-0.02021106518805027,0.007210253272205591,0.017727840691804886,-0.06849327683448792,-0.06079108640551567]],
    bias: [0.39592406153678894,-0.09087228029966354,0.4991864860057831,0.3271181583404541,-0.11970493942499161,0.43345391750335693,0.15695367753505707,-0.1292436718940735,-0.02658022567629814,-0.06210380792617798,0.24621368944644928,-0.07988067716360092,0.19572922587394714,-0.189851313829422,0.3552882671356201,-0.48510125279426575],
  },
  l2: {
    weight: [[-0.2250209003686905,-0.1897927075624466,0.3592517077922821,0.4695053994655609,-0.04398822784423828,-0.4879794120788574,0.02509918063879013,0.06807641685009003,-0.18930743634700775,-0.4082849323749542,0.4805986285209656,0.22097782790660858,0.3619621694087982,0.4006668031215668,0.20240022242069244,0.03268619254231453],[0.07426297664642334,-0.08956038951873779,-0.003631060244515538,-0.08027464151382446,-0.07126270234584808,-0.22703342139720917,-0.39344462752342224,-0.0019103887025266886,-0.17942625284194946,-0.2906474471092224,-0.10744880139827728,0.34333255887031555,0.28081923723220825,0.1648201048374176,-0.04680510237812996,0.040448978543281555],[-0.15692035853862762,0.2858862280845642,-0.037766315042972565,-0.34291043877601624,0.25547119975090027,0.3044852614402771,0.22585980594158173,-0.1135602593421936,0.12590673565864563,0.1811760663986206,0.0043050022795796394,-0.28829941153526306,-0.04399700090289116,-0.16430243849754333,0.20176103711128235,-0.015560869127511978],[0.049151595681905746,0.07724148035049438,-0.0654955506324768,0.15175005793571472,-0.08703496307134628,-0.15843921899795532,-0.10345951467752457,-0.02751990035176277,-0.40103039145469666,-0.1958184540271759,0.31191352009773254,0.4419634938240051,0.06787168234586716,-0.038956478238105774,-0.34631094336509705,-0.023951951414346695],[-0.169732928276062,-0.21509422361850739,0.40216296911239624,0.3785296380519867,-0.3116750717163086,-0.34141218662261963,0.06371233612298965,0.4285390079021454,-0.11509639024734497,-0.03992529585957527,0.3502008020877838,0.23966152966022491,0.06213749572634697,0.4819170832633972,-0.00019810727098956704,0.12606659531593323],[-0.19990120828151703,-0.048748403787612915,0.3724769055843353,0.3611876368522644,-0.1810390204191208,-0.5303537249565125,-0.15879975259304047,0.29753226041793823,-0.014306961558759212,0.11912059038877487,0.3782854676246643,0.4727790355682373,0.16064901649951935,0.10937684029340744,-0.08785906434059143,-0.043644413352012634],[0.10360436141490936,-0.568238377571106,-0.0785282552242279,0.0909012034535408,-0.14829006791114807,-0.35544294118881226,0.01545479241758585,0.09076029062271118,0.20766283571720123,0.39586907625198364,0.10159989446401596,0.25375983119010925,-0.16501156985759735,0.10020394623279572,-0.26011350750923157,-0.014650845900177956],[0.3914177119731903,0.20135065913200378,0.3537392020225525,0.08369599282741547,0.5365938544273376,0.13767197728157043,0.3775511085987091,0.2336215376853943,0.28158462047576904,0.4553472101688385,0.037646032869815826,-0.1913837343454361,0.24507278203964233,-0.47076958417892456,0.35759609937667847,-0.25333482027053833]],
    bias: [0.3911179006099701,0.10212085396051407,0.329974502325058,-0.09645217657089233,0.010719009675085545,0.30719447135925293,0.2742299735546112,0.05835660547018051],
  },
  out: {
    weight: [[-0.3385908007621765,-0.1581762433052063,0.1910625696182251,-0.1586233228445053,-0.40822887420654297,-0.33180657029151917,-0.5568454265594482,0.5522767305374146]],
    bias: [0.15187008678913116],
  },
};

const MEAN = NEURAL_META.standardisation.mean;
const STD = NEURAL_META.standardisation.std;

/** Uniform segments the attribution path is split into before adaptive refinement. */
const IG_INITIAL_SEGMENTS = 16;

/** Numerically stable logistic function - Math.exp(-z) overflows for large negative z. */
function sigmoid(z) {
  if (z >= 0) {
    return 1 / (1 + Math.exp(-z));
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

/** z-score with the training-split statistics baked into this file. */
function standardise(featureVector) {
  const out = new Array(featureVector.length);
  for (let i = 0; i < featureVector.length; i += 1) {
    out[i] = (featureVector[i] - MEAN[i]) / STD[i];
  }
  return out;
}

/** y = W x + b, with W stored as [outputs][inputs]. */
function dense(input, layer) {
  const { weight, bias } = layer;
  const out = new Array(bias.length);
  for (let o = 0; o < bias.length; o += 1) {
    const row = weight[o];
    let sum = bias[o];
    for (let i = 0; i < input.length; i += 1) {
      sum += row[i] * input[i];
    }
    out[o] = sum;
  }
  return out;
}

function relu(values) {
  const out = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    out[i] = values[i] > 0 ? values[i] : 0;
  }
  return out;
}

/** Forward pass over already-standardised inputs. Retains pre-activations for the backward pass. */
function forwardStandardised(z) {
  const z1 = dense(z, NEURAL_WEIGHTS.l1);
  const a1 = relu(z1);
  const z2 = dense(a1, NEURAL_WEIGHTS.l2);
  const a2 = relu(z2);
  const logit = dense(a2, NEURAL_WEIGHTS.out)[0];
  return { z1, a1, z2, a2, logit };
}

/**
 * Identifies which linear region of the network a point falls in.
 *
 * A ReLU network is linear inside any region where the set of active units is fixed,
 * so the sign pattern of both hidden pre-activations IS the region identity. The
 * attribution code uses this to know when it can stop subdividing and integrate
 * analytically.
 */
function regionKey(z1, z2) {
  let key = '';
  for (let i = 0; i < z1.length; i += 1) key += z1[i] > 0 ? '1' : '0';
  key += ':';
  for (let i = 0; i < z2.length; i += 1) key += z2[i] > 0 ? '1' : '0';
  return key;
}

/**
 * Gradient of the output logit with respect to the standardised inputs.
 * Hand-rolled backprop through out -> relu -> l2 -> relu -> l1.
 */
function inputGradientFrom(z1, z2) {
  // d logit / d a2 is just the output layer's weight row.
  const gradA2 = NEURAL_WEIGHTS.out.weight[0];

  const gradZ2 = new Array(z2.length);
  for (let i = 0; i < z2.length; i += 1) {
    gradZ2[i] = z2[i] > 0 ? gradA2[i] : 0;
  }

  const gradA1 = new Array(z1.length).fill(0);
  for (let o = 0; o < gradZ2.length; o += 1) {
    const row = NEURAL_WEIGHTS.l2.weight[o];
    const g = gradZ2[o];
    if (g === 0) continue;
    for (let i = 0; i < gradA1.length; i += 1) {
      gradA1[i] += g * row[i];
    }
  }

  const gradZ1 = new Array(z1.length);
  for (let i = 0; i < z1.length; i += 1) {
    gradZ1[i] = z1[i] > 0 ? gradA1[i] : 0;
  }

  const gradInput = new Array(NEURAL_WEIGHTS.l1.weight[0].length).fill(0);
  for (let o = 0; o < gradZ1.length; o += 1) {
    const row = NEURAL_WEIGHTS.l1.weight[o];
    const g = gradZ1[o];
    if (g === 0) continue;
    for (let i = 0; i < gradInput.length; i += 1) {
      gradInput[i] += g * row[i];
    }
  }

  return gradInput;
}

/**
 * Scores a patient with the neural model.
 *
 * Synchronous and allocation-light on purpose: the PWA calls this inside the form's
 * submit handler, before the record is written to IndexedDB, with no network.
 *
 * @param {number[]} featureVector values ordered as NEURAL_FEATURE_ORDER
 * @returns {{probability: number, logit: number}}
 */
export function predictWithNetwork(featureVector) {
  if (!Array.isArray(featureVector) || featureVector.length !== NEURAL_FEATURE_ORDER.length) {
    throw new Error(
      `predictWithNetwork expects ${NEURAL_FEATURE_ORDER.length} features ordered as ${NEURAL_FEATURE_ORDER.join(', ')}`,
    );
  }
  const { logit } = forwardStandardised(standardise(featureVector));
  return { probability: sigmoid(logit), logit };
}

/**
 * Exact path integral of the input gradient from the baseline to the patient.
 *
 * Integrated gradients needs the average gradient along the straight line between
 * two points. Because a ReLU network is piecewise linear, that gradient is piecewise
 * CONSTANT in the path parameter, and the integral over each linear piece is just
 * (width x gradient) with no approximation error at all.
 *
 * The pieces are found by bisection on the ReLU sign pattern: if both ends of an
 * interval, and its midpoint, lie in the same linear region, the gradient cannot vary
 * inside it, so the piece is integrated in closed form. Otherwise the interval
 * straddles at least one kink and is split.
 *
 * This replaced a fixed 64-step midpoint sum, which left a completeness residual of
 * around 4.7e-2 — a few percent of the logit range — precisely because kinks landed
 * mid-interval. It is both exact and typically cheaper, since one path crosses only
 * a handful of the 24 possible kinks.
 *
 * @returns {{integral: number[], regionsVisited: number}}
 */
function integrateGradient(baseline, delta, maxDepth) {
  const nInputs = baseline.length;
  const integral = new Array(nInputs).fill(0);
  let regionsVisited = 0;

  const probe = (alpha) => {
    const point = new Array(nInputs);
    for (let i = 0; i < nInputs; i += 1) {
      point[i] = baseline[i] + alpha * delta[i];
    }
    const { z1, z2 } = forwardStandardised(point);
    return { alpha, key: regionKey(z1, z2), gradient: inputGradientFrom(z1, z2) };
  };

  const addPiece = (width, gradient) => {
    regionsVisited += 1;
    for (let i = 0; i < nInputs; i += 1) {
      integral[i] += width * gradient[i];
    }
  };

  const walk = (lo, hi, depth) => {
    const mid = probe((lo.alpha + hi.alpha) / 2);
    // One linear region across the whole interval: the gradient is constant, so the
    // midpoint sample integrates the piece exactly.
    if (depth >= maxDepth || (lo.key === mid.key && mid.key === hi.key)) {
      addPiece(hi.alpha - lo.alpha, mid.gradient);
      return;
    }
    walk(lo, mid, depth + 1);
    walk(mid, hi, depth + 1);
  };

  /**
   * Bisection alone can step over a thin region when the sign pattern coincides at
   * all three sample points of an interval. Starting from a uniform subdivision
   * rather than the whole [0, 1] segment makes that far less likely, for a handful
   * of extra forward passes.
   */
  let previous = probe(0);
  for (let s = 1; s <= IG_INITIAL_SEGMENTS; s += 1) {
    const next = probe(s / IG_INITIAL_SEGMENTS);
    walk(previous, next, 0);
    previous = next;
  }

  return { integral, regionsVisited };
}

/**
 * Per-feature attributions via integrated gradients.
 *
 * Integrated gradients attributes the change in the output logit, relative to a
 * baseline patient, across the eight inputs. The baseline is the MEDIAN patient of
 * the training split, so a contribution reads as "how much this reading moved the
 * score away from a typical patient's" rather than away from an all-zeros patient
 * that could not exist.
 *
 * The method satisfies completeness: the attributions sum exactly to
 * logit(patient) - logit(baseline), so nothing about the score is left unexplained.
 * `completenessGap` reports the residual and is asserted at export time; it sits at
 * floating-point noise rather than at a discretisation error, because the integral
 * is evaluated exactly (see integrateGradient below) rather than sampled.
 *
 * NOTE ON `familyHistory`: it is a 0/1 feature whose training-split median is 0.5,
 * so its baseline sits between the two values it can actually take. That is the
 * correct neutral reference for attribution, but it means a "no family history"
 * answer produces a small NEGATIVE contribution rather than exactly zero.
 *
 * @param {number[]} featureVector values ordered as NEURAL_FEATURE_ORDER
 * @param {{maxDepth?: number}} [options]
 * @returns {{
 *   attributions: Array<{feature: string, contribution: number, share: number, direction: 'increases'|'decreases'|'neutral'}>,
 *   logit: number,
 *   baselineLogit: number,
 *   completenessGap: number,
 *   regionsVisited: number
 * }}
 */
export function attributionsFor(featureVector, options = {}) {
  if (!Array.isArray(featureVector) || featureVector.length !== NEURAL_FEATURE_ORDER.length) {
    throw new Error(
      `attributionsFor expects ${NEURAL_FEATURE_ORDER.length} features ordered as ${NEURAL_FEATURE_ORDER.join(', ')}`,
    );
  }

  const maxDepth =
    Number.isInteger(options.maxDepth) && options.maxDepth > 0
      ? options.maxDepth
      : NEURAL_META.attributionMaxDepth;

  const target = standardise(featureVector);
  const baseline = standardise(NEURAL_META.attributionBaseline);

  const delta = new Array(target.length);
  for (let i = 0; i < target.length; i += 1) {
    delta[i] = target[i] - baseline[i];
  }

  const { integral, regionsVisited } = integrateGradient(baseline, delta, maxDepth);

  let totalAbsolute = 0;
  const raw = new Array(target.length);
  for (let i = 0; i < target.length; i += 1) {
    raw[i] = delta[i] * integral[i];
    totalAbsolute += Math.abs(raw[i]);
  }

  const logit = forwardStandardised(target).logit;
  const baselineLogit = forwardStandardised(baseline).logit;

  let attributed = 0;
  for (let i = 0; i < raw.length; i += 1) attributed += raw[i];

  const attributions = NEURAL_FEATURE_ORDER.map((feature, i) => ({
    feature,
    contribution: Math.round(raw[i] * 1e6) / 1e6,
    share: totalAbsolute > 0 ? Math.round((Math.abs(raw[i]) / totalAbsolute) * 1e4) / 1e4 : 0,
    direction: raw[i] > 1e-9 ? 'increases' : raw[i] < -1e-9 ? 'decreases' : 'neutral',
  })).sort((a, b) => Math.abs(b.contribution) - Math.abs(a.contribution));

  return {
    attributions,
    logit,
    baselineLogit,
    completenessGap: logit - baselineLogit - attributed,
    regionsVisited,
  };
}

/** Maps a neural probability to a risk band using the same cut-offs as the tree. */
export function neuralBandForProbability(probability) {
  if (probability >= NEURAL_META.riskBands.high) return 'HIGH';
  if (probability >= NEURAL_META.riskBands.moderate) return 'MODERATE';
  return 'LOW';
}
