/* eslint-disable */
/**
 * AUTO-GENERATED FILE - DO NOT EDIT BY HAND.
 * Regenerate with:  node ml/train_model.mjs   (or: python ml/train_model.py)
 *
 * Diabetes early-risk decision tree, trained on the Pima Indians Diabetes dataset
 * and ported to plain JavaScript so the same logic runs in the browser (offline,
 * inside the service-worker-cached PWA bundle) and on the Express API. There is no
 * Python service in the request path.
 *
 * Generated: 2026-08-07T20:26:35.239Z
 * Held-out accuracy: 71.4% | recall: 77.8% | ROC-AUC: 0.8064
 *
 * DATASET LIMITATION: trained on adult Pima Native American women, not an Indian
 * cohort. Feature-risk directions are medically valid cross-population, but the
 * absolute cut-offs are not calibrated for India. Prototype only.
 *
 *   Decision tree (<= goes left):
 *   glucose <= 123.5 ?  [n=614]
 *   yes-> age <= 28.5 ?  [n=358]
 *      yes-> bmi <= 33.25 ?  [n=204]
 *         yes-> pregnancies <= 2.5 ?  [n=128]
 *            yes-> LEAF risk=0.0% band=LOW n=91 (0 diabetic)
 *            no -> LEAF risk=14.2% band=LOW n=37 (3 diabetic)
 *         no -> diastolicBp <= 75 ?  [n=76]
 *            yes-> LEAF risk=22.9% band=LOW n=51 (7 diabetic)
 *            no -> LEAF risk=37.1% band=MODERATE n=25 (6 diabetic)
 *      no -> bmi <= 26.35 ?  [n=154]
 *         yes-> LEAF risk=0.0% band=LOW n=33 (0 diabetic)
 *         no -> glucose <= 100.5 ?  [n=121]
 *            yes-> LEAF risk=22.3% band=LOW n=45 (6 diabetic)
 *            no -> LEAF risk=66.3% band=HIGH n=76 (39 diabetic)
 *   no -> bmi <= 30.05 ?  [n=256]
 *      yes-> age <= 26.5 ?  [n=78]
 *         yes-> LEAF risk=9.0% band=LOW n=20 (1 diabetic)
 *         no -> age <= 50.5 ?  [n=58]
 *            yes-> LEAF risk=67.5% band=HIGH n=38 (20 diabetic)
 *            no -> LEAF risk=38.4% band=MODERATE n=20 (5 diabetic)
 *      no -> glucose <= 157.5 ?  [n=178]
 *         yes-> insulin <= 192 ?  [n=104]
 *            yes-> LEAF risk=79.2% band=HIGH n=79 (53 diabetic)
 *            no -> LEAF risk=59.5% band=MODERATE n=25 (11 diabetic)
 *         no -> familyHistory <= 0.5 ?  [n=74]
 *            yes-> LEAF risk=85.5% band=HIGH n=29 (22 diabetic)
 *            no -> LEAF risk=95.0% band=HIGH n=45 (41 diabetic)
 */

/** Feature vector order expected by the tree. */
export const FEATURE_ORDER = ["glucose","diastolicBp","bmi","age","pregnancies","familyHistory","skinThickness","insulin"];

/** Model provenance, imputation defaults and risk banding, kept next to the tree. */
export const MODEL_META = {
  "generatedAt": "2026-08-07T20:26:35.239Z",
  "algorithm": "DecisionTreeClassifier-equivalent CART",
  "hyperparameters": {
    "criterion": "gini",
    "maxDepth": 4,
    "minSamplesLeaf": 20,
    "classWeight": "balanced",
    "randomSeed": 42,
    "testFraction": 0.2
  },
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
  "imputationMedians": {
    "Glucose": 117,
    "BloodPressure": 72,
    "SkinThickness": 30,
    "Insulin": 125,
    "BMI": 32.3
  },
  "pedigreeThreshold": 0.3815,
  "riskBands": {
    "high": 0.6,
    "moderate": 0.3
  },
  "featureImportances": {
    "glucose": 0.583962,
    "diastolicBp": 0.004604,
    "bmi": 0.220576,
    "age": 0.169083,
    "pregnancies": 0.006396,
    "familyHistory": 0.003202,
    "skinThickness": 0,
    "insulin": 0.012175
  },
  "metrics": {
    "train": {
      "accuracy": 0.7818,
      "precision": 0.637,
      "recall": 0.8692,
      "specificity": 0.735,
      "f1": 0.7352,
      "confusionMatrix": {
        "truePositive": 186,
        "falsePositive": 106,
        "trueNegative": 294,
        "falseNegative": 28
      },
      "rocAuc": 0.8705
    },
    "test": {
      "accuracy": 0.7143,
      "precision": 0.5676,
      "recall": 0.7778,
      "specificity": 0.68,
      "f1": 0.6563,
      "confusionMatrix": {
        "truePositive": 42,
        "falsePositive": 32,
        "trueNegative": 68,
        "falseNegative": 12
      },
      "rocAuc": 0.8064
    }
  },
  "dataset": {
    "name": "Pima Indians Diabetes Database",
    "records": 768,
    "knownLimitation": "Cohort is adult Pima Native American women. Not representative of rural India. Prototype only; retrain on ICMR-INDIAB or NFHS-5 before any real deployment."
  }
};

/**
 * Field-collected values that are frequently unavailable at a village health post.
 * When absent the dataset's training-split median is substituted, and the risk
 * result reports that substitution so nobody mistakes a default for a measurement.
 */
export const IMPUTED_WHEN_MISSING = {
  skinThickness: 30,
  insulin: 125,
};

/** The fitted tree. `<=` traverses left, `>` traverses right. */
export const DECISION_TREE = {
  "id": 0,
  "depth": 0,
  "samples": 614,
  "rawPositives": 214,
  "rawNegatives": 400,
  "weightedPositives": 307,
  "weightedNegatives": 307,
  "probability": 0.5,
  "rawPositiveRate": 0.348534,
  "impurity": 0.5,
  "type": "split",
  "feature": "glucose",
  "featureIndex": 0,
  "threshold": 123.5,
  "gain": 0.104711,
  "left": {
    "id": 1,
    "depth": 1,
    "samples": 358,
    "rawPositives": 61,
    "rawNegatives": 297,
    "weightedPositives": 87.509346,
    "weightedNegatives": 227.9475,
    "probability": 0.277405,
    "rawPositiveRate": 0.170391,
    "impurity": 0.400903,
    "type": "split",
    "feature": "age",
    "featureIndex": 3,
    "threshold": 28.5,
    "gain": 0.044334,
    "left": {
      "id": 2,
      "depth": 2,
      "samples": 204,
      "rawPositives": 16,
      "rawNegatives": 188,
      "weightedPositives": 22.953271,
      "weightedNegatives": 144.29,
      "probability": 0.137245,
      "rawPositiveRate": 0.078431,
      "impurity": 0.236817,
      "type": "split",
      "feature": "bmi",
      "featureIndex": 2,
      "threshold": 33.25,
      "gain": 0.026614,
      "left": {
        "id": 3,
        "depth": 3,
        "samples": 128,
        "rawPositives": 3,
        "rawNegatives": 125,
        "weightedPositives": 4.303738,
        "weightedNegatives": 95.9375,
        "probability": 0.042934,
        "rawPositiveRate": 0.023438,
        "impurity": 0.082181,
        "type": "split",
        "feature": "pregnancies",
        "featureIndex": 4,
        "threshold": 2.5,
        "gain": 0.00847,
        "left": {
          "id": 4,
          "depth": 4,
          "samples": 91,
          "rawPositives": 0,
          "rawNegatives": 91,
          "weightedPositives": 0,
          "weightedNegatives": 69.8425,
          "probability": 0,
          "rawPositiveRate": 0,
          "impurity": 0,
          "type": "leaf"
        },
        "right": {
          "id": 5,
          "depth": 4,
          "samples": 37,
          "rawPositives": 3,
          "rawNegatives": 34,
          "weightedPositives": 4.303738,
          "weightedNegatives": 26.095,
          "probability": 0.141576,
          "rawPositiveRate": 0.081081,
          "impurity": 0.243065,
          "type": "leaf"
        }
      },
      "right": {
        "id": 6,
        "depth": 3,
        "samples": 76,
        "rawPositives": 13,
        "rawNegatives": 63,
        "weightedPositives": 18.649533,
        "weightedNegatives": 48.3525,
        "probability": 0.278343,
        "rawPositiveRate": 0.171053,
        "impurity": 0.401736,
        "type": "split",
        "feature": "diastolicBp",
        "featureIndex": 1,
        "threshold": 75,
        "gain": 0.009122,
        "left": {
          "id": 7,
          "depth": 4,
          "samples": 51,
          "rawPositives": 7,
          "rawNegatives": 44,
          "weightedPositives": 10.042056,
          "weightedNegatives": 33.77,
          "probability": 0.229208,
          "rawPositiveRate": 0.137255,
          "impurity": 0.353343,
          "type": "leaf"
        },
        "right": {
          "id": 8,
          "depth": 4,
          "samples": 25,
          "rawPositives": 6,
          "rawNegatives": 19,
          "weightedPositives": 8.607477,
          "weightedNegatives": 14.5825,
          "probability": 0.371172,
          "rawPositiveRate": 0.24,
          "impurity": 0.466807,
          "type": "leaf"
        }
      }
    },
    "right": {
      "id": 9,
      "depth": 2,
      "samples": 154,
      "rawPositives": 45,
      "rawNegatives": 109,
      "weightedPositives": 64.556075,
      "weightedNegatives": 83.6575,
      "probability": 0.435561,
      "rawPositiveRate": 0.292208,
      "impurity": 0.491695,
      "type": "split",
      "feature": "bmi",
      "featureIndex": 2,
      "threshold": 26.35,
      "gain": 0.078202,
      "left": {
        "id": 10,
        "depth": 3,
        "samples": 33,
        "rawPositives": 0,
        "rawNegatives": 33,
        "weightedPositives": 0,
        "weightedNegatives": 25.3275,
        "probability": 0,
        "rawPositiveRate": 0,
        "impurity": 0,
        "type": "leaf"
      },
      "right": {
        "id": 11,
        "depth": 3,
        "samples": 121,
        "rawPositives": 45,
        "rawNegatives": 76,
        "weightedPositives": 64.556075,
        "weightedNegatives": 58.33,
        "probability": 0.525333,
        "rawPositiveRate": 0.371901,
        "impurity": 0.498717,
        "type": "split",
        "feature": "glucose",
        "featureIndex": 0,
        "threshold": 100.5,
        "gain": 0.083344,
        "left": {
          "id": 12,
          "depth": 4,
          "samples": 45,
          "rawPositives": 6,
          "rawNegatives": 39,
          "weightedPositives": 8.607477,
          "weightedNegatives": 29.9325,
          "probability": 0.223339,
          "rawPositiveRate": 0.133333,
          "impurity": 0.346917,
          "type": "leaf"
        },
        "right": {
          "id": 13,
          "depth": 4,
          "samples": 76,
          "rawPositives": 39,
          "rawNegatives": 37,
          "weightedPositives": 55.948598,
          "weightedNegatives": 28.3975,
          "probability": 0.663322,
          "rawPositiveRate": 0.513158,
          "impurity": 0.446652,
          "type": "leaf"
        }
      }
    }
  },
  "right": {
    "id": 14,
    "depth": 1,
    "samples": 256,
    "rawPositives": 153,
    "rawNegatives": 103,
    "weightedPositives": 219.490654,
    "weightedNegatives": 79.0525,
    "probability": 0.735206,
    "rawPositiveRate": 0.597656,
    "impurity": 0.389356,
    "type": "split",
    "feature": "bmi",
    "featureIndex": 2,
    "threshold": 30.05,
    "gain": 0.044345,
    "left": {
      "id": 15,
      "depth": 2,
      "samples": 78,
      "rawPositives": 26,
      "rawNegatives": 52,
      "weightedPositives": 37.299065,
      "weightedNegatives": 39.91,
      "probability": 0.483092,
      "rawPositiveRate": 0.333333,
      "impurity": 0.499428,
      "type": "split",
      "feature": "age",
      "featureIndex": 3,
      "threshold": 26.5,
      "gain": 0.081071,
      "left": {
        "id": 16,
        "depth": 3,
        "samples": 20,
        "rawPositives": 1,
        "rawNegatives": 19,
        "weightedPositives": 1.434579,
        "weightedNegatives": 14.5825,
        "probability": 0.089566,
        "rawPositiveRate": 0.05,
        "impurity": 0.163087,
        "type": "leaf"
      },
      "right": {
        "id": 17,
        "depth": 3,
        "samples": 58,
        "rawPositives": 25,
        "rawNegatives": 33,
        "weightedPositives": 35.864486,
        "weightedNegatives": 25.3275,
        "probability": 0.586098,
        "rawPositiveRate": 0.431034,
        "impurity": 0.485174,
        "type": "split",
        "feature": "age",
        "featureIndex": 3,
        "threshold": 50.5,
        "gain": 0.035952,
        "left": {
          "id": 18,
          "depth": 4,
          "samples": 38,
          "rawPositives": 20,
          "rawNegatives": 18,
          "weightedPositives": 28.691589,
          "weightedNegatives": 13.815,
          "probability": 0.674992,
          "rawPositiveRate": 0.526316,
          "impurity": 0.438756,
          "type": "leaf"
        },
        "right": {
          "id": 19,
          "depth": 4,
          "samples": 20,
          "rawPositives": 5,
          "rawNegatives": 15,
          "weightedPositives": 7.172897,
          "weightedNegatives": 11.5125,
          "probability": 0.383877,
          "rawPositiveRate": 0.25,
          "impurity": 0.473031,
          "type": "leaf"
        }
      }
    },
    "right": {
      "id": 20,
      "depth": 2,
      "samples": 178,
      "rawPositives": 127,
      "rawNegatives": 51,
      "weightedPositives": 182.191589,
      "weightedNegatives": 39.1425,
      "probability": 0.823152,
      "rawPositiveRate": 0.713483,
      "impurity": 0.291146,
      "type": "split",
      "feature": "glucose",
      "featureIndex": 0,
      "threshold": 157.5,
      "gain": 0.013482,
      "left": {
        "id": 21,
        "depth": 3,
        "samples": 104,
        "rawPositives": 64,
        "rawNegatives": 40,
        "weightedPositives": 91.813084,
        "weightedNegatives": 30.7,
        "probability": 0.749415,
        "rawPositiveRate": 0.615385,
        "impurity": 0.375585,
        "type": "split",
        "feature": "insulin",
        "featureIndex": 7,
        "threshold": 192,
        "gain": 0.013192,
        "left": {
          "id": 22,
          "depth": 4,
          "samples": 79,
          "rawPositives": 53,
          "rawNegatives": 26,
          "weightedPositives": 76.03271,
          "weightedNegatives": 19.955,
          "probability": 0.792109,
          "rawPositiveRate": 0.670886,
          "impurity": 0.329345,
          "type": "leaf"
        },
        "right": {
          "id": 23,
          "depth": 4,
          "samples": 25,
          "rawPositives": 11,
          "rawNegatives": 14,
          "weightedPositives": 15.780374,
          "weightedNegatives": 10.745,
          "probability": 0.594916,
          "rawPositiveRate": 0.44,
          "impurity": 0.481982,
          "type": "leaf"
        }
      },
      "right": {
        "id": 24,
        "depth": 3,
        "samples": 74,
        "rawPositives": 63,
        "rawNegatives": 11,
        "weightedPositives": 90.378505,
        "weightedNegatives": 8.4425,
        "probability": 0.914568,
        "rawPositiveRate": 0.851351,
        "impurity": 0.156267,
        "type": "split",
        "feature": "familyHistory",
        "featureIndex": 5,
        "threshold": 0.5,
        "gain": 0.004302,
        "left": {
          "id": 25,
          "depth": 4,
          "samples": 29,
          "rawPositives": 22,
          "rawNegatives": 7,
          "weightedPositives": 31.560748,
          "weightedNegatives": 5.3725,
          "probability": 0.854535,
          "rawPositiveRate": 0.758621,
          "impurity": 0.24861,
          "type": "leaf"
        },
        "right": {
          "id": 26,
          "depth": 4,
          "samples": 45,
          "rawPositives": 41,
          "rawNegatives": 4,
          "weightedPositives": 58.817757,
          "weightedNegatives": 3.07,
          "probability": 0.950394,
          "rawPositiveRate": 0.911111,
          "impurity": 0.09429,
          "type": "leaf"
        }
      }
    }
  }
};

/**
 * Runs the tree over a feature vector.
 *
 * @param {number[]} featureVector values ordered as FEATURE_ORDER
 * @returns {{probability: number, leafId: number, samples: number, path: Array<{
 *   feature: string, operator: '<=' | '>', threshold: number, value: number}>}}
 */
export function predictWithTree(featureVector) {
  if (!Array.isArray(featureVector) || featureVector.length !== FEATURE_ORDER.length) {
    throw new Error(
      `predictWithTree expects ${FEATURE_ORDER.length} features ordered as ${FEATURE_ORDER.join(', ')}`,
    );
  }

  const path = [];
  let node = DECISION_TREE;

  while (node.type === 'split') {
    const value = featureVector[node.featureIndex];
    const goLeft = value <= node.threshold;
    path.push({
      feature: node.feature,
      operator: goLeft ? '<=' : '>',
      threshold: node.threshold,
      value,
    });
    node = goLeft ? node.left : node.right;
  }

  return {
    probability: node.probability,
    leafId: node.id,
    samples: node.samples,
    path,
  };
}

/** Maps a probability to a risk band using the trained cut-offs. */
export function bandForProbability(probability) {
  if (probability >= MODEL_META.riskBands.high) return 'HIGH';
  if (probability >= MODEL_META.riskBands.moderate) return 'MODERATE';
  return 'LOW';
}
