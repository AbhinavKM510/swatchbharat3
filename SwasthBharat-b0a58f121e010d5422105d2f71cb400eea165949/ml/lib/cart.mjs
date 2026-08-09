/**
 * Minimal, dependency-free CART (Classification And Regression Tree) implementation
 * for binary classification, deliberately mirroring scikit-learn's
 * DecisionTreeClassifier defaults that matter for this project:
 *
 *   - criterion="gini"
 *   - splitter="best" (exhaustive scan of midpoint thresholds)
 *   - class_weight="balanced" (optional, on by default here)
 *   - max_depth / min_samples_leaf / min_samples_split honoured
 *
 * Why this exists: the project's runtime risk engine is plain JavaScript (no Python
 * service in the demo path). Having the trainer in Node too means the exported tree
 * can be regenerated and verified on any machine with Node installed, even when a
 * Python toolchain is not available. `ml/train_model.py` remains the reference
 * scikit-learn implementation and produces the same artefact format.
 *
 * This is NOT a general-purpose ML library. It is ~200 lines of transparent code so
 * that a reviewer can confirm the model is really fitted from data rather than
 * hand-written.
 */

/** Deterministic PRNG (mulberry32) so train/test splits are reproducible. */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffleInPlace(arr, rng) {
  for (let i = arr.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return 0;
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Gini impurity from weighted class totals.
 * gini = 1 - sum_c p_c^2
 */
function gini(weightNeg, weightPos) {
  const total = weightNeg + weightPos;
  if (total <= 0) return 0;
  const p0 = weightNeg / total;
  const p1 = weightPos / total;
  return 1 - (p0 * p0 + p1 * p1);
}

/**
 * Fit a binary-classification CART.
 *
 * @param {number[][]} X            samples x features
 * @param {number[]}   y            0/1 labels
 * @param {object}     options
 * @param {string[]}   options.featureNames
 * @param {number}     [options.maxDepth=4]
 * @param {number}     [options.minSamplesLeaf=20]
 * @param {number}     [options.minSamplesSplit=2]
 * @param {boolean}    [options.balanceClasses=true]
 * @returns {{root: object, nodeCount: number, leafCount: number, classWeights: number[],
 *            featureImportances: Record<string, number>}}
 */
export function fitDecisionTree(X, y, options) {
  const {
    featureNames,
    maxDepth = 4,
    minSamplesLeaf = 20,
    minSamplesSplit = 2,
    balanceClasses = true,
  } = options;

  const nSamples = X.length;
  const nFeatures = featureNames.length;

  const countPos = y.reduce((acc, v) => acc + (v === 1 ? 1 : 0), 0);
  const countNeg = nSamples - countPos;

  // scikit-learn's class_weight="balanced": n_samples / (n_classes * n_c)
  const classWeights = balanceClasses
    ? [nSamples / (2 * Math.max(countNeg, 1)), nSamples / (2 * Math.max(countPos, 1))]
    : [1, 1];

  const sampleWeight = y.map((label) => classWeights[label]);

  const importanceAccumulator = new Array(nFeatures).fill(0);
  let nodeCounter = 0;

  function weightedTotals(indices) {
    let wNeg = 0;
    let wPos = 0;
    for (const i of indices) {
      if (y[i] === 1) wPos += sampleWeight[i];
      else wNeg += sampleWeight[i];
    }
    return { wNeg, wPos };
  }

  function bestSplit(indices) {
    const { wNeg, wPos } = weightedTotals(indices);
    const parentImpurity = gini(wNeg, wPos);
    const parentWeight = wNeg + wPos;

    let best = null;

    for (let f = 0; f < nFeatures; f += 1) {
      // Sort sample indices by this feature's value.
      const ordered = [...indices].sort((a, b) => X[a][f] - X[b][f]);

      let leftNeg = 0;
      let leftPos = 0;

      for (let k = 0; k < ordered.length - 1; k += 1) {
        const idx = ordered[k];
        if (y[idx] === 1) leftPos += sampleWeight[idx];
        else leftNeg += sampleWeight[idx];

        const vCurrent = X[ordered[k]][f];
        const vNext = X[ordered[k + 1]][f];
        // Only consider a threshold where the value actually changes.
        if (vCurrent === vNext) continue;

        const leftCount = k + 1;
        const rightCount = ordered.length - leftCount;
        if (leftCount < minSamplesLeaf || rightCount < minSamplesLeaf) continue;

        const rightNeg = wNeg - leftNeg;
        const rightPos = wPos - leftPos;
        const leftWeight = leftNeg + leftPos;
        const rightWeight = rightNeg + rightPos;
        if (leftWeight <= 0 || rightWeight <= 0) continue;

        const childImpurity =
          (leftWeight / parentWeight) * gini(leftNeg, leftPos) +
          (rightWeight / parentWeight) * gini(rightNeg, rightPos);
        const gain = parentImpurity - childImpurity;

        if (!best || gain > best.gain + 1e-12) {
          best = {
            featureIndex: f,
            // Midpoint threshold, same convention as scikit-learn ("<= threshold" goes left).
            threshold: (vCurrent + vNext) / 2,
            gain,
            parentImpurity,
            parentWeight,
          };
        }
      }
    }

    return best;
  }

  function build(indices, depth) {
    const { wNeg, wPos } = weightedTotals(indices);
    const rawPos = indices.reduce((acc, i) => acc + (y[i] === 1 ? 1 : 0), 0);
    const nodeId = nodeCounter;
    nodeCounter += 1;

    const node = {
      id: nodeId,
      depth,
      samples: indices.length,
      rawPositives: rawPos,
      rawNegatives: indices.length - rawPos,
      weightedPositives: Number(wPos.toFixed(6)),
      weightedNegatives: Number(wNeg.toFixed(6)),
      probability: Number((wPos / Math.max(wNeg + wPos, 1e-12)).toFixed(6)),
      rawPositiveRate: Number((rawPos / Math.max(indices.length, 1)).toFixed(6)),
      impurity: Number(gini(wNeg, wPos).toFixed(6)),
    };

    const pure = wNeg === 0 || wPos === 0;
    if (depth >= maxDepth || pure || indices.length < minSamplesSplit || indices.length < 2 * minSamplesLeaf) {
      node.type = 'leaf';
      return node;
    }

    const split = bestSplit(indices);
    if (!split || split.gain <= 1e-12) {
      node.type = 'leaf';
      return node;
    }

    const leftIndices = [];
    const rightIndices = [];
    for (const i of indices) {
      if (X[i][split.featureIndex] <= split.threshold) leftIndices.push(i);
      else rightIndices.push(i);
    }

    // scikit-learn style importance: weighted impurity decrease, accumulated per feature.
    importanceAccumulator[split.featureIndex] += (split.parentWeight / 1) * split.gain;

    node.type = 'split';
    node.feature = featureNames[split.featureIndex];
    node.featureIndex = split.featureIndex;
    node.threshold = Number(split.threshold.toFixed(4));
    node.gain = Number(split.gain.toFixed(6));
    node.left = build(leftIndices, depth + 1);
    node.right = build(rightIndices, depth + 1);
    return node;
  }

  const allIndices = Array.from({ length: nSamples }, (_, i) => i);
  const root = build(allIndices, 0);

  const importanceSum = importanceAccumulator.reduce((a, b) => a + b, 0) || 1;
  const featureImportances = {};
  featureNames.forEach((name, i) => {
    featureImportances[name] = Number((importanceAccumulator[i] / importanceSum).toFixed(6));
  });

  let leafCount = 0;
  (function countLeaves(n) {
    if (n.type === 'leaf') {
      leafCount += 1;
      return;
    }
    countLeaves(n.left);
    countLeaves(n.right);
  })(root);

  return { root, nodeCount: nodeCounter, leafCount, classWeights, featureImportances };
}

/** Walk the tree for one feature vector, returning the leaf and the decision path. */
export function traverse(root, featureVector, featureNames) {
  const path = [];
  let node = root;
  while (node.type === 'split') {
    const value = featureVector[node.featureIndex];
    const goLeft = value <= node.threshold;
    path.push({
      feature: node.feature,
      threshold: node.threshold,
      value,
      operator: goLeft ? '<=' : '>',
      direction: goLeft ? 'left' : 'right',
    });
    node = goLeft ? node.left : node.right;
  }
  return { leaf: node, path };
}

/** Binary classification metrics at a given probability cut-off. */
export function classificationMetrics(yTrue, probabilities, cutoff = 0.5) {
  let tp = 0;
  let tn = 0;
  let fp = 0;
  let fn = 0;
  for (let i = 0; i < yTrue.length; i += 1) {
    const predicted = probabilities[i] >= cutoff ? 1 : 0;
    if (yTrue[i] === 1 && predicted === 1) tp += 1;
    else if (yTrue[i] === 0 && predicted === 0) tn += 1;
    else if (yTrue[i] === 0 && predicted === 1) fp += 1;
    else fn += 1;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const specificity = tn + fp === 0 ? 0 : tn / (tn + fp);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    accuracy: Number(((tp + tn) / yTrue.length).toFixed(4)),
    precision: Number(precision.toFixed(4)),
    recall: Number(recall.toFixed(4)),
    specificity: Number(specificity.toFixed(4)),
    f1: Number(f1.toFixed(4)),
    confusionMatrix: { truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn },
  };
}

/** ROC AUC via the rank-based (Mann-Whitney U) formulation, with tie handling. */
export function rocAuc(yTrue, probabilities) {
  const pairs = probabilities
    .map((p, i) => ({ p, y: yTrue[i] }))
    .sort((a, b) => a.p - b.p);

  // Assign average ranks to ties.
  const ranks = new Array(pairs.length);
  let i = 0;
  while (i < pairs.length) {
    let j = i;
    while (j < pairs.length - 1 && pairs[j + 1].p === pairs[i].p) j += 1;
    const averageRank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) ranks[k] = averageRank;
    i = j + 1;
  }

  let sumRanksPositive = 0;
  let nPos = 0;
  let nNeg = 0;
  pairs.forEach((pair, idx) => {
    if (pair.y === 1) {
      sumRanksPositive += ranks[idx];
      nPos += 1;
    } else {
      nNeg += 1;
    }
  });

  if (nPos === 0 || nNeg === 0) return 0.5;
  const auc = (sumRanksPositive - (nPos * (nPos + 1)) / 2) / (nPos * nNeg);
  return Number(auc.toFixed(4));
}
