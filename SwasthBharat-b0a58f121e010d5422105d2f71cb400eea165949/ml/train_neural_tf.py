"""
Independent TensorFlow/Keras implementation of the neural risk model.

    node ml/prepare_dataset.mjs      # once, produces the shared split
    python ml/train_neural_tf.py     # this script

Output:
    ml/export/neural_weights_tf.json   <- weights + metrics, for comparison only

THIS SCRIPT IS NOT PART OF THE SHIPPING PIPELINE.
It cannot write to shared/risk/ and there is deliberately no TensorFlow exporter. The
model the app serves is exported from the PyTorch run by ml/export_neural.mjs. This
script exists to answer a different question: *is the PyTorch result real?*

WHY THIS IS WORTH A FILE
------------------------
The project already does this once. `ml/train_model.mjs` implements CART from scratch
in ~330 lines of JavaScript, and `ml/train_model.py` fits the same thing with
scikit-learn; they agree to identical accuracy and identical tree size, and
MERGE-PLAN.md treats that agreement as the evidence the hand-rolled CART implements
the algorithm rather than something that merely resembles it.

The neural model needs the same treatment, and arguably needs it more. A 289-parameter
MLP trained on 614 rows is exactly the setup where a plausible-looking number can come
from a bug — a mis-signed loss, a leaked validation split, a standardisation applied
twice. Two independent frameworks, given the same rows and the same architecture,
converging on the same held-out performance is real evidence. One framework producing a
nice number is not.

WHAT IS AND IS NOT EXPECTED TO MATCH
------------------------------------
Not the weights. Keras initialises Dense kernels with Glorot-uniform and biases with
zeros; PyTorch's nn.Linear uses a Kaiming-flavoured uniform for both. The two runs
start in different places and end in different minima, and forcing them to match would
mean reimplementing one framework's initialiser in the other, which would defeat the
purpose of an independent check.

What should match is the held-out behaviour: accuracy, ROC-AUC and the band spread,
within the noise you would expect from two different minima of the same architecture on
154 test rows. A gap of a few points is a finding about variance; a gap of twenty is a
bug in one of them.

Both scripts share the same evaluation code (ml/lib/metrics.py) and the same
train/test rows (ml/export/dataset_split.json), so any difference in the reported
numbers comes from training, not from measurement.

Requires: numpy, tensorflow. No pandas, no scikit-learn.
"""

from __future__ import annotations

import datetime
import json
import os
import sys
from pathlib import Path

import numpy as np

from lib.metrics import band_summary, classification_metrics, monotonic_bands, roc_auc, stratified_indices

# Quieten TensorFlow's C++ logging before it is imported, or the useful output is
# buried under oneDNN and cuFFT registration notices.
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "2")

try:
    import tensorflow as tf
    from tensorflow import keras
except ImportError:  # pragma: no cover - guidance path
    sys.exit(
        "TensorFlow is not installed in this interpreter.\n"
        "  python -m pip install --only-binary=:all: tensorflow\n"
        "See ml/requirements.txt."
    )

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
EXPORT_DIR = HERE / "export"
SPLIT_PATH = EXPORT_DIR / "dataset_split.json"
TORCH_WEIGHTS_PATH = EXPORT_DIR / "neural_weights.json"
OUTPUT_PATH = EXPORT_DIR / "neural_weights_tf.json"

# Identical to ml/train_neural.py. If you change one, change both, or the comparison
# stops being a comparison.
RANDOM_SEED = 42
HIDDEN_1 = 16
HIDDEN_2 = 8
LEARNING_RATE = 0.01
WEIGHT_DECAY = 1e-4
MAX_EPOCHS = 1200
VALIDATION_FRACTION = 0.2
EARLY_STOP_PATIENCE = 150


def build_model(n_features: int) -> keras.Model:
    """Same topology as RiskNet in ml/train_neural.py.

    The output layer is linear; the loss applies the sigmoid via `from_logits=True`,
    matching PyTorch's BCEWithLogitsLoss. Doing it this way rather than putting a
    sigmoid activation on the output keeps the two implementations numerically
    comparable, and is the numerically stable form in both frameworks.
    """
    return keras.Sequential(
        [
            keras.layers.Input(shape=(n_features,), name="features"),
            keras.layers.Dense(HIDDEN_1, activation="relu", name="l1"),
            keras.layers.Dense(HIDDEN_2, activation="relu", name="l2"),
            keras.layers.Dense(1, name="out"),
        ],
        name="risknet_keras",
    )


def compile_model(model: keras.Model) -> keras.Model:
    model.compile(
        optimizer=keras.optimizers.Adam(learning_rate=LEARNING_RATE, weight_decay=WEIGHT_DECAY),
        loss=keras.losses.BinaryCrossentropy(from_logits=True),
    )
    return model


def logits(model: keras.Model, x: np.ndarray) -> np.ndarray:
    return np.asarray(model.predict(x, verbose=0)).reshape(-1).astype(np.float64)


def probabilities(model: keras.Model, x: np.ndarray) -> np.ndarray:
    z = logits(model, x)
    # Numerically stable logistic, same branch structure as the exported JS.
    return np.where(z >= 0, 1.0 / (1.0 + np.exp(-np.abs(z))), np.exp(-np.abs(z)) / (1.0 + np.exp(-np.abs(z))))


def fit(
    x: np.ndarray,
    y: np.ndarray,
    class_weight: dict,
    epochs: int,
    x_val: np.ndarray | None = None,
    y_val: np.ndarray | None = None,
) -> tuple[keras.Model, int, float]:
    """Full-batch training. Returns (model, best_epoch, best_val_auc).

    Epoch selection mirrors the PyTorch script: track validation ROC-AUC every epoch,
    keep the best weights, stop after EARLY_STOP_PATIENCE epochs without improvement.
    Keras' built-in EarlyStopping is not used because it cannot monitor the
    tie-aware ROC-AUC from ml/lib/metrics.py, and using Keras' own AUC metric instead
    would mean the two trainers selected epochs by different criteria.
    """
    keras.utils.set_random_seed(RANDOM_SEED)
    model = compile_model(build_model(x.shape[1]))

    best_auc = -1.0
    best_epoch = epochs
    best_weights = None
    since_improved = 0

    for epoch in range(1, epochs + 1):
        model.fit(
            x,
            y,
            epochs=1,
            batch_size=len(x),
            class_weight=class_weight,
            shuffle=False,
            verbose=0,
        )

        if x_val is None:
            continue

        auc = roc_auc(y_val, probabilities(model, x_val))
        if auc > best_auc:
            best_auc = auc
            best_epoch = epoch
            best_weights = model.get_weights()
            since_improved = 0
        else:
            since_improved += 1
            if since_improved >= EARLY_STOP_PATIENCE:
                print(f"  early stop at epoch {epoch} (no gain for {EARLY_STOP_PATIENCE})")
                break

    if best_weights is not None:
        model.set_weights(best_weights)

    return model, best_epoch, best_auc


def main() -> None:
    if not SPLIT_PATH.exists():
        sys.exit(
            f"Shared split not found at {SPLIT_PATH.relative_to(REPO_ROOT)}\n"
            "Run it first:  node ml/prepare_dataset.mjs"
        )

    # Determinism. enable_op_determinism costs performance on large graphs and buys
    # nothing there; on a 289-parameter model it is free and makes the run repeatable.
    keras.utils.set_random_seed(RANDOM_SEED)
    tf.config.experimental.enable_op_determinism()

    split = json.loads(SPLIT_PATH.read_text(encoding="utf8"))
    feature_order = split["featureOrder"]
    bands = split["riskBands"]
    mean = np.array(split["standardisation"]["mean"], dtype=np.float64)
    std = np.array(split["standardisation"]["std"], dtype=np.float64)

    y_train = np.array(split["train"]["y"], dtype=np.int64)
    y_test = np.array(split["test"]["y"], dtype=np.int64)
    x_train = ((np.array(split["train"]["X"], dtype=np.float64) - mean) / std).astype(np.float32)
    x_test = ((np.array(split["test"]["X"], dtype=np.float64) - mean) / std).astype(np.float32)

    print(f"TensorFlow {tf.__version__} | Keras {keras.__version__} | numpy {np.__version__}")
    print(f"Shared split: train {len(y_train)}, held-out {len(y_test)}, features {len(feature_order)}")
    print(f"Architecture: {len(feature_order)} -> {HIDDEN_1} -> {HIDDEN_2} -> 1 (same as the PyTorch run)\n")

    n_pos = int(np.sum(y_train == 1))
    n_neg = int(len(y_train) - n_pos)
    pos_weight = n_neg / n_pos
    # Expressed the same way PyTorch's pos_weight is: negatives at 1.0, positives
    # scaled up. Equivalent to class_weight="balanced" up to a constant factor on the
    # loss, which Adam is invariant to in direction.
    class_weight = {0: 1.0, 1: pos_weight}
    print(f"Class balance: {n_neg} negative / {n_pos} positive -> positive weight {pos_weight:.4f}")

    y_train_f = y_train.astype(np.float32)

    # --- Stage 1: choose the epoch count on a slice of the TRAIN split ---------
    fit_idx, val_idx = stratified_indices(y_train, VALIDATION_FRACTION, RANDOM_SEED)
    print(f"\nStage 1 - epoch selection on {len(val_idx)} validation rows held out of train")
    _, best_epoch, best_auc = fit(
        x_train[fit_idx],
        y_train_f[fit_idx],
        class_weight,
        MAX_EPOCHS,
        x_val=x_train[val_idx],
        y_val=y_train[val_idx],
    )
    print(f"  best epoch {best_epoch} (validation ROC-AUC {best_auc})")

    # --- Stage 2: refit on the full train split -------------------------------
    print(f"\nStage 2 - refit on all {len(y_train)} train rows for {best_epoch} epochs")
    model, _, _ = fit(x_train, y_train_f, class_weight, best_epoch)

    p_train = probabilities(model, x_train)
    p_test = probabilities(model, x_test)

    train_metrics = {**classification_metrics(y_train, p_train), "rocAuc": roc_auc(y_train, p_train)}
    test_metrics = {**classification_metrics(y_test, p_test), "rocAuc": roc_auc(y_test, p_test)}
    held_out_bands = band_summary(y_test, p_test, bands)

    print("\nTRAIN metrics:", train_metrics)
    print("TEST  metrics:", test_metrics)
    print("\nHeld-out band spread:")
    for name, stats in held_out_bands.items():
        rate = stats["actualDiabeticRate"]
        rate_text = "n/a" if rate is None else f"{rate * 100:.1f}%"
        print(
            f"  {name:<9} {stats['patients']:>4} patients "
            f"({stats['share'] * 100:>5.1f}% of held-out)   actually diabetic: {rate_text}"
        )
    print(f"  bands separate monotonically: {monotonic_bands(held_out_bands)}")

    # --- Side by side with the PyTorch run ------------------------------------
    comparison = None
    if TORCH_WEIGHTS_PATH.exists():
        torch_payload = json.loads(TORCH_WEIGHTS_PATH.read_text(encoding="utf8"))
        torch_test = torch_payload["torchCrossCheck"]["metrics"]["test"]
        torch_bands = torch_payload["torchCrossCheck"]["heldOutBandSummary"]
        torch_probabilities = np.array(torch_payload["torchCrossCheck"]["testProbabilities"], dtype=np.float64)

        agreement = float(
            np.mean(
                [
                    1.0 if a == b else 0.0
                    for a, b in zip(
                        [k for k in (band_summary_key(p, bands) for p in p_test)],
                        [k for k in (band_summary_key(p, bands) for p in torch_probabilities)],
                    )
                ]
            )
        )

        print("\n" + "-" * 62)
        print("Independent cross-check: Keras vs PyTorch on identical held-out rows")
        print("-" * 62)
        print(f"{'metric':<14}{'Keras':>12}{'PyTorch':>12}{'delta':>12}")
        for key in ("accuracy", "precision", "recall", "specificity", "f1", "rocAuc"):
            delta = test_metrics[key] - torch_test[key]
            print(f"{key:<14}{test_metrics[key]:>12.4f}{torch_test[key]:>12.4f}{delta:>+12.4f}")

        print(f"\n{'band':<10}{'Keras':>16}{'PyTorch':>16}")
        for name in ("LOW", "MODERATE", "HIGH"):
            print(
                f"{name:<10}{held_out_bands[name]['patients']:>10} "
                f"({held_out_bands[name]['share'] * 100:>4.1f}%)"
                f"{torch_bands[name]['patients']:>10} ({torch_bands[name]['share'] * 100:>4.1f}%)"
            )

        print(f"\nThe two models assign the same band to {agreement * 100:.1f}% of held-out patients.")
        print(
            "Weights are NOT expected to match: Keras and PyTorch use different default\n"
            "initialisers, so the two runs land in different minima. Matching held-out\n"
            "behaviour from different starting points is the evidence being sought."
        )

        comparison = {
            "keras": {"metrics": test_metrics, "heldOutBandSummary": held_out_bands},
            "pytorch": {"metrics": torch_test, "heldOutBandSummary": torch_bands},
            "deltas": {
                key: round(test_metrics[key] - torch_test[key], 4)
                for key in ("accuracy", "precision", "recall", "specificity", "f1", "rocAuc")
            },
            "bandAgreementRate": round(agreement, 4),
        }
    else:
        print(
            f"\n{TORCH_WEIGHTS_PATH.name} not found, so no comparison was made.\n"
            "Run `python ml/train_neural.py` first to get a side-by-side."
        )

    # --- Export (comparison artefact only, never shipped) ---------------------
    weights = model.get_weights()
    payload = {
        "generatedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "generatedBy": f"ml/train_neural_tf.py (TensorFlow {tf.__version__} / Keras {keras.__version__})",
        "role": "cross-validation-only",
        "note": (
            "NOT the shipped model. The served artefact is exported from the PyTorch run "
            "by ml/export_neural.mjs. This file exists so the PyTorch result can be "
            "independently corroborated."
        ),
        "framework": "tensorflow",
        "frameworkVersion": tf.__version__,
        "kerasVersion": keras.__version__,
        "algorithm": f"MLP {len(feature_order)}-{HIDDEN_1}-{HIDDEN_2}-1, ReLU, sigmoid output",
        "hyperparameters": {
            "hidden": [HIDDEN_1, HIDDEN_2],
            "activation": "relu",
            "optimiser": "adam",
            "learningRate": LEARNING_RATE,
            "weightDecay": WEIGHT_DECAY,
            "loss": "BinaryCrossentropy(from_logits=True)",
            "positiveClassWeight": round(pos_weight, 6),
            "epochs": best_epoch,
            "maxEpochs": MAX_EPOCHS,
            "earlyStopPatience": EARLY_STOP_PATIENCE,
            "validationFraction": VALIDATION_FRACTION,
            "batch": "full",
            "randomSeed": RANDOM_SEED,
            "initialiser": "glorot_uniform kernel / zeros bias (Keras default)",
        },
        "epochSelection": {
            "method": "best validation ROC-AUC on a stratified 20% slice of the train split",
            "bestEpoch": best_epoch,
            "validationRocAuc": best_auc,
            "note": "The held-out test split was not used to choose any hyperparameter.",
        },
        "featureOrder": feature_order,
        "standardisation": split["standardisation"],
        "riskBands": bands,
        "parameterCount": int(sum(int(np.prod(w.shape)) for w in weights)),
        "weights": {
            # Keras stores Dense kernels as [inputs][outputs]; transposed here to the
            # [outputs][inputs] layout the PyTorch export and the JS artefact use, so
            # the two files can be diffed directly.
            "l1": {"weight": weights[0].T.tolist(), "bias": weights[1].tolist()},
            "l2": {"weight": weights[2].T.tolist(), "bias": weights[3].tolist()},
            "out": {"weight": weights[4].T.tolist(), "bias": weights[5].tolist()},
        },
        "metrics": {"train": train_metrics, "test": test_metrics},
        "heldOutBandSummary": held_out_bands,
        "bandsMonotonic": monotonic_bands(held_out_bands),
        "testProbabilities": [float(p) for p in p_test],
        "comparisonWithPyTorch": comparison,
    }

    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(f"{json.dumps(payload, indent=2)}\n", encoding="utf8")

    print(f"\nParameters: {payload['parameterCount']}")
    print(f"Wrote {OUTPUT_PATH.relative_to(REPO_ROOT)}  (comparison artefact, not shipped)")
    print("\nNothing in shared/risk/ was touched. Side-by-side view: npm run ml:compare:all")


def band_summary_key(probability: float, bands: dict) -> str:
    """Band for a single probability. Local helper so the agreement rate above reads cleanly."""
    p = float(probability)
    if p >= bands["high"]:
        return "HIGH"
    if p >= bands["moderate"]:
        return "MODERATE"
    return "LOW"


if __name__ == "__main__":
    main()
