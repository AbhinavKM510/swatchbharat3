# `ml/` — risk model training and export

This folder trains the diabetes early-risk model and exports it as **plain
JavaScript**. Nothing in this folder runs at request time.

Two models are trained here. The **decision tree decides the risk band**; the
**neural network is a second opinion and the source of per-feature attributions**.
Both ship as plain JavaScript.

```
ml/
├── train_model.py            reference scikit-learn trainer (tree)
├── train_model.mjs           equivalent Node trainer (tree) - produced the shipped artefact
├── compare_trainers.py       read-only: Node CART vs scikit-learn
│
├── prepare_dataset.mjs       shared train/test split, read by every trainer
├── train_neural.py           PyTorch MLP - produces the shipped second opinion
├── train_neural_tf.py        Keras MLP - cross-validation only, never served
├── export_neural.mjs         renders + measures shared/risk/neural_model.js
├── verify_neural.mjs         read-only re-verification of the committed artefact
├── compare_models.py         read-only: tree vs PyTorch vs Keras, + promotion gate
│
├── lib/cart.mjs              the ~330-line CART implementation used by the Node trainer
├── lib/dataset.mjs           loading, stratified split, imputation, band summaries
├── lib/metrics.py            metrics shared by the Python trainers (mirrors cart.mjs)
├── requirements.txt          Python deps (training only)
├── data/                     dataset
├── export/                   generated artefacts + metadata
└── reports/                  training_report.md (metrics, ASCII tree, leaf table)
```

Quick reference:

| Command | Effect |
| --- | --- |
| `npm run ml:verify` | Re-check the committed neural artefact. Read-only, no Python. |
| `npm run ml:compare:all` | Three-way comparison + promotion gate. Read-only, stdlib only. |
| `npm run ml:compare` | Node CART vs scikit-learn. Read-only. |
| `npm run train` | Retrain the tree. **Overwrites the shipped tree.** |
| `npm run ml:neural` | Retrain the neural model. **Overwrites the shipped second opinion.** |

## Why the model is exported to JavaScript

Two reasons, both practical:

1. **The prediction has to work offline.** An ASHA worker in a village with no signal
   still needs a risk result. A Python inference service cannot be reached; a function
   inside the service-worker-cached PWA bundle can.
2. **One less deployable service.** No Python process in the request path means one
   less thing that can be down during the demo.

The trained tree is written to `export/decision_tree_rules.js` and synced to
`shared/risk/decision_tree_rules.js`, which both the React app and the Express API
import. Same tree, same thresholds, same result on both sides.

The neural model follows the identical pattern: `export/neural_model.js` and
`shared/risk/neural_model.js`. It is **289 numbers and about eighty lines of
arithmetic** — a hand-written forward pass plus an attribution routine. No tensor
runtime is bundled.

That is worth being explicit about, because the obvious alternative is worse in every
dimension that matters here. Shipping `@tensorflow/tfjs` would add roughly a megabyte
to a 466 KB bundle; `loadLayersModel` is asynchronous, so it would break the
synchronous scoring the form's submit handler depends on; a `.bin` weights file is not
matched by the service worker's `globPatterns` (`js,css,html,svg,png,woff2`), so
offline first-run inference would silently fail; and a WebGL backend in the browser
against a native backend on the API would produce different floats for the same
patient, which the sync layer would flag as a model mismatch on every single record.
Exporting the weights as JavaScript avoids all four.

## Retraining

```bash
# Reference path (scikit-learn)
python -m pip install -r ml/requirements.txt
python ml/train_model.py

# Equivalent, no Python required
node ml/train_model.mjs
```

Both write the same four artefacts. They use the same criterion, depth cap, leaf
minimum, class weighting and imputation strategy, but the shuffling inside their
stratified splits differs, so expect **equivalent, not bit-identical** trees.

## Cross-validation: Node vs scikit-learn

Both trainers have now been run on the same dataset and the same hyperparameters
(`gini`, `max_depth=4`, `min_samples_leaf=20`, `class_weight="balanced"`, seed 42).
Verified on Python 3.14.7 with numpy 2.5.1 / pandas 3.0.5 / scikit-learn 1.9.0.

| Held-out metric | Node CART (shipped) | scikit-learn |
| --- | --- | --- |
| Accuracy | **0.7143** | **0.7143** |
| Recall | 0.7778 | 0.8519 |
| Precision | 0.5676 | 0.5610 |
| Specificity | 0.68 | 0.64 |
| ROC-AUC | 0.8064 | 0.8013 |
| Leaves / nodes | 14 / 27 | 14 / 27 |

**Accuracy matches to four decimal places, and both fit trees of identical size.** That
is the result that matters: it is independent evidence that the from-scratch CART in
`lib/cart.mjs` implements the same algorithm scikit-learn does, rather than something
that merely looks like it.

Recall and specificity differ because the two stratified splits shuffle differently, so
each tree sees a slightly different 614-row training set. Same method, different draw.

### Why the Node artefact is the one shipped

Not because it scores better overall — scikit-learn's recall is genuinely higher. Two
concrete reasons:

1. **Three usable risk bands instead of two.** The scikit-learn tree's leaf
   probabilities cluster away from the MODERATE window: only 1 of its 14 leaves can
   produce MODERATE, and on held-out data just 2 patients out of 154 (1.3%) landed
   there. The Node tree spreads 3 leaves across MODERATE and puts 14 patients in it.
   A triage tool whose middle band is statistically empty is a two-band tool.
2. **The explanation stays faithful to the decision.** The Node tree's path for a
   typical high-risk patient reads `glucose > 123.5 → bmi > 30.05 → glucose > 157.5 →
   familyHistory > 0.5`, which lines up with the plain-language reasons shown to the
   worker. The scikit-learn tree assigns `familyHistory` an importance of **0.0** and
   never splits on it, so its path is glucose three times plus pregnancies. The
   clinical reasons would still be correct (they come from reference ranges, not the
   tree), but "how the model decided" would no longer corroborate them.

Both artefacts are reproducible on demand. `python ml/train_model.py` regenerates the
scikit-learn version in seconds if you want to inspect or compare it.

> Status note: `train_model.mjs` is the trainer that produced the currently committed
> artefacts, and remains the canonical one.
>
> `train_model.py` **has now been executed and verified** against scikit-learn 1.9.0.
> It produces the same artefact format and comparable metrics (held-out accuracy 71.4%,
> identical to the Node trainer; recall 85.2% vs 77.8%, differing because the two
> stratified splits shuffle differently). Running it independently confirmed the tree is
> genuinely fitted from the data rather than hand-written.
>
> One real bug was found and fixed in the process: the per-leaf raw diabetic counts were
> derived from `sklearn`'s `tree_.value` on the assumption that it stores class-weighted
> counts. In current scikit-learn it stores **row-normalised proportions**, so dividing
> by the class weights produced near-zero counts on every leaf — a leaf at 98% risk
> reported "0 diabetic". Raw counts are now computed directly from the training labels
> via `clf.decision_path()`, which is exact and independent of that internal
> representation. If you retrain and the leaf table looks implausible, check this first.

### Python version note

`requirements.txt` pins the versions this was validated against. Those pins have no
prebuilt wheels for Python 3.13+, so pip will try to compile numpy from source and fail
unless you have a modern C toolchain. On a newer interpreter, install unpinned instead:

```bash
python -m pip install --only-binary=:all: numpy pandas scikit-learn
```

The trainer does not use any version-specific API, so a current numpy/pandas/sklearn
works fine. Prefer a virtual environment (`python -m venv ml/.venv`) — `.venv/` is
already gitignored.

## The neural second opinion

An MLP — `8 inputs → z-score → Dense(16, ReLU) → Dense(8, ReLU) → Dense(1) → sigmoid`,
289 parameters — trained in PyTorch and exported to plain JavaScript.

**It does not decide the risk band.** The tree does. The network exists for two things
the tree cannot do:

1. **Attributions across all eight features.** A depth-4 tree explains itself with the
   at most four comparisons on the path it happened to take, and has nothing at all to
   say about the features it did not split on. It assigns `skinThickness` an importance
   of exactly 0.0. The network attributes every prediction across all eight inputs,
   signed, and the attributions sum exactly to the score.
2. **Disagreement as a triage signal.** When a depth-4 tree and a neural net put the
   same patient in different bands, that patient is near a decision boundary — which is
   precisely who a PHC doctor should look at first. The result object carries
   `secondOpinion.agreesWithPrimary` and a signed `bandDelta`.

### Pipeline

```bash
node ml/prepare_dataset.mjs      # shared split (writes only ml/export/dataset_split.json)
python ml/train_neural.py        # PyTorch fit (writes only ml/export/neural_weights.json)
node ml/export_neural.mjs        # renders + measures shared/risk/neural_model.js
node ml/verify_neural.mjs        # read-only re-verification
```

or `npm run ml:neural`, which chains all four.

Three deliberate properties of that pipeline:

**The split is prepared once, in Node, and shared.** Reproducing JavaScript's
`Math.imul` semantics and `Number.toFixed` rounding in Python to arrive at the same
614/154 rows is possible, but a silent off-by-a-few-rows divergence would make any
"model A beats model B" claim meaningless. `prepare_dataset.mjs` asserts that its
medians, family-history threshold and row counts match the committed
`model_metadata.json`, so the neural models are provably fitted on the same data as the
tree.

**The epoch count is chosen on a slice of the training split, never on the test set.**
Selecting epochs against held-out data is the most common way a small-dataset neural
result turns out to be inflated. Stage 1 fits on 491 rows and picks the best epoch by
validation ROC-AUC on 123; stage 2 refits on all 614 for exactly that many epochs.

**The published metrics are computed by the JavaScript, not by PyTorch.** PyTorch
trains in float32, the browser evaluates in float64, and the artefact that scores real
patients is the JavaScript one. `export_neural.mjs` renders the artefact, imports it,
runs *its* forward pass over the held-out split, and writes those numbers into
`NEURAL_META.metrics`. It also compares against the probabilities PyTorch exported and
refuses to write if they diverge by more than 1e-5. Measured divergence is **9.2e-8**,
i.e. float32 rounding and nothing else.

### Results

Held-out, 154 rows, identical rows for every model:

| Metric | CART tree (decides the band) | PyTorch MLP (shipped) | Keras MLP (check only) |
| --- | --- | --- | --- |
| Accuracy | **0.7143** | **0.7143** | 0.7208 |
| Recall | **0.7778** | 0.7222 | 0.7037 |
| Precision | 0.5676 | 0.5735 | 0.5846 |
| Specificity | 0.68 | 0.71 | 0.73 |
| ROC-AUC | 0.8064 | **0.8163** | 0.8374 |

Band spread, with the share of each band that really is diabetic:

| Band | CART tree | PyTorch MLP | Keras MLP |
| --- | --- | --- | --- |
| LOW | 74 (48.1%), 15% diabetic | 63 (40.9%), 13% | 67 (43.5%), 12% |
| MODERATE | 14 (9.1%), 21% | **36 (23.4%), 31%** | 31 (20.1%), 29% |
| HIGH | 66 (42.9%), 61% | 55 (35.7%), 64% | 56 (36.4%), 66% |

All three separate monotonically. Note the network's MODERATE band holds 23.4% of
patients against the tree's 9.1% — a genuinely better-populated middle band, which is
the exact axis on which scikit-learn's tree was rejected.

### Why it was not promoted to primary

Three criteria were fixed **before** training, and `npm run ml:compare:all` re-checks
them on every retrain so the decision stays auditable rather than becoming folklore:

| Criterion | Required | Actual | |
| --- | --- | --- | --- |
| ROC-AUC | ≥ 0.83 | 0.8163 | fail |
| Recall | ≥ 0.80 | 0.7222 | fail |
| MODERATE band share | ≥ 8% | 23.4% | pass |

Two of three not met, so the tree keeps the band. The honest summary is that the
network trades recall for specificity — it finds 39 of 54 diabetics where the tree
finds 42 — and for a screening tool whose whole justification is that a missed case is
worse than a false alarm, that is the wrong trade. Its better ROC-AUC says it ranks
patients slightly better overall; its worse recall says it is worse at the specific job.

Promotion would be one constant in `riskEngine.js`, plus a migration for the
tree-specific `leafId` / `leafTrainingSamples` fields persisted in Mongo and IndexedDB.

### Cross-validation: PyTorch vs TensorFlow

A 289-parameter model on 614 rows is exactly the setup where a plausible number comes
from a bug — a mis-signed loss, a leaked split, standardisation applied twice. So the
same architecture is fitted independently in Keras (`train_neural_tf.py`) on the same
rows, measured by the same code, and compared.

| Metric | Keras − PyTorch |
| --- | --- |
| Accuracy | +0.0065 |
| Precision | +0.0111 |
| Recall | −0.0185 |
| Specificity | +0.0200 |
| F1 | −0.0006 |
| ROC-AUC | +0.0211 |

Largest disagreement on any metric: **0.0211**. The two assign an identical band to
**83.8%** of held-out patients, and both produce monotonically separating bands.

The weights do *not* match, and are not expected to: Keras initialises Dense kernels
with Glorot-uniform and biases with zeros, PyTorch uses a Kaiming-flavoured uniform for
both, so the two runs start in different places and settle in different minima. Two
different minima of the same architecture landing within two points of each other on
held-out data is the evidence being sought. `train_neural_tf.py` writes only
`export/neural_weights_tf.json` and can never be served.

This mirrors what the project already does for the tree — hand-rolled CART against
scikit-learn — for the same reason.

### Attributions: integrated gradients, integrated exactly

Contributions come from integrated gradients along the straight path from a baseline
patient to the actual patient, with the baseline being the **median patient of the
training split**. A contribution therefore reads as "how far this reading moved the
score away from a typical patient's", rather than away from an all-zeros patient who
could not exist.

The first implementation used a 64-step midpoint Riemann sum and left a completeness
residual of **4.7e-2** — a few percent of the logit range. That was not a step-count
problem. A ReLU network is piecewise linear, so the gradient of the output with respect
to the input is piecewise **constant** along the path, and a fixed-step sum
mis-integrates every interval that happens to contain a kink; more steps shrink the
error only linearly.

The fix is to integrate exactly. The ReLU sign pattern of both hidden layers identifies
which linear region a point is in, so the path is subdivided while that pattern differs
between the ends of an interval and integrated in closed form once it does not. The
residual is now **9.95e-9**, and it is usually *cheaper* than 64 fixed steps because a
single path crosses only a handful of the 24 possible kinks. `verify_neural.mjs`
asserts completeness on every held-out patient.

Two consequences worth knowing before reading an attribution:

**Unmeasured features contribute exactly 0.0.** The value substituted for a missing
`skinThickness` or `insulin` *is* the baseline, so the delta is zero and so is the
attribution. A default tells the model nothing, and the explanation says so rather than
inventing an influence for a number nobody collected. This is a property of choosing
the median as the baseline, and it is a good one.

**A contribution is relative to the Pima cohort, not to Indian clinical ranges.** For
the scripted demo case, BMI 31 gets a small *negative* contribution — because the
training median BMI is 32.3, so 31 is slightly below average *for this cohort* — at the
same time as the reason list correctly reports "BMI 31 is in the obese range" against
the Indian cut-off of 25. Both statements are true. The UI therefore always shows the
baseline value next to the patient's value, and keeps the clinical reasons visually
primary, because the two numbers look contradictory otherwise. The same caveat applies
more sharply to `diastolicBp`, where the network has learned a small negative
coefficient that does not match clinical direction; it accounts for about 4% of
attributed movement and is displayed in the audit section, not as advice.

## Getting the dataset

`data/pima_indians_diabetes.csv` is the Pima Indians Diabetes Database (768 rows) with
a header row added. To re-download:

```bash
curl -o ml/data/pima_indians_diabetes.csv \
  https://raw.githubusercontent.com/jbrownlee/Datasets/master/pima-indians-diabetes.csv
# then prepend the header:
# Pregnancies,Glucose,BloodPressure,SkinThickness,Insulin,BMI,DiabetesPedigreeFunction,Age,Outcome
```

Original source: UCI Machine Learning Repository / National Institute of Diabetes and
Digestive and Kidney Diseases.

## Modelling decisions worth defending

**Why a decision tree decides the band, when a neural net is right there?**
Because the output of this system is a sentence a person acts on ("high risk because
blood sugar is 165 and BMI is 31"), and a depth-4 tree can be read back as at most four
comparisons. That was the original argument for a tree over a gradient-boosted model,
and adding the network has not weakened it — the network was measured against
pre-agreed criteria and did not meet them, principally because it trades away the recall
a screening tool exists to protect.

What the network did change is the honest scope of the claim. "A stronger model could
not tell a health worker why" was too strong: integrated gradients explain a neural net
across all eight features, exactly and additively, which is *more* than a tree's path
provides. The defensible claim is narrower and still true — a tree's explanation is the
decision itself rather than a post-hoc attribution of it, and it needs no baseline to
be interpreted. Both now ship, and the model card shows both.

**Why `class_weight="balanced"`?**
This is a screening tool. Missing a diabetic patient is worse than sending a healthy
one for a confirmatory test, so the fit is biased towards sensitivity. Held-out recall
is meaningfully higher than accuracy alone would suggest.

**Zeros are missing values, not measurements.**
`Glucose`, `BloodPressure`, `SkinThickness`, `Insulin` and `BMI` contain zeros that are
physiologically impossible. They are imputed with the **training-split** median (using
the full-dataset median would leak the test set).

**`SkinThickness` and `Insulin` stay in the model but are optional in the form.**
A village health post has no skinfold calliper and no insulin assay. Those two features
default to the training median, and the risk result explicitly lists which values were
substituted so a default is never mistaken for a measurement.

**Family history is binarised at training time.**
`DiabetesPedigreeFunction` is a continuous score computed from a family tree — not
collectable in the field. Rather than inventing a fake score from a yes/no answer at
serving time, the feature is binarised at the train-split median *during training*, so
the model learns from exactly the question the form asks. No train/serve skew.

**`Glucose` in this dataset is a 2-hour oral glucose tolerance test value**, not a
fasting reading. The form therefore asks which kind of measurement was taken and
interprets the plain-language category accordingly, while being clear that the model's
own numeric cut-offs came from 2-hour values.

## The limitation to state before anyone asks

The Pima cohort is **adult Pima Native American women**. It is not representative of a
rural Indian population — different genetic background, different diet, different body
composition at a given BMI, women only.

What survives the population change: the *direction and rough shape* of the
relationships (higher glucose, higher BMI, older age and family history all raise
diabetes risk). What does not survive: calibration. The specific numbers the tree
splits on should not be read as validated Indian thresholds.

That is why this is labelled a prototype in the UI itself, and why the plain-language
explanations use **Indian clinical reference ranges** (WHO Asian-Indian BMI cut-offs of
23/25 rather than 25/30) rather than the model's internal splits. Production would
retrain on ICMR-INDIAB or NFHS-5 style cohort data.

See `reports/training_report.md` for the current metrics, the full tree and the
per-leaf breakdown.
