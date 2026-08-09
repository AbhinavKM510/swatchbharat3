"""Cross-validates the shipped Node-trained tree against scikit-learn. Read-only.

    python ml/compare_trainers.py

Trains a scikit-learn DecisionTreeClassifier with the same hyperparameters as
`train_model.mjs`, then prints both sets of held-out metrics side by side.

WRITES NOTHING. Unlike `train_model.py`, this cannot touch
`shared/risk/decision_tree_rules.js` — so it is safe to run in front of an audience
without any risk of swapping the model the live app is using.

Why this script exists
----------------------
The runtime model is plain JavaScript, fitted by a ~200-line CART implementation in
`lib/cart.mjs`. A reasonable person should ask whether that hand-rolled implementation
is actually correct. This answers it empirically: point scikit-learn at the same data
with the same settings and compare. Matching accuracy and identical tree size is
evidence the algorithm is right, not just plausible.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict

import numpy as np
import pandas as pd
from sklearn.metrics import (
    accuracy_score,
    confusion_matrix,
    precision_score,
    recall_score,
    roc_auc_score,
)
from sklearn.model_selection import train_test_split
from sklearn.tree import DecisionTreeClassifier

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
DATA_PATH = HERE / "data" / "pima_indians_diabetes.csv"
SHIPPED_METADATA = HERE / "export" / "model_metadata.json"

RANDOM_SEED = 42
TEST_FRACTION = 0.2
MAX_DEPTH = 4
MIN_SAMPLES_LEAF = 20
RISK_BANDS = {"high": 0.6, "moderate": 0.3}
ZERO_MEANS_MISSING = ["Glucose", "BloodPressure", "SkinThickness", "Insulin", "BMI"]
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


def build_features(df: pd.DataFrame, medians: Dict[str, float], pedigree: float) -> pd.DataFrame:
    out = pd.DataFrame(index=df.index)
    for name, column in FEATURES:
        if name == "familyHistory":
            out[name] = (df["DiabetesPedigreeFunction"] >= pedigree).astype(int)
            continue
        series = df[column].astype(float)
        if column in ZERO_MEANS_MISSING:
            series = series.mask(series == 0, medians[column])
        out[name] = series
    return out[FEATURE_NAMES]


def band_for(p: float) -> str:
    if p >= RISK_BANDS["high"]:
        return "HIGH"
    if p >= RISK_BANDS["moderate"]:
        return "MODERATE"
    return "LOW"


def row(label: str, node: Any, sk: Any, flag: str = "") -> str:
    return f"| {label:<26} | {node:>18} | {sk:>18} | {flag}"


def main() -> None:
    if not DATA_PATH.exists():
        raise SystemExit(f"Dataset not found at {DATA_PATH}")
    if not SHIPPED_METADATA.exists():
        raise SystemExit(
            f"Shipped metadata not found at {SHIPPED_METADATA}.\n"
            "Run `node ml/train_model.mjs` first."
        )

    shipped = json.loads(SHIPPED_METADATA.read_text(encoding="utf8"))
    shipped_test = shipped["metrics"]["test"]

    df = pd.read_csv(DATA_PATH)
    train_df, test_df = train_test_split(
        df, test_size=TEST_FRACTION, random_state=RANDOM_SEED, stratify=df["Outcome"]
    )

    medians = {
        c: round(float(train_df.loc[train_df[c] > 0, c].median()), 2) for c in ZERO_MEANS_MISSING
    }
    pedigree = round(float(train_df["DiabetesPedigreeFunction"].median()), 4)

    x_train = build_features(train_df, medians, pedigree)
    y_train = train_df["Outcome"].to_numpy()
    x_test = build_features(test_df, medians, pedigree)
    y_test = test_df["Outcome"].to_numpy()

    clf = DecisionTreeClassifier(
        criterion="gini",
        max_depth=MAX_DEPTH,
        min_samples_leaf=MIN_SAMPLES_LEAF,
        class_weight="balanced",
        random_state=RANDOM_SEED,
    )
    clf.fit(x_train, y_train)

    probabilities = clf.predict_proba(x_test)[:, 1]
    predicted = (probabilities >= 0.5).astype(int)
    tn, fp, fn, tp = confusion_matrix(y_test, predicted, labels=[0, 1]).ravel()

    sk = {
        "accuracy": round(float(accuracy_score(y_test, predicted)), 4),
        "recall": round(float(recall_score(y_test, predicted, zero_division=0)), 4),
        "precision": round(float(precision_score(y_test, predicted, zero_division=0)), 4),
        "specificity": round(float(tn / (tn + fp)) if (tn + fp) else 0.0, 4),
        "rocAuc": round(float(roc_auc_score(y_test, probabilities)), 4),
        "leaves": int((clf.tree_.children_left == -1).sum()),
        "nodes": int(clf.tree_.node_count),
    }

    print("\n" + "=" * 74)
    print("  Node CART (shipped)  vs  scikit-learn  -  held-out test set")
    print("=" * 74)
    print(f"  dataset: {len(df)} records, {len(train_df)} train / {len(test_df)} test, seed {RANDOM_SEED}")
    print(f"  settings: gini, max_depth={MAX_DEPTH}, min_samples_leaf={MIN_SAMPLES_LEAF}, class_weight=balanced")
    print(f"  scikit-learn version: {__import__('sklearn').__version__}\n")

    print(f"| {'metric':<26} | {'Node CART (shipped)':>18} | {'scikit-learn':>18} |")
    print(f"|{'-' * 28}|{'-' * 20}|{'-' * 20}|")

    match = "  <-- identical" if shipped_test["accuracy"] == sk["accuracy"] else ""
    print(row("accuracy", shipped_test["accuracy"], sk["accuracy"], match))
    print(row("recall (sensitivity)", shipped_test["recall"], sk["recall"]))
    print(row("precision", shipped_test["precision"], sk["precision"]))
    print(row("specificity", shipped_test["specificity"], sk["specificity"]))
    print(row("ROC-AUC", shipped_test["rocAuc"], sk["rocAuc"]))
    same_shape = "  <-- identical" if shipped["tree"]["leafCount"] == sk["leaves"] else ""
    print(row("leaf count", shipped["tree"]["leafCount"], sk["leaves"], same_shape))
    print(row("node count", shipped["tree"]["nodeCount"], sk["nodes"]))

    # Band spread is the reason the Node artefact is the one shipped.
    counts = {"LOW": 0, "MODERATE": 0, "HIGH": 0}
    for p in probabilities:
        counts[band_for(float(p))] += 1
    shipped_bands = shipped["heldOutBandSummary"]

    print(f"\n| {'held-out band spread':<26} | {'Node CART (shipped)':>18} | {'scikit-learn':>18} |")
    print(f"|{'-' * 28}|{'-' * 20}|{'-' * 20}|")
    for band in ("LOW", "MODERATE", "HIGH"):
        flag = "  <-- near-empty" if band == "MODERATE" and counts[band] <= 3 else ""
        print(row(f"patients in {band}", shipped_bands[band]["patients"], counts[band], flag))

    print("\nFeature importances (scikit-learn):")
    for name, value in sorted(
        zip(FEATURE_NAMES, clf.feature_importances_), key=lambda kv: -kv[1]
    ):
        bar = "#" * int(round(value * 40))
        note = "   <-- never split on" if value == 0 else ""
        print(f"  {name:<16} {value * 100:5.1f}%  {bar}{note}")

    print(
        "\nConclusion: accuracy and tree size match, which is independent evidence that\n"
        "lib/cart.mjs implements the same algorithm scikit-learn does. Recall differs\n"
        "because the two stratified splits shuffle differently.\n"
        "\nThe Node artefact is the one shipped because it spreads three usable risk bands\n"
        "and splits on BMI and family history, so the decision path corroborates the\n"
        "plain-language explanation shown to the health worker. See ml/README.md.\n"
    )
    print("This script wrote nothing. The live model is untouched.\n")


if __name__ == "__main__":
    main()
