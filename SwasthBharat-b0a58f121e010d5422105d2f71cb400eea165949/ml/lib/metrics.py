"""
Evaluation metrics shared by the Python trainers.

These are deliberate reimplementations of the functions in ml/lib/cart.mjs rather than
scikit-learn calls, for two reasons:

  1. Comparability. The decision tree's published numbers come from cart.mjs. If the
     neural models were scored by scikit-learn instead, small differences in tie
     handling or rounding would show up as differences between models, which is
     exactly what the comparison is supposed to measure. Same code, same conventions,
     same rounding.
  2. Dependencies. numpy only. The neural pipeline therefore runs in an environment
     with just numpy + torch (or + tensorflow), which is what the project's .venv312
     actually has — it has no pandas and no scikit-learn.

Every function mirrors its cart.mjs counterpart, including the 4-decimal rounding and
the average-rank tie handling in ROC-AUC.

Imported as `from lib.metrics import ...` — the trainers run as `python ml/x.py`, so
ml/ is sys.path[0] and `lib` resolves as an implicit namespace package.
"""

from __future__ import annotations

import numpy as np


def classification_metrics(y_true: np.ndarray, probabilities: np.ndarray, cutoff: float = 0.5) -> dict:
    """Binary classification metrics at a probability cut-off.

    Mirrors classificationMetrics() in ml/lib/cart.mjs, including its convention of
    returning 0 rather than NaN for an undefined ratio.
    """
    y_true = np.asarray(y_true)
    probabilities = np.asarray(probabilities)
    predicted = (probabilities >= cutoff).astype(int)

    tp = int(np.sum((y_true == 1) & (predicted == 1)))
    tn = int(np.sum((y_true == 0) & (predicted == 0)))
    fp = int(np.sum((y_true == 0) & (predicted == 1)))
    fn = int(np.sum((y_true == 1) & (predicted == 0)))

    precision = 0.0 if tp + fp == 0 else tp / (tp + fp)
    recall = 0.0 if tp + fn == 0 else tp / (tp + fn)
    specificity = 0.0 if tn + fp == 0 else tn / (tn + fp)
    f1 = 0.0 if precision + recall == 0 else (2 * precision * recall) / (precision + recall)

    return {
        "accuracy": round((tp + tn) / len(y_true), 4),
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "specificity": round(specificity, 4),
        "f1": round(f1, 4),
        "confusionMatrix": {
            "truePositive": tp,
            "falsePositive": fp,
            "trueNegative": tn,
            "falseNegative": fn,
        },
    }


def roc_auc(y_true: np.ndarray, probabilities: np.ndarray) -> float:
    """ROC AUC via the rank-based (Mann-Whitney U) formulation, with tie handling.

    Ties get the average rank. That matters here: a decision tree assigns the same
    probability to every patient reaching the same leaf, so ties are the norm rather
    than an edge case, and mishandling them would flatter or penalise the tree
    relative to the neural models.

    Uses a stable sort so the result does not depend on input order.
    """
    y_true = np.asarray(y_true)
    probabilities = np.asarray(probabilities, dtype=float)

    n_pos = int(np.sum(y_true == 1))
    n_neg = int(np.sum(y_true == 0))
    if n_pos == 0 or n_neg == 0:
        return 0.5

    order = np.argsort(probabilities, kind="mergesort")
    sorted_p = probabilities[order]
    ranks = np.empty(len(probabilities), dtype=float)

    i = 0
    while i < len(sorted_p):
        j = i
        while j < len(sorted_p) - 1 and sorted_p[j + 1] == sorted_p[i]:
            j += 1
        ranks[i : j + 1] = (i + j) / 2.0 + 1.0
        i = j + 1

    sum_ranks_positive = float(np.sum(ranks[y_true[order] == 1]))
    auc = (sum_ranks_positive - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)
    return round(auc, 4)


def band_of(probability: float, bands: dict) -> str:
    """Maps a probability to a risk band. Mirrors bandForProbability() in the artefacts."""
    if probability >= bands["high"]:
        return "HIGH"
    if probability >= bands["moderate"]:
        return "MODERATE"
    return "LOW"


def band_summary(y_true: np.ndarray, probabilities: np.ndarray, bands: dict) -> dict:
    """How many patients land in each band, and how many of those are actually diabetic.

    This is the check that decided which model ships. A band that almost nobody falls
    into carries no triage information, however good the headline accuracy is: it was
    why scikit-learn's tree was rejected despite better recall (1.3% of held-out
    patients in MODERATE). The neural models are held to the same standard.
    """
    y_true = np.asarray(y_true)
    probabilities = np.asarray(probabilities)

    out = {}
    for name in ("LOW", "MODERATE", "HIGH"):
        mask = np.array([band_of(float(p), bands) == name for p in probabilities], dtype=bool)
        total = int(np.sum(mask))
        positives = int(np.sum(y_true[mask] == 1)) if total else 0
        out[name] = {
            "patients": total,
            "actualDiabetic": positives,
            "actualDiabeticRate": round(positives / total, 4) if total else None,
            "share": round(total / len(probabilities), 4) if len(probabilities) else 0,
        }
    return out


def stratified_indices(y: np.ndarray, fraction: float, seed: int) -> tuple[np.ndarray, np.ndarray]:
    """Deterministic stratified holdout carved out of the TRAIN split.

    Returns (fit_indices, holdout_indices).

    This exists so an epoch count can be chosen without ever looking at the real
    held-out test set. Selecting epochs on the test set makes the reported accuracy
    optimistic in a way that is easy to miss and impossible to defend, and it is the
    single most common way a small-dataset neural result turns out to be inflated.
    """
    y = np.asarray(y)
    rng = np.random.default_rng(seed)
    holdout_parts, fit_parts = [], []

    for label in (0, 1):
        idx = rng.permutation(np.where(y == label)[0])
        n_holdout = int(round(len(idx) * fraction))
        holdout_parts.append(idx[:n_holdout])
        fit_parts.append(idx[n_holdout:])

    return np.sort(np.concatenate(fit_parts)), np.sort(np.concatenate(holdout_parts))


def monotonic_bands(summary: dict) -> bool:
    """True when the actual-diabetic rate rises LOW -> MODERATE -> HIGH.

    Monotonic separation is what makes the bands usable for triage regardless of the
    calibration caveat: a patient the model puts in HIGH really is more likely to be
    diabetic than one it puts in LOW. Empty bands are ignored rather than treated as 0.
    """
    rates = [
        summary[band]["actualDiabeticRate"]
        for band in ("LOW", "MODERATE", "HIGH")
        if summary[band]["actualDiabeticRate"] is not None
    ]
    return all(a <= b for a, b in zip(rates, rates[1:]))
