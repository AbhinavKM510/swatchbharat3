# Neural second opinion - training report

_Generated 2026-08-08T20:59:37.304431+00:00 by `ml/train_neural.py (PyTorch 2.13.0+cpu) + ml/export_neural.mjs`._

> **This model does not decide the risk band.** The decision tree does. See
> `ml/reports/training_report.md` for the tree, and `ml/README.md` for why the
> tree was kept as primary.

## Model

MLP 8-16-8-1, ReLU, sigmoid output — 289 parameters, trained with
pytorch 2.13.0+cpu.

| Hyperparameter | Value |
| --- | --- |
| Hidden layers | [16,8] |
| Activation | relu |
| Optimiser | adam (lr 0.01, weight decay 0.0001) |
| Loss | BCEWithLogitsLoss |
| Positive class weight | 1.869159 |
| Epochs | 49 |
| Batch | full |
| Seed | 42 |

### Epoch selection

best validation ROC-AUC on a stratified 20% slice of the train split. Best epoch **49**
at validation ROC-AUC 0.7991.

The held-out test split was not used to choose any hyperparameter.

## Metrics, and how they were measured

Every number below was computed by the **exported JavaScript** forward pass over the
held-out split, not by pytorch. The artefact the app serves is the
JavaScript one; PyTorch trains in float32 and the browser evaluates in float64, so
publishing the framework's own metrics would describe something that is not shipped.

| Held-out metric | Neural | Tree | Better |
| --- | --- | --- | --- |
| Accuracy | 0.7143 | 0.7143 | tie |
| Recall (sensitivity) | 0.7222 | 0.7778 | tree |
| Precision | 0.5735 | 0.5676 | neural |
| Specificity | 0.7100 | 0.6800 | neural |
| F1 | 0.6393 | 0.6563 | tree |
| ROC-AUC | 0.8163 | 0.8064 | neural |

Held-out confusion matrix: TP 39,
FP 29,
TN 71,
FN 15.

### Agreement with the training framework

| Check | Result |
| --- | --- |
| Reference | pytorch 2.13.0+cpu |
| Max probability delta over the held-out split | 9.172e-8 |
| Tolerance before export is refused | 0.00001 |

A delta at this magnitude is float32-to-float64 rounding. Anything larger would mean
the JavaScript forward pass is not the function the optimiser fitted, and
`export_neural.mjs` refuses to write in that case.

## Risk bands on held-out data

Same cut-offs as the tree: HIGH >= 0.6,
MODERATE >= 0.3, otherwise LOW.

| Band | Neural patients | of which diabetic | Tree patients | of which diabetic |
| --- | --- | --- | --- | --- |
| LOW | 63 (40.9%) | 12.7% | 74 (48.1%) | 14.9% |
| MODERATE | 36 (23.4%) | 30.6% | 14 (9.1%) | 21.4% |
| HIGH | 55 (35.7%) | 63.6% | 66 (42.9%) | 60.6% |

Both models separate monotonically, which is what makes a band usable for triage. The
neural model's MODERATE band is the better populated of the two.

## Feature importance

Neural importance is the mean absolute integrated-gradient attribution over the
training split, computed with the shipped attribution code. The tree's is weighted gini
impurity decrease. **These are different quantities and are not directly comparable** —
the table is here because the pattern of what each model ignores is informative.

| Feature | Neural (mean \|IG\|) | Tree (impurity) |
| --- | --- | --- |
| `glucose` | 39.0% | 58.4% |
| `bmi` | 23.6% | 22.1% |
| `pregnancies` | 12.2% | 0.6% |
| `familyHistory` | 8.7% | 0.3% |
| `age` | 7.4% | 16.9% |
| `diastolicBp` | 4.3% | 0.5% |
| `insulin` | 2.5% | 1.2% |
| `skinThickness` | 2.4% | 0.0% |

A depth-4 tree can only speak about the features it split on. The attribution method
gives every feature a value, which is the main reason this model is worth shipping
alongside the tree.

## Attributions

Method: integrated gradients, integrated exactly by subdividing the path at ReLU kinks.

Baseline (the comparison patient) is the median of the training split:

| Feature | Baseline |
| --- | --- |
| `glucose` | 117 |
| `diastolicBp` | 72 |
| `bmi` | 32.3 |
| `age` | 29 |
| `pregnancies` | 3 |
| `familyHistory` | 0.5 |
| `skinThickness` | 30 |
| `insulin` | 125 |

| Property | Value |
| --- | --- |
| Worst completeness residual across the training split | 9.953e-9 |
| Linear regions integrated per path (mean / max) | 221.79 / 383 |

Completeness means the attributions sum to `logit(patient) - logit(baseline)`, so no
part of the score is left unexplained. The residual is float noise rather than
discretisation error, because a ReLU network is piecewise linear and the path integral
is evaluated exactly on each linear piece instead of being sampled.

### Reading an attribution correctly

Two things follow from using the training median as the baseline:

1. **A feature that was not measured contributes exactly 0.0.** The imputed value *is*
   the baseline, so the delta is zero. A default tells the model nothing and the
   attribution says so.
2. **Contributions are relative to the Pima cohort, not to Indian clinical ranges.**
   BMI 31 can attribute negatively because the cohort median is
   32.3, while the
   plain-language reasons correctly call BMI 31 obese against the Indian cut-off of 25.
   Always display the baseline next to the value, and keep the clinical reasons primary.

## Dataset and limitation

Pima Indians Diabetes Database — 768 records,
614 train / 154 held out.

Cohort is adult Pima Native American women. Not representative of rural India. Prototype only; retrain on ICMR-INDIAB or NFHS-5 before any real deployment.

The same caveat as the tree, and for the same reason: the direction of each
relationship transfers across populations, the calibration does not.
