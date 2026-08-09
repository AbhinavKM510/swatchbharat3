# Diabetes risk model - training report

_Generated 2026-08-07T20:26:35.239Z by `ml/train_model.mjs (Node CART, gini, class_weight=balanced)`._

## Data

- **Dataset:** Pima Indians Diabetes Database (768 records, positive rate 34.9%)
- **Split:** 614 train / 154 held-out test, stratified, seed 42
- **Known limitation:** Cohort is adult Pima Native American women. Not representative of rural India. Prototype only; retrain on ICMR-INDIAB or NFHS-5 before any real deployment.

### Missing data handling

In this dataset a recorded `0` is physiologically impossible for several columns and
actually means "not measured". Those zeros are imputed with the **training-split**
median (not the full-dataset median, which would leak test information):

| Column | Rows recorded as 0 | Imputed value |
| --- | --- | --- |
| `Glucose` | 5 (0.7%) | 117 |
| `BloodPressure` | 35 (4.6%) | 72 |
| `SkinThickness` | 227 (29.6%) | 30 |
| `Insulin` | 374 (48.7%) | 125 |
| `BMI` | 11 (1.4%) | 32.3 |

`SkinThickness` and `Insulin` are the two features a village health worker usually
cannot collect. They stay in the model but default to the medians above, and the
risk result explicitly tells the user when a default was used.

### Family history

`DiabetesPedigreeFunction` is a continuous score derived from a family tree, which
is not collectable in the field. It is binarised **at training time** at the train
median (0.3815) into a yes/no `familyHistory` feature, so the
model is trained on exactly the question the form asks. This avoids train/serve skew.

## Model

DecisionTreeClassifier-equivalent CART - criterion `gini`,
`max_depth=4`,
`min_samples_leaf=20`,
`class_weight=balanced`.

Depth is capped at 4 on purpose: the whole point of
using a tree here is that every decision can be read back to a health worker as a
sentence. Class weighting is balanced because a screening tool should prefer a false
alarm over a missed case.

```
Decision tree (<= goes left):
glucose <= 123.5 ?  [n=614]
yes-> age <= 28.5 ?  [n=358]
   yes-> bmi <= 33.25 ?  [n=204]
      yes-> pregnancies <= 2.5 ?  [n=128]
         yes-> LEAF risk=0.0% band=LOW n=91 (0 diabetic)
         no -> LEAF risk=14.2% band=LOW n=37 (3 diabetic)
      no -> diastolicBp <= 75 ?  [n=76]
         yes-> LEAF risk=22.9% band=LOW n=51 (7 diabetic)
         no -> LEAF risk=37.1% band=MODERATE n=25 (6 diabetic)
   no -> bmi <= 26.35 ?  [n=154]
      yes-> LEAF risk=0.0% band=LOW n=33 (0 diabetic)
      no -> glucose <= 100.5 ?  [n=121]
         yes-> LEAF risk=22.3% band=LOW n=45 (6 diabetic)
         no -> LEAF risk=66.3% band=HIGH n=76 (39 diabetic)
no -> bmi <= 30.05 ?  [n=256]
   yes-> age <= 26.5 ?  [n=78]
      yes-> LEAF risk=9.0% band=LOW n=20 (1 diabetic)
      no -> age <= 50.5 ?  [n=58]
         yes-> LEAF risk=67.5% band=HIGH n=38 (20 diabetic)
         no -> LEAF risk=38.4% band=MODERATE n=20 (5 diabetic)
   no -> glucose <= 157.5 ?  [n=178]
      yes-> insulin <= 192 ?  [n=104]
         yes-> LEAF risk=79.2% band=HIGH n=79 (53 diabetic)
         no -> LEAF risk=59.5% band=MODERATE n=25 (11 diabetic)
      no -> familyHistory <= 0.5 ?  [n=74]
         yes-> LEAF risk=85.5% band=HIGH n=29 (22 diabetic)
         no -> LEAF risk=95.0% band=HIGH n=45 (41 diabetic)
```

### Feature importance

| Feature | Importance |
| --- | --- |
| `glucose` | 58.4% |
| `bmi` | 22.1% |
| `age` | 16.9% |
| `insulin` | 1.2% |
| `pregnancies` | 0.6% |
| `diastolicBp` | 0.5% |
| `familyHistory` | 0.3% |
| `skinThickness` | 0.0% |

### Metrics

| Metric | Train | Held-out test |
| --- | --- | --- |
| Accuracy | 78.2% | **71.4%** |
| Recall (sensitivity) | 86.9% | **77.8%** |
| Precision | 63.7% | 56.8% |
| Specificity | 73.5% | 68.0% |
| F1 | 73.5% | 65.6% |
| ROC-AUC | 0.8705 | **0.8064** |

Held-out confusion matrix: TP 42,
FP 32,
TN 68,
FN 12.

### Risk bands on held-out data

Bands are applied to the leaf's class-balanced probability:
HIGH >= 0.6, MODERATE >= 0.3, otherwise LOW.

| Band | Patients | Actually diabetic | Rate |
| --- | --- | --- | --- |
| LOW | 74 | 11 | 14.9% |
| MODERATE | 14 | 3 | 21.4% |
| HIGH | 66 | 40 | 60.6% |

The bands separate monotonically, which is what makes them usable for triage: a
patient in HIGH is meaningfully more likely to be diabetic than one in LOW.

## Leaves

| Leaf | Risk | Band | Train n | of which diabetic | Path |
| --- | --- | --- | --- | --- | --- |
| 26 | 95.0% | HIGH | 45 | 41 | glucose > 123.5 AND bmi > 30.05 AND glucose > 157.5 AND familyHistory > 0.5 |
| 25 | 85.5% | HIGH | 29 | 22 | glucose > 123.5 AND bmi > 30.05 AND glucose > 157.5 AND familyHistory <= 0.5 |
| 22 | 79.2% | HIGH | 79 | 53 | glucose > 123.5 AND bmi > 30.05 AND glucose <= 157.5 AND insulin <= 192 |
| 18 | 67.5% | HIGH | 38 | 20 | glucose > 123.5 AND bmi <= 30.05 AND age > 26.5 AND age <= 50.5 |
| 13 | 66.3% | HIGH | 76 | 39 | glucose <= 123.5 AND age > 28.5 AND bmi > 26.35 AND glucose > 100.5 |
| 23 | 59.5% | MODERATE | 25 | 11 | glucose > 123.5 AND bmi > 30.05 AND glucose <= 157.5 AND insulin > 192 |
| 19 | 38.4% | MODERATE | 20 | 5 | glucose > 123.5 AND bmi <= 30.05 AND age > 26.5 AND age > 50.5 |
| 8 | 37.1% | MODERATE | 25 | 6 | glucose <= 123.5 AND age <= 28.5 AND bmi > 33.25 AND diastolicBp > 75 |
| 7 | 22.9% | LOW | 51 | 7 | glucose <= 123.5 AND age <= 28.5 AND bmi > 33.25 AND diastolicBp <= 75 |
| 12 | 22.3% | LOW | 45 | 6 | glucose <= 123.5 AND age > 28.5 AND bmi > 26.35 AND glucose <= 100.5 |
| 5 | 14.2% | LOW | 37 | 3 | glucose <= 123.5 AND age <= 28.5 AND bmi <= 33.25 AND pregnancies > 2.5 |
| 16 | 9.0% | LOW | 20 | 1 | glucose > 123.5 AND bmi <= 30.05 AND age <= 26.5 |
| 4 | 0.0% | LOW | 91 | 0 | glucose <= 123.5 AND age <= 28.5 AND bmi <= 33.25 AND pregnancies <= 2.5 |
| 10 | 0.0% | LOW | 33 | 0 | glucose <= 123.5 AND age > 28.5 AND bmi <= 26.35 |
