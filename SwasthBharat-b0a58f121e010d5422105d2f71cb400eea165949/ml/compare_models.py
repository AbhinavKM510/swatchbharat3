"""
Side-by-side comparison of every model in the project. Read-only.

    python ml/compare_models.py       (or: npm run ml:compare:all)

Compares:
    1. CART decision tree   - SHIPPED, authoritative for the risk band
    2. PyTorch MLP          - SHIPPED as a second opinion and attribution source
    3. Keras MLP            - cross-validation only, never served

WRITES NOTHING. It reads the committed artefacts in ml/export/ and prints. It does not
train, it does not touch shared/risk/, and it uses only the Python standard library —
no numpy, no torch, no tensorflow. That means it runs anywhere, in about a second, and
is safe to run in front of an audience: unlike ml/train_model.py, there is no way for
it to swap the live model mid-demo.

Because it reads artefacts rather than retraining, every number here is the number the
application actually uses. In particular the PyTorch column is measured by the exported
JavaScript forward pass (see ml/export_neural.mjs), not by PyTorch, because the
JavaScript is what scores patients.

Missing artefacts are reported and skipped rather than being an error, so this still
gives a useful answer on a fresh clone where only the tree has been generated.
"""

from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
EXPORT_DIR = HERE / "export"

TREE_PATH = EXPORT_DIR / "model_metadata.json"
TORCH_PATH = EXPORT_DIR / "neural_metadata.json"
KERAS_PATH = EXPORT_DIR / "neural_weights_tf.json"

BANDS = ("LOW", "MODERATE", "HIGH")
METRIC_KEYS = ("accuracy", "precision", "recall", "specificity", "f1", "rocAuc")

# The criteria agreed before training for promoting the neural model from second
# opinion to primary. Recorded here so the decision is checkable rather than asserted,
# and so it is re-checked automatically on every retrain.
PROMOTION_CRITERIA = {
    "rocAuc": 0.83,
    "recall": 0.80,
    "moderateBandShare": 0.08,
}

RULE = "-" * 74


def load(path: Path) -> dict | None:
    if not path.exists():
        return None
    return json.loads(path.read_text(encoding="utf8"))


def band_share(summary: dict, band: str, total: int) -> float:
    entry = summary.get(band, {})
    if "share" in entry:
        return float(entry["share"])
    return entry.get("patients", 0) / total if total else 0.0


def fmt(value, width: int = 12, precision: int = 4) -> str:
    if value is None:
        return "-".rjust(width)
    if isinstance(value, float):
        return f"{value:.{precision}f}".rjust(width)
    return str(value).rjust(width)


def main() -> None:
    tree = load(TREE_PATH)
    torch_meta = load(TORCH_PATH)
    keras_meta = load(KERAS_PATH)

    if tree is None:
        raise SystemExit(
            f"Missing {TREE_PATH.relative_to(REPO_ROOT)}\nGenerate it with: node ml/train_model.mjs"
        )

    print()
    print(RULE)
    print("SwasthBharat - model comparison (read-only, writes nothing)")
    print(RULE)

    columns = [("CART tree", tree)]
    if torch_meta:
        columns.append(("PyTorch MLP", torch_meta))
    if keras_meta:
        columns.append(("Keras MLP", keras_meta))

    # --- What each model is for ------------------------------------------------
    print("\nROLE")
    print(f"  CART tree     SHIPPED, decides the risk band")
    print(f"                {tree['algorithm']}")
    print(
        f"                depth {tree['hyperparameters']['maxDepth']}, "
        f"{tree['tree']['leafCount']} leaves / {tree['tree']['nodeCount']} nodes"
    )
    if torch_meta:
        print(f"\n  PyTorch MLP   SHIPPED as a second opinion + attribution source. Does NOT decide the band.")
        print(f"                {torch_meta['algorithm']}, {torch_meta['parameterCount']} parameters")
        print(f"                trained by {torch_meta['generatedBy']}")
    if keras_meta:
        print(f"\n  Keras MLP     CROSS-VALIDATION ONLY, never served.")
        print(f"                {keras_meta['algorithm']}, {keras_meta['parameterCount']} parameters")
        print(f"                exists to corroborate the PyTorch result independently")

    if len(columns) == 1:
        print(
            "\nOnly the tree has been generated. For the full comparison:\n"
            "  node ml/prepare_dataset.mjs\n"
            "  python ml/train_neural.py && node ml/export_neural.mjs\n"
            "  python ml/train_neural_tf.py"
        )
        print(f"\n{RULE}\n")
        return

    # --- Held-out metrics ------------------------------------------------------
    print(f"\n{RULE}")
    print("HELD-OUT METRICS  (same 154 rows for every model)")
    print(RULE)
    header = "metric".ljust(14) + "".join(name.rjust(14) for name, _ in columns)
    print(header)
    for key in METRIC_KEYS:
        row = key.ljust(14)
        for _, meta in columns:
            row += fmt(meta["metrics"]["test"].get(key), 14)
        print(row)

    print("\nconfusion matrix (TP / FP / TN / FN)")
    for name, meta in columns:
        cm = meta["metrics"]["test"]["confusionMatrix"]
        print(
            f"  {name:<14}{cm['truePositive']:>4} /{cm['falsePositive']:>4} /"
            f"{cm['trueNegative']:>4} /{cm['falseNegative']:>4}"
        )

    # --- Band spread ----------------------------------------------------------
    print(f"\n{RULE}")
    print("RISK BAND SPREAD ON HELD-OUT DATA")
    print(RULE)
    print(
        "A band almost nobody falls into carries no triage information, whatever the\n"
        "headline accuracy says. This is the check that rejected scikit-learn's tree.\n"
    )
    print("band".ljust(11) + "".join(f"{name:>21}" for name, _ in columns))
    for band in BANDS:
        row = band.ljust(11)
        for _, meta in columns:
            total = meta["dataset"]["testRecords"] if "dataset" in meta else 154
            summary = meta["heldOutBandSummary"]
            patients = summary[band]["patients"]
            share = band_share(summary, band, total)
            rate = summary[band]["actualDiabeticRate"]
            rate_text = "n/a" if rate is None else f"{rate * 100:.0f}%"
            row += f"{patients:>6} ({share * 100:>4.1f}%) dm {rate_text:>4}"
        print(row)

    print("\n  'dm' is the share of patients in that band who really are diabetic.")
    for name, meta in columns:
        rates = [meta["heldOutBandSummary"][b]["actualDiabeticRate"] for b in BANDS]
        rates = [r for r in rates if r is not None]
        monotonic = all(a <= b for a, b in zip(rates, rates[1:]))
        print(f"  {name:<14}separates monotonically: {monotonic}")

    # --- Feature importance ---------------------------------------------------
    print(f"\n{RULE}")
    print("FEATURE IMPORTANCE")
    print(RULE)
    print(
        "Not the same quantity in each column, and not directly comparable:\n"
        "  CART     weighted gini impurity decrease - only features it split on\n"
        "  PyTorch  mean |integrated gradient| over the training split - all features\n"
    )
    features = list(tree["featureOrder"])
    print("feature".ljust(16) + "CART".rjust(10) + ("PyTorch".rjust(12) if torch_meta else ""))
    tree_imp = tree["featureImportances"]
    torch_imp = torch_meta["featureImportances"] if torch_meta else {}
    for feature in sorted(features, key=lambda f: -tree_imp.get(f, 0)):
        row = feature.ljust(16) + f"{tree_imp.get(feature, 0) * 100:>9.1f}%"
        if torch_meta:
            row += f"{torch_imp.get(feature, 0) * 100:>11.1f}%"
        print(row)

    zero_in_tree = [f for f in features if tree_imp.get(f, 0) == 0]
    if zero_in_tree and torch_meta:
        print(
            f"\n  The tree assigns zero importance to: {', '.join(zero_in_tree)}.\n"
            "  A depth-4 tree can only use the features it happens to split on, so it has\n"
            "  nothing to say about the rest. The attribution method gives every feature a\n"
            "  value, which is the main reason the neural model is worth shipping alongside."
        )

    # --- Framework agreement --------------------------------------------------
    if keras_meta and keras_meta.get("comparisonWithPyTorch"):
        comparison = keras_meta["comparisonWithPyTorch"]
        print(f"\n{RULE}")
        print("FRAMEWORK AGREEMENT  (is the PyTorch result real?)")
        print(RULE)
        worst = max(abs(v) for v in comparison["deltas"].values())
        print(
            "Two independent implementations of the same architecture, same rows, different\n"
            "default initialisers, so different minima. Weights are not expected to match;\n"
            "held-out behaviour is.\n"
        )
        for key in METRIC_KEYS:
            delta = comparison["deltas"].get(key)
            print(f"  {key:<14}{delta:>+9.4f}")
        print(f"\n  largest disagreement on any metric: {worst:.4f}")
        print(f"  identical band assigned to {comparison['bandAgreementRate'] * 100:.1f}% of held-out patients")

    # --- Promotion gate -------------------------------------------------------
    if torch_meta:
        print(f"\n{RULE}")
        print("PROMOTION GATE  (should the neural model decide the band?)")
        print(RULE)
        test = torch_meta["metrics"]["test"]
        total = torch_meta["dataset"]["testRecords"]
        moderate_share = band_share(torch_meta["heldOutBandSummary"], "MODERATE", total)

        results = [
            ("ROC-AUC", test["rocAuc"], PROMOTION_CRITERIA["rocAuc"]),
            ("recall", test["recall"], PROMOTION_CRITERIA["recall"]),
            ("MODERATE band share", moderate_share, PROMOTION_CRITERIA["moderateBandShare"]),
        ]
        print("These thresholds were fixed BEFORE training, so this is a check, not a rationalisation.\n")
        passed = 0
        for label, actual, required in results:
            ok = actual >= required
            passed += 1 if ok else 0
            print(f"  [{'PASS' if ok else 'FAIL'}]  {label:<22}{actual:>8.4f}  needs >= {required}")

        print()
        if passed == len(results):
            print("  All criteria met. The neural model COULD take over as primary.")
            print("  That is a deliberate decision, not an automatic one - see ml/README.md.")
        else:
            print(f"  {len(results) - passed} of {len(results)} criteria not met.")
            print("  The decision tree remains authoritative for the risk band, as planned.")
            print("  The neural model still ships, for attributions and as a second opinion.")

    print(f"\n{RULE}")
    print("Nothing was written. The shipped model is unchanged.")
    print(RULE + "\n")


if __name__ == "__main__":
    main()
