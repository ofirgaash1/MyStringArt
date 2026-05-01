# Exact Solver Profile Analysis

## Flow

Standard profile flow:

- Image: `mona_lisa.PNG`
- Nails: `180`
- Mode: algorithm
- Find colors: `2`
- Palette source: `nearest`
- Solver: worker-backed shared-state loop

Raw profile files:

- `diagnostics/profiles/shared-loop-mona-2color-nearest-nails180-lines100.json`
- `diagnostics/profiles/shared-loop-mona-2color-nearest-nails180-lines500.json`
- `diagnostics/profiles/shared-loop-mona-2color-nearest-nails180-lines1000.json`

The profile harness records every accepted line in `events`, including:

- `workerSolveMs`
- `applyMs`
- `workerProfile.bestLineSearchMs`
- `workerProfile.staticMetricMs`
- `workerProfile.currentOverlapMs`
- `workerProfile.stateIntersectionMs`
- `workerProfile.stateUnionMs`
- `workerProfile.stateReindexMs`
- candidate and skip counts

Important interpretation detail: `staticMetricMs` and `currentOverlapMs` are nested inside `bestLineSearchMs`; they explain search time and should not be added on top of it.

## 1000-Line Profile Summary

The full 1000-line run completed in `508121ms`.

| Lines | Worker solve avg | Main apply avg | Search avg | Current overlap avg | State intersection avg | State union avg | Current-overlap candidates avg |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1-100 | 77.21ms | 1.72ms | 38.32ms | 13.68ms | 28.02ms | 10.58ms | 521.34 |
| 101-200 | 140.18ms | 2.09ms | 59.55ms | 44.98ms | 28.65ms | 51.28ms | 514.74 |
| 201-300 | 235.65ms | 2.29ms | 103.69ms | 93.72ms | 28.95ms | 101.80ms | 516.97 |
| 301-400 | 341.97ms | 2.16ms | 135.24ms | 128.73ms | 28.76ms | 174.89ms | 502.79 |
| 401-500 | 430.63ms | 2.36ms | 184.84ms | 179.47ms | 29.53ms | 212.58ms | 495.61 |
| 501-600 | 588.02ms | 2.41ms | 264.19ms | 259.95ms | 28.66ms | 290.61ms | 513.46 |
| 601-700 | 655.27ms | 2.63ms | 286.32ms | 282.47ms | 29.12ms | 333.36ms | 484.36 |
| 701-800 | 771.69ms | 2.45ms | 321.12ms | 317.78ms | 28.87ms | 413.38ms | 489.33 |
| 801-900 | 720.71ms | 2.61ms | 354.67ms | 352.29ms | 28.78ms | 329.02ms | 502.19 |
| 901-1000 | 943.28ms | 2.52ms | 413.72ms | 410.61ms | 28.94ms | 491.49ms | 503.97 |

## Findings

The slowdown is not caused by preview rendering or React state updates in algorithm mode.

Main-thread application stays roughly flat at `1.7-2.6ms/line` through 1000 lines.

The dominant costs are worker-side exact geometry operations:

- Candidate search grows because every step still evaluates roughly `485-521` candidates that survive target/distance filtering and need current-painted overlap checks.
- Current-painted overlap grows from `13.68ms` avg in lines `1-100` to `410.61ms` avg in lines `901-1000`.
- State union grows from `10.58ms` avg in lines `1-100` to `491.49ms` avg in lines `901-1000`.
- State intersection stays almost flat around `29ms`, so it is not the scaling problem.
- Static target metric cost drops after cache warm-up, from `23.88ms` avg in lines `1-100` to low single digits later. Static target caching is working.

The current exact representation is the bottleneck: `currentGeometry` is a growing polygon union, and both candidate overlap and accepted-line union get more expensive as that union becomes more complex.

## Implications

The next exact-preserving optimization should not focus on canvas rendering, React commits, nail lookup, line geometry construction, or static target overlap.

The optimization needs to remove or bypass the growing global current-polygon union from the hot path.

Best next exact-preserving target:

1. Store accepted painted line strips as individual primitives per color.
2. Maintain a spatial index over their bounds.
3. For each candidate strip, query only accepted strips whose bounds intersect the candidate.
4. Compute exact overlap inside the candidate from that local subset.
5. Keep the existing global-union solver as the reference until candidate-local overlap matches golden line lists.

This attacks both observed hotspots:

- `currentOverlapMs`, by replacing overlap against a huge global union with local candidate intersections.
- `stateUnionMs`, by avoiding full global union updates on every accepted line in the scoring path.

## Improvement Ideas

Exact-preserving candidates:

- Candidate-local exact overlap engine using accepted strip bounds plus local polygon clipping.
- Spatial index for accepted strips per color, likely a fixed grid first because line-strip bounds are simple and image-space is bounded.
- Lazy or periodic global union only for diagnostics/render-quality inspection, not per-line scoring.
- Preserve the current exact solver behind a flag for golden validation.

Approximate or hybrid candidates:

- Bitset coverage solver for fast candidate scoring.
- Top-K bitset prefilter followed by exact geometry scoring.
- Quality-gated final comparisons against exact reference, not exact line-list equality.

## Current Conclusion

At 1000 lines, the exact worker is about `47x` slower than the `20ms/line` upper target in the final 100-line range.

To reach `10-20ms/line` up to `20,000` lines, caching alone is not enough. The current global polygon-union representation must be replaced in the scoring hot path.

## Milestone 4 Experiments

Two candidate-local exact paths were tested.

### Candidate-Local Boolean Mode

Mode: `window.__sharedLoopCurrentOverlapMode = 'candidate-local'`

Result: rejected.

Reason:

- It replaces global current-overlap scoring with local accepted-strip queries.
- However, each candidate still performs polygon boolean intersection/union against matching accepted strips.
- The 100-line golden comparison was manually stopped after more than 4 minutes.
- This is slower than the baseline and not a usable path.

### Fragment-Index Mode

Mode: `window.__sharedLoopCurrentOverlapMode = 'fragment-index'`

Result: exact for first 100 lines, rejected for performance.

Evidence:

- 100-line golden comparison passed exact ordered line equality.
- Runtime was `18205ms`, compared with about `9592ms` for the baseline.
- 500-line profile timed out after `300041ms`, reaching only `221` lines.
- Partial profile is saved at `diagnostics/profiles/shared-loop-mona-2color-nearest-nails180-lines500-fragment-index-partial.json`.

Why it failed:

- The mode creates non-overlapping fragments by running `geometryDifference(paintedGeometry, currentGeometry)` for each accepted line.
- That preserves exactness, but the fragment count explodes.
- By lines `101-200`, `stateFragmentDifferenceMs` averaged `1903.35ms`.
- Spatial queries also became too broad: `acceptedStripQueryHitCount` averaged `120159.84` per accepted line in lines `101-200`.

### Revised Milestone 4 Conclusion

Candidate-local exactness is still conceptually useful, but polygon-boolean operations cannot be in either of these hot paths:

- per-candidate local overlap
- per-line fragment difference against growing geometry

The next viable exact or near-exact representation must avoid polygon booleans during solving. The likely next step is a strip-native overlap model:

- represent accepted threads as raw strip primitives
- use spatial indexing over raw strips
- compute candidate overlap in candidate-local coordinates using strip-strip intersection math
- use the exact polygon solver only as a validation/reference path

If exact line-list equality cannot be preserved with the strip-native model, this becomes a hybrid/quality-gated solver rather than an exact-preserving optimization.
