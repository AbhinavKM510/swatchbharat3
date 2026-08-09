"""
Trains the neural second-opinion model for the diabetes risk engine (PyTorch).

    node ml/prepare_dataset.mjs     # once, produces the shared split
    python ml/train_neural.py       # this script
    node ml/export_neural.mjs       # renders the shipped JS artefact

Output:
    ml/export/neural_weights.json   <- weights, standardisation, torch-side metrics

WHAT THIS SCRIPT DOES NOT DO
----------------------------
It does not write anything into shared/risk/, and it does not decide the numbers that
end up on the model card. It trains and exports weights; `ml/export_neural.mjs` then
runs the *shipped JavaScript* forward pass over the same held-out split and computes
the metrics from that. The reason is honesty: PyTorch accumulates in float32, the
browser runs float64, and the artefact the patient is actually scored by is the
JavaScript one. Publishing torch's accuracy for a model served by JS would be
publishing a number that describes something we do not ship.

To make that verifiable rather than asserted, this script also exports torch's own
held-out probabilities. The Node exporter compares them element-wise against its own
and reports the maximum divergence, which is expected to be ~1e-7 (float32 rounding).

WHY A NEURAL NET AT ALL
-----------------------
The decision tree stays authoritative for the risk band; see ml/README.md. The tree
is capped at depth 4 so every prediction reads back as at most four comparisons, and
its three risk bands are all populated on held-out data. What it cannot do is say how
much each of the eight inputs contributed. This model supplies that, via integrated
gradients, and acts as a second opinion whose disagreement with the tree is itself a
signal worth surfacing to a doctor.

ARCHITECTURE
------------
8 inputs -> z-score -> Dense(16, ReLU) -> Dense(8, ReLU) -> Dense(1) -> sigmoid

Deliberately tiny. 289 parameters is roughly 4 KB of JavaScript, which keeps the
"trained model ships as plain JS, precached for offline use" property that the whole
architecture depends on. A larger network would score marginally better and break it.

DATA PROVENANCE / LIMITATION (same caveat as the tree, restated because it applies
identically here): the Pima Indians Diabetes dataset describes adult Pima Native
American women. It is not representative of rural India. The feature-to-risk
directions transfer across populations; the absolute calibration does not. Prototype
only — retrain on ICMR-INDIAB or NFHS-5 cohort data before any real deployment.

Requires: numpy, torch. Deliberately NOT pandas or scikit-learn, so this runs in the
project's .venv312 with no additional installs.
"""

from __future__ import annotations

import json
import os
import random
import sys
from pathlib import Path

import numpy as np

from lib.metrics import band_summary, classification_metrics, roc_auc, stratified_indices

try:
    import torch
    import torch.nn as nn
except ImportError:  # pragma: no cover - guidance path
    sys.exit(
        "PyTorch is not installed in this interpreter.\n"
        "  python -m pip install --only-binary=:all: torch\n"
        "See ml/requirements.txt."
    )

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parent
EXPORT_DIR = HERE / "export"
SPLIT_PATH = EXPORT_DIR / "dataset_split.json"
OUTPUT_PATH = EXPORT_DIR / "neural_weights.json"

RANDOM_SEED = 42
HIDDEN_1 = 16
HIDDEN_2 = 8
LEARNING_RATE = 0.01
WEIGHT_DECAY = 1e-4
MAX_EPOCHS = 1200
VALIDATION_FRACTION = 0.2
# Patience is in epochs of no validation improvement, not steps: training is
# full-batch, so one epoch is one gradient step and the curve is smooth.
EARLY_STOP_PATIENCE = 150


# ---------------------------------------------------------------------------
# Determinism
# ---------------------------------------------------------------------------
def seed_everything(seed: int) -> None:
    """Full-batch training on CPU is deterministic once every RNG is pinned."""
    os.environ["PYTHONHASHSEED"] = str(seed)
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.use_deterministic_algorithms(True)


# ---------------------------------------------------------------------------
# Model
# ---------------------------------------------------------------------------
class RiskNet(nn.Module):
    """Plain MLP. No dropout or batch-norm: both would have to be reimplemented in
    the JavaScript forward pass for zero benefit at this size, and batch-norm in
    particular introduces train/eval behaviour differences that are an easy source of
    a silent serving bug."""

    def __init__(self, n_features: int) -> None:
        super().__init__()
        self.l1 = nn.Linear(n_features, HIDDEN_1)
        self.l2 = nn.Linear(HIDDEN_1, HIDDEN_2)
        self.out = nn.Linear(HIDDEN_2, 1)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        h = torch.relu(self.l1(x))
        h = torch.relu(self.l2(h))
        return self.out(h).squeeze(-1)


def train(
    x: torch.Tensor,
    y: torch.Tensor,
    pos_weight: torch.Tensor,
    epochs: int,
    seed: int,
    x_val: torch.Tensor | None = None,
    y_val: np.ndarray | None = None,
) -> tuple[RiskNet, int, float]:
    """Full-batch training. Returns (model, best_epoch, best_val_auc).

    When a validation set is supplied the best epoch by validation ROC-AUC is
    tracked and its weights restored. Without one, it simply trains for `epochs`.
    """
    seed_everything(seed)
    model = RiskNet(x.shape[1])
    criterion = nn.BCEWithLogitsLoss(pos_weight=pos_weight)
    optimiser = torch.optim.Adam(model.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)

    best_auc = -1.0
    best_epoch = epochs
    best_state = None
    since_improved = 0

    for epoch in range(1, epochs + 1):
        model.train()
        optimiser.zero_grad()
        loss = criterion(model(x), y)
        loss.backward()
        optimiser.step()

        if x_val is None:
            continue

        model.eval()
        with torch.no_grad():
            val_p = torch.sigmoid(model(x_val)).numpy()
        auc = roc_auc(y_val, val_p)

        if auc > best_auc:
            best_auc = auc
            best_epoch = epoch
            best_state = {k: v.detach().clone() for k, v in model.state_dict().items()}
            since_improved = 0
        else:
            since_improved += 1
            if since_improved >= EARLY_STOP_PATIENCE:
                print(f"  early stop at epoch {epoch} (no gain for {EARLY_STOP_PATIENCE})")
                break

    if best_state is not None:
        model.load_state_dict(best_state)

    model.eval()
    return model, best_epoch, best_auc


def main() -> None:
    if not SPLIT_PATH.exists():
        sys.exit(
            f"Shared split not found at {SPLIT_PATH.relative_to(REPO_ROOT)}\n"
            "Run it first:  node ml/prepare_dataset.mjs"
        )

    split = json.loads(SPLIT_PATH.read_text(encoding="utf8"))
    feature_order = split["featureOrder"]
    bands = split["riskBands"]
    mean = np.array(split["standardisation"]["mean"], dtype=np.float64)
    std = np.array(split["standardisation"]["std"], dtype=np.float64)

    x_train_raw = np.array(split["train"]["X"], dtype=np.float64)
    y_train = np.array(split["train"]["y"], dtype=np.int64)
    x_test_raw = np.array(split["test"]["X"], dtype=np.float64)
    y_test = np.array(split["test"]["y"], dtype=np.int64)

    print(f"PyTorch {torch.__version__} | numpy {np.__version__}")
    print(f"Shared split: train {len(y_train)}, held-out {len(y_test)}, features {len(feature_order)}")
    print(f"Architecture: {len(feature_order)} -> {HIDDEN_1} -> {HIDDEN_2} -> 1\n")

    # z-score using the TRAIN-split statistics only
    x_train = ((x_train_raw - mean) / std).astype(np.float32)
    x_test = ((x_test_raw - mean) / std).astype(np.float32)

    # class_weight="balanced" expressed as BCEWithLogitsLoss pos_weight
    n_pos = int(np.sum(y_train == 1))
    n_neg = int(len(y_train) - n_pos)
    pos_weight = torch.tensor(n_neg / n_pos, dtype=torch.float32)
    print(f"Class balance: {n_neg} negative / {n_pos} positive -> pos_weight {float(pos_weight):.4f}")

    xt = torch.tensor(x_train)
    yt = torch.tensor(y_train, dtype=torch.float32)

    # --- Stage 1: choose the epoch count on a validation slice of the TRAIN split
    fit_idx, val_idx = stratified_indices(y_train, VALIDATION_FRACTION, RANDOM_SEED)
    print(f"\nStage 1 - epoch selection on {len(val_idx)} validation rows held out of train")
    _, best_epoch, best_auc = train(
        xt[fit_idx],
        yt[fit_idx],
        pos_weight,
        MAX_EPOCHS,
        RANDOM_SEED,
        x_val=xt[val_idx],
        y_val=y_train[val_idx],
    )
    print(f"  best epoch {best_epoch} (validation ROC-AUC {best_auc})")

    # --- Stage 2: refit on the full train split for exactly that many epochs
    print(f"\nStage 2 - refit on all {len(y_train)} train rows for {best_epoch} epochs")
    model, _, _ = train(xt, yt, pos_weight, best_epoch, RANDOM_SEED)

    with torch.no_grad():
        p_train = torch.sigmoid(model(xt)).numpy().astype(np.float64)
        p_test = torch.sigmoid(model(torch.tensor(x_test))).numpy().astype(np.float64)

    train_metrics = {**classification_metrics(y_train, p_train), "rocAuc": roc_auc(y_train, p_train)}
    test_metrics = {**classification_metrics(y_test, p_test), "rocAuc": roc_auc(y_test, p_test)}
    held_out_bands = band_summary(y_test, p_test, bands)

    print("\nTRAIN metrics:", train_metrics)
    print("TEST  metrics:", test_metrics)
    print("\nHeld-out band spread (a band holding almost nobody is not a band):")
    for name, stats in held_out_bands.items():
        rate = stats["actualDiabeticRate"]
        rate_text = "n/a" if rate is None else f"{rate * 100:.1f}%"
        print(
            f"  {name:<9} {stats['patients']:>4} patients "
            f"({stats['share'] * 100:>5.1f}% of held-out)   actually diabetic: {rate_text}"
        )

    # --- Export ---------------------------------------------------------------
    def layer(linear: nn.Linear) -> dict:
        # float() on a float32 tensor element yields the exact float32 value widened
        # to a double, so the JSON literals are exactly the trained weights.
        return {
            "weight": [[float(v) for v in row] for row in linear.weight.detach()],
            "bias": [float(v) for v in linear.bias.detach()],
        }

    payload = {
        "generatedAt": __import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat(),
        "generatedBy": f"ml/train_neural.py (PyTorch {torch.__version__})",
        "framework": "pytorch",
        "frameworkVersion": torch.__version__,
        "algorithm": f"MLP {len(feature_order)}-{HIDDEN_1}-{HIDDEN_2}-1, ReLU, sigmoid output",
        "hyperparameters": {
            "hidden": [HIDDEN_1, HIDDEN_2],
            "activation": "relu",
            "optimiser": "adam",
            "learningRate": LEARNING_RATE,
            "weightDecay": WEIGHT_DECAY,
            "loss": "BCEWithLogitsLoss",
            "posWeight": round(float(pos_weight), 6),
            "epochs": best_epoch,
            "maxEpochs": MAX_EPOCHS,
            "earlyStopPatience": EARLY_STOP_PATIENCE,
            "validationFraction": VALIDATION_FRACTION,
            "batch": "full",
            "randomSeed": RANDOM_SEED,
        },
        "epochSelection": {
            "method": "best validation ROC-AUC on a stratified 20% slice of the train split",
            "bestEpoch": best_epoch,
            "validationRocAuc": best_auc,
            "note": "The held-out test split was not used to choose any hyperparameter.",
        },
        "featureOrder": feature_order,
        "standardisation": split["standardisation"],
        "attributionBaseline": split["attributionBaseline"],
        "riskBands": bands,
        "weights": {
            "l1": layer(model.l1),
            "l2": layer(model.l2),
            "out": layer(model.out),
        },
        "parameterCount": sum(p.numel() for p in model.parameters()),
        # Cross-check payload. ml/export_neural.mjs recomputes all of this with the
        # shipped JavaScript forward pass and fails if it cannot reproduce it.
        "torchCrossCheck": {
            "metrics": {"train": train_metrics, "test": test_metrics},
            "heldOutBandSummary": held_out_bands,
            "testProbabilities": [float(p) for p in p_test],
        },
    }

    EXPORT_DIR.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(f"{json.dumps(payload, indent=2)}\n", encoding="utf8")

    print(f"\nParameters: {payload['parameterCount']}")
    print(f"Wrote {OUTPUT_PATH.relative_to(REPO_ROOT)}")
    print("\nNext: node ml/export_neural.mjs")


if __name__ == "__main__":
    main()
