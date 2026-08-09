"""Reference scikit-learn trainer for the diabetes early-risk decision tree.

    python -m pip install -r ml/requirements.txt
    python ml/train_model.py

Outputs (identical format to the Node trainer, ml/train_model.mjs):
    ml/export/decision_tree_rules.js    <- runtime artefact imported by frontend + backend
    ml/export/model_metadata.json       <- metrics, medians, thresholds, provenance
    ml/reports/training_report.md       <- human-readable summary
    shared/risk/decision_tree_rules.js  <- synced copy consumed by the apps

Why there are two trainers
--------------------------
The runtime risk engine is plain JavaScript so the prediction can run inside the
offline PWA with no Python service in the request path. `train_model.mjs` implements
the same CART fit in Node so the artefact can be regenerated on a machine without a
Python toolchain. This file is the reference implementation: scikit-learn is the
authority on the algorithm, and this is what you should run if you retrain on a real
Indian cohort.

The two trainers use the same criterion, depth cap, leaf minimum, class weighting and
imputation strategy. They do NOT produce a bit-identical tree, because the shuffling
inside their stratified train/test splits differs. Expect equivalent, not identical,
metrics.

DATA PROVENANCE / LIMITATION
----------------------------
The Pima Indians Diabetes dataset describes adult Pima Native American women. It is
not representative of a rural Indian population. The feature-to-risk directions it
encodes (glucose, BMI, age, family history) hold across populations, which makes it
defensible for a prototype, but the absolute cut-offs are not calibrated for India.
Retrain on ICMR-INDIAB / NFHS-5 style data before any real deployment.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    f1_score,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split
from sklearn.tree import DecisionTreeClassifier

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent

DATA_PATH = HERE / "data" / "pima_indians_diabetes.csv"
EXPORT_DIR = HERE / "export"
REPORT_DIR = HERE / "reports"
SHARED_DIR = REPO_ROOT / "shared" / "risk"

RANDOM_SEED = 42
TEST_FRACTION = 0.2
MAX_DEPTH = 4
MIN_SAMPLES_LEAF = 20

# Applied to the leaf's class-balanced probability of the positive class.
RISK_BANDS = {"high": 0.6, "moderate": 0.3}

# Columns where a recorded 0 is physiologically impossible, i.e. "not measured".
ZERO_MEANS_MISSING = ["Glucose", "BloodPressure", "SkinThickness", "Insulin", "BMI"]

# (model feature name, source dataset column). Order matters: it is the vector order.
FEATURES = [
    ("glucose", "Glucose"),
    ("diastolicBp", "BloodPressure"),
    ("bmi", "BMI"),
    ("age", "Age"),
    ("pregnancies", "Pregnancies"),
    ("familyHistory", "DiabetesPedigreeFunction"),
    ("skinThickness", "SkinThickness"),
    ("insulin", "Insulin"),
]
FEATURE_NAMES = [name for name, _ in FEATURES]


def band_for(probability: float) -> str:
    if probability >= RISK_BANDS["high"]:
        return "HIGH"
    if probability >= RISK_BANDS["moderate"]:
        return "MODERATE"
    return "LOW"


def build_feature_frame(
    df: pd.DataFrame, medians: Dict[str, float], pedigree_threshold: float
) -> pd.DataFrame:
    out = pd.DataFrame(index=df.index)
    for name, column in FEATURES:
        if name == "familyHistory":
            out[name] = (df["DiabetesPedigreeFunction"] >= pedigree_threshold).astype(int)
            continue
        series = df[column].astype(float)
        if column in ZERO_MEANS_MISSING:
            series = series.mask(series == 0, medians[column])
        out[name] = series
    return out[FEATURE_NAMES]


def tree_to_dict(
    clf: DecisionTreeClassifier, class_weights: np.ndarray, x_train: pd.DataFrame, y_train: np.ndarray
) -> Dict[str, Any]:
    """Convert sklearn's flat `tree_` arrays into the nested node format we export.

    `tree_.value` is NOT a stable representation to build raw counts from: different
    scikit-learn versions store it as class-weighted counts in some versions and as
    row-normalised proportions in others (this was found empirically - on 1.9.0 it is
    proportions, which made the old "divide by class_weights" arithmetic silently
    produce near-zero raw counts on every leaf, regardless of the actual risk). Raw
    counts are computed directly from the training labels via `decision_path`
    instead, which is exact and does not depend on that internal representation.
    """
    t = clf.tree_
    node_sample_mask = clf.decision_path(x_train).toarray().astype(bool)  # [n_samples, n_nodes]

    def node(index: int, depth: int) -> Dict[str, Any]:
        mask = node_sample_mask[:, index]
        raw_neg = int((y_train[mask] == 0).sum())
        raw_pos = int((y_train[mask] == 1).sum())

        weighted_neg = raw_neg * float(class_weights[0])
        weighted_pos = raw_pos * float(class_weights[1])
        total = weighted_neg + weighted_pos

        payload: Dict[str, Any] = {
            "id": int(index),
            "depth": depth,
            "samples": int(t.n_node_samples[index]),
            "rawPositives": raw_pos,
            "rawNegatives": raw_neg,
            "weightedPositives": round(weighted_pos, 6),
            "weightedNegatives": round(weighted_neg, 6),
            "probability": round(weighted_pos / total, 6) if total > 0 else 0.0,
            "rawPositiveRate": round(raw_pos / max(int(t.n_node_samples[index]), 1), 6),
            "impurity": round(float(t.impurity[index]), 6),
        }

        left, right = int(t.children_left[index]), int(t.children_right[index])
        if left == -1:
            payload["type"] = "leaf"
            return payload

        feature_index = int(t.feature[index])
        payload["type"] = "split"
        payload["feature"] = FEATURE_NAMES[feature_index]
        payload["featureIndex"] = feature_index
        payload["threshold"] = round(float(t.threshold[index]), 4)
        payload["left"] = node(left, depth + 1)
        payload["right"] = node(right, depth + 1)
        return payload

    return node(0, 0)


def collect_leaves(root: Dict[str, Any]) -> List[Dict[str, Any]]:
    leaves: List[Dict[str, Any]] = []

    def walk(n: Dict[str, Any], conditions: List[str]) -> None:
        if n["type"] == "leaf":
            leaves.append(
                {
                    "id": n["id"],
                    "probability": n["probability"],
                    "band": band_for(n["probability"]),
                    "samples": n["samples"],
                    "rawPositives": n["rawPositives"],
                    "conditions": list(conditions),
                }
            )
            return
        walk(n["left"], conditions + [f"{n['feature']} <= {n['threshold']}"])
        walk(n["right"], conditions + [f"{n['feature']} > {n['threshold']}"])

    walk(root, [])
    return leaves


def render_ascii_tree(root: Dict[str, Any]) -> str:
    lines = ["Decision tree (<= goes left):"]

    def walk(n: Dict[str, Any], prefix: str, connector: str) -> None:
        if n["type"] == "leaf":
            lines.append(
                f"{prefix}{connector}LEAF risk={n['probability'] * 100:.1f}% "
                f"band={band_for(n['probability'])} n={n['samples']} "
                f"({n['rawPositives']} diabetic)"
            )
            return
        lines.append(
            f"{prefix}{connector}{n['feature']} <= {n['threshold']} ?  [n={n['samples']}]"
        )
        child_prefix = prefix + ("" if connector == "" else "   ")
        walk(n["left"], child_prefix, "yes-> ")
        walk(n["right"], child_prefix, "no -> ")

    walk(root, "", "")
    return "\n".join(lines)


def metrics_for(y_true: np.ndarray, probabilities: np.ndarray) -> Dict[str, Any]:
    predicted = (probabilities >= 0.5).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_true, predicted, labels=[0, 1]).ravel()
    return {
        "accuracy": round(float(accuracy_score(y_true, predicted)), 4),
        "precision": round(float(precision_score(y_true, predicted, zero_division=0)), 4),
        "recall": round(float(recall_score(y_true, predicted, zero_division=0)), 4),
        "specificity": round(float(tn / (tn + fp)) if (tn + fp) else 0.0, 4),
        "f1": round(float(f1_score(y_true, predicted, zero_division=0)), 4),
        "confusionMatrix": {
            "truePositive": int(tp),
            "falsePositive": int(fp),
            "trueNegative": int(tn),
            "falseNegative": int(fn),
        },
        "rocAuc": round(float(roc_auc_score(y_true, probabilities)), 4),
    }


def render_js_artefact(root: Dict[str, Any], metadata: Dict[str, Any], ascii_tree: str) -> str:
    banner = "\n".join(f" *   {line}" for line in ascii_tree.split("\n"))
    runtime_meta = {
        "generatedAt": metadata["generatedAt"],
        "algorithm": metadata["algorithm"],
        "hyperparameters": metadata["hyperparameters"],
        "featureOrder": metadata["featureOrder"],
        "imputationMedians": metadata["imputationMedians"],
        "pedigreeThreshold": metadata["pedigreeThreshold"],
        "riskBands": metadata["riskBands"],
        "featureImportances": metadata["featureImportances"],
        "metrics": metadata["metrics"],
        "dataset": {
            "name": metadata["dataset"]["name"],
            "records": metadata["dataset"]["records"],
            "knownLimitation": metadata["dataset"]["knownLimitation"],
        },
    }
    test = metadata["metrics"]["test"]

    return f"""/* eslint-disable */
/**
 * AUTO-GENERATED FILE - DO NOT EDIT BY HAND.
 * Regenerate with:  python ml/train_model.py   (or: node ml/train_model.mjs)
 *
 * Diabetes early-risk decision tree, trained on the Pima Indians Diabetes dataset
 * and ported to plain JavaScript so the same logic runs in the browser (offline,
 * inside the service-worker-cached PWA bundle) and on the Express API. There is no
 * Python service in the request path.
 *
 * Generated: {metadata["generatedAt"]}
 * Held-out accuracy: {test["accuracy"] * 100:.1f}% | recall: {test["recall"] * 100:.1f}% | ROC-AUC: {test["rocAuc"]}
 *
 * DATASET LIMITATION: trained on adult Pima Native American women, not an Indian
 * cohort. Feature-risk directions are medically valid cross-population, but the
 * absolute cut-offs are not calibrated for India. Prototype only.
 *
{banner}
 */

/** Feature vector order expected by the tree. */
export const FEATURE_ORDER = {json.dumps(metadata["featureOrder"])};

/** Model provenance, imputation defaults and risk banding, kept next to the tree. */
export const MODEL_META = {json.dumps(runtime_meta, indent=2)};

/**
 * Field-collected values that are frequently unavailable at a village health post.
 * When absent the dataset's training-split median is substituted, and the risk
 * result reports that substitution so nobody mistakes a default for a measurement.
 */
export const IMPUTED_WHEN_MISSING = {{
  skinThickness: {metadata["imputationMedians"]["SkinThickness"]},
  insulin: {metadata["imputationMedians"]["Insulin"]},
}};

/** The fitted tree. `<=` traverses left, `>` traverses right. */
export const DECISION_TREE = {json.dumps(root, indent=2)};

/**
 * Runs the tree over a feature vector.
 *
 * @param {{number[]}} featureVector values ordered as FEATURE_ORDER
 * @returns {{{{probability: number, leafId: number, samples: number, path: Array<{{
 *   feature: string, operator: '<=' | '>', threshold: number, value: number}}>}}}}
 */
export function predictWithTree(featureVector) {{
  if (!Array.isArray(featureVector) || featureVector.length !== FEATURE_ORDER.length) {{
    throw new Error(
      `predictWithTree expects ${{FEATURE_ORDER.length}} features ordered as ${{FEATURE_ORDER.join(', ')}}`,
    );
  }}

  const path = [];
  let node = DECISION_TREE;

  while (node.type === 'split') {{
    const value = featureVector[node.featureIndex];
    const goLeft = value <= node.threshold;
    path.push({{
      feature: node.feature,
      operator: goLeft ? '<=' : '>',
      threshold: node.threshold,
      value,
    }});
    node = goLeft ? node.left : node.right;
  }}

  return {{
    probability: node.probability,
    leafId: node.id,
    samples: node.samples,
    path,
  }};
}}

/** Maps a probability to a risk band using the trained cut-offs. */
export function bandForProbability(probability) {{
  if (probability >= MODEL_META.riskBands.high) return 'HIGH';
  if (probability >= MODEL_META.riskBands.moderate) return 'MODERATE';
  return 'LOW';
}}
"""


def render_report(
    metadata: Dict[str, Any],
    ascii_tree: str,
    leaves: List[Dict[str, Any]],
    band_summary: Dict[str, Any],
) -> str:
    m = metadata["metrics"]
    ds = metadata["dataset"]

    missing_rows = "\n".join(
        f"| `{col}` | {count} ({count / ds['records'] * 100:.1f}%) | {metadata['imputationMedians'][col]} |"
        for col, count in ds["missingValueCounts"].items()
    )
    importance_rows = "\n".join(
        f"| `{name}` | {value * 100:.1f}% |"
        for name, value in sorted(
            metadata["featureImportances"].items(), key=lambda kv: -kv[1]
        )
    )
    leaf_rows = "\n".join(
        f"| {leaf['id']} | {leaf['probability'] * 100:.1f}% | {leaf['band']} | {leaf['samples']} | "
        f"{leaf['rawPositives']} | {' AND '.join(leaf['conditions']) or '(root)'} |"
        for leaf in sorted(leaves, key=lambda entry: -entry["probability"])
    )

    def format_band_row(band: str, summary: Dict[str, Any]) -> str:
        rate = summary["actualDiabeticRate"]
        rate_text = "n/a" if rate is None else f"{rate * 100:.1f}%"
        return (
            f"| {band} | {summary['patients']} | {summary['actualDiabetic']} | {rate_text} |"
        )

    band_rows = "\n".join(
        format_band_row(band, summary) for band, summary in band_summary.items()
    )

    return f"""# Diabetes risk model - training report

_Generated {metadata["generatedAt"]} by `{metadata["generatedBy"]}`._

## Data

- **Dataset:** {ds["name"]} ({ds["records"]} records, positive rate {ds["positiveRate"] * 100:.1f}%)
- **Split:** {ds["trainRecords"]} train / {ds["testRecords"]} held-out test, stratified, seed {metadata["hyperparameters"]["randomSeed"]}
- **Known limitation:** {ds["knownLimitation"]}

### Missing data handling

In this dataset a recorded `0` is physiologically impossible for several columns and
actually means "not measured". Those zeros are imputed with the **training-split**
median (not the full-dataset median, which would leak test information):

| Column | Rows recorded as 0 | Imputed value |
| --- | --- | --- |
{missing_rows}

`SkinThickness` and `Insulin` are the two features a village health worker usually
cannot collect. They stay in the model but default to the medians above, and the
risk result explicitly tells the user when a default was used.

### Family history

`DiabetesPedigreeFunction` is a continuous score derived from a family tree, which is
not collectable in the field. It is binarised **at training time** at the train median
({metadata["pedigreeThreshold"]}) into a yes/no `familyHistory` feature, so the model
is trained on exactly the question the form asks. This avoids train/serve skew.

## Model

{metadata["algorithm"]} - criterion `{metadata["hyperparameters"]["criterion"]}`,
`max_depth={metadata["hyperparameters"]["maxDepth"]}`,
`min_samples_leaf={metadata["hyperparameters"]["minSamplesLeaf"]}`,
`class_weight={metadata["hyperparameters"]["classWeight"]}`.

Depth is capped on purpose: the whole point of using a tree here is that every
decision can be read back to a health worker as a sentence. Class weighting is
balanced because a screening tool should prefer a false alarm over a missed case.

```
{ascii_tree}
```

### Feature importance

| Feature | Importance |
| --- | --- |
{importance_rows}

### Metrics

| Metric | Train | Held-out test |
| --- | --- | --- |
| Accuracy | {m["train"]["accuracy"] * 100:.1f}% | **{m["test"]["accuracy"] * 100:.1f}%** |
| Recall (sensitivity) | {m["train"]["recall"] * 100:.1f}% | **{m["test"]["recall"] * 100:.1f}%** |
| Precision | {m["train"]["precision"] * 100:.1f}% | {m["test"]["precision"] * 100:.1f}% |
| Specificity | {m["train"]["specificity"] * 100:.1f}% | {m["test"]["specificity"] * 100:.1f}% |
| F1 | {m["train"]["f1"] * 100:.1f}% | {m["test"]["f1"] * 100:.1f}% |
| ROC-AUC | {m["train"]["rocAuc"]} | **{m["test"]["rocAuc"]}** |

Held-out confusion matrix: TP {m["test"]["confusionMatrix"]["truePositive"]},
FP {m["test"]["confusionMatrix"]["falsePositive"]},
TN {m["test"]["confusionMatrix"]["trueNegative"]},
FN {m["test"]["confusionMatrix"]["falseNegative"]}.

### Risk bands on held-out data

Bands are applied to the leaf's class-balanced probability:
HIGH >= {metadata["riskBands"]["high"]}, MODERATE >= {metadata["riskBands"]["moderate"]}, otherwise LOW.

| Band | Patients | Actually diabetic | Rate |
| --- | --- | --- | --- |
{band_rows}

## Leaves

| Leaf | Risk | Band | Train n | of which diabetic | Path |
| --- | --- | --- | --- | --- | --- |
{leaf_rows}
"""


def main() -> None:
    if not DATA_PATH.exists():
        raise SystemExit(
            f"Dataset not found at {DATA_PATH}. See ml/README.md for the download command."
        )

    df = pd.read_csv(DATA_PATH)
    print(f"Loaded {len(df)} records from {DATA_PATH.relative_to(REPO_ROOT)}")

    train_df, test_df = train_test_split(
        df,
        test_size=TEST_FRACTION,
        random_state=RANDOM_SEED,
        stratify=df["Outcome"],
    )
    print(f"Split -> train: {len(train_df)}, test: {len(test_df)} (seed {RANDOM_SEED})")

    # Medians from the TRAIN split only, so the held-out set stays untouched.
    medians = {
        column: round(float(train_df.loc[train_df[column] > 0, column].median()), 2)
        for column in ZERO_MEANS_MISSING
    }
    print("Train-split medians for missing values:", medians)

    pedigree_threshold = round(float(train_df["DiabetesPedigreeFunction"].median()), 4)
    print(f"Family-history binarisation threshold (train median DPF): {pedigree_threshold}")

    x_train = build_feature_frame(train_df, medians, pedigree_threshold)
    y_train = train_df["Outcome"].to_numpy()
    x_test = build_feature_frame(test_df, medians, pedigree_threshold)
    y_test = test_df["Outcome"].to_numpy()

    clf = DecisionTreeClassifier(
        criterion="gini",
        max_depth=MAX_DEPTH,
        min_samples_leaf=MIN_SAMPLES_LEAF,
        class_weight="balanced",
        random_state=RANDOM_SEED,
    )
    clf.fit(x_train, y_train)

    n = len(y_train)
    n_pos = int((y_train == 1).sum())
    n_neg = n - n_pos
    class_weights = np.array([n / (2 * n_neg), n / (2 * n_pos)])

    train_probabilities = clf.predict_proba(x_train)[:, 1]
    test_probabilities = clf.predict_proba(x_test)[:, 1]

    train_metrics = metrics_for(y_train, train_probabilities)
    test_metrics = metrics_for(y_test, test_probabilities)
    print("\nTRAIN metrics:", train_metrics)
    print("TEST  metrics:", test_metrics)

    feature_importances = {
        name: round(float(value), 6)
        for name, value in zip(FEATURE_NAMES, clf.feature_importances_)
    }
    print("\nFeature importances:", feature_importances)

    band_summary: Dict[str, Any] = {}
    for band in ("LOW", "MODERATE", "HIGH"):
        mask = np.array([band_for(p) == band for p in test_probabilities])
        total = int(mask.sum())
        positives = int(y_test[mask].sum()) if total else 0
        band_summary[band] = {
            "patients": total,
            "actualDiabetic": positives,
            "actualDiabeticRate": round(positives / total, 4) if total else None,
        }
    print("\nHeld-out risk band distribution:", band_summary)

    root = tree_to_dict(clf, class_weights, x_train, y_train)
    leaves = collect_leaves(root)
    ascii_tree = render_ascii_tree(root)
    print(f"\n{ascii_tree}")

    metadata = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "generatedBy": "ml/train_model.py (scikit-learn DecisionTreeClassifier)",
        "algorithm": "DecisionTreeClassifier (CART)",
        "hyperparameters": {
            "criterion": "gini",
            "maxDepth": MAX_DEPTH,
            "minSamplesLeaf": MIN_SAMPLES_LEAF,
            "classWeight": "balanced",
            "randomSeed": RANDOM_SEED,
            "testFraction": TEST_FRACTION,
        },
        "dataset": {
            "name": "Pima Indians Diabetes Database",
            "originalSource": (
                "UCI Machine Learning Repository / National Institute of Diabetes "
                "and Digestive and Kidney Diseases"
            ),
            "retrievedFrom": (
                "https://raw.githubusercontent.com/jbrownlee/Datasets/master/"
                "pima-indians-diabetes.csv"
            ),
            "records": int(len(df)),
            "trainRecords": int(len(train_df)),
            "testRecords": int(len(test_df)),
            "positiveRate": round(float(df["Outcome"].mean()), 4),
            "knownLimitation": (
                "Cohort is adult Pima Native American women. Not representative of "
                "rural India. Prototype only; retrain on ICMR-INDIAB or NFHS-5 "
                "before any real deployment."
            ),
            "zeroMeansMissing": ZERO_MEANS_MISSING,
            "missingValueCounts": {
                column: int((df[column] == 0).sum()) for column in ZERO_MEANS_MISSING
            },
        },
        "featureOrder": FEATURE_NAMES,
        "imputationMedians": medians,
        "pedigreeThreshold": pedigree_threshold,
        "classWeights": [round(float(w), 6) for w in class_weights],
        "riskBands": RISK_BANDS,
        "featureImportances": feature_importances,
        "metrics": {"train": train_metrics, "test": test_metrics},
        "heldOutBandSummary": band_summary,
        "tree": {
            "nodeCount": int(clf.tree_.node_count),
            "leafCount": len(leaves),
            "leaves": leaves,
        },
    }

    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    SHARED_DIR.mkdir(parents=True, exist_ok=True)

    artefact = render_js_artefact(root, metadata, ascii_tree)
    (EXPORT_DIR / "decision_tree_rules.js").write_text(artefact, encoding="utf8")
    (SHARED_DIR / "decision_tree_rules.js").write_text(artefact, encoding="utf8")
    (EXPORT_DIR / "model_metadata.json").write_text(
        json.dumps(metadata, indent=2) + "\n", encoding="utf8"
    )
    (REPORT_DIR / "training_report.md").write_text(
        render_report(metadata, ascii_tree, leaves, band_summary), encoding="utf8"
    )

    print("\nWrote:")
    for target in (
        EXPORT_DIR / "decision_tree_rules.js",
        SHARED_DIR / "decision_tree_rules.js",
        EXPORT_DIR / "model_metadata.json",
        REPORT_DIR / "training_report.md",
    ):
        print(f"  {target.relative_to(REPO_ROOT)}")


if __name__ == "__main__":
    main()
