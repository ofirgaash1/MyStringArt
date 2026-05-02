# Optimization Milestones

## Overall Goal

We are building a multicolor string-art solver that can select and export geometric/vector thread lines at production scale.

The long-term target is:

- `10-20ms` per accepted line.
- Stable performance up to `20,000` lines.
- Final output remains vector/geometric, so exported art behaves like infinite-resolution geometry.
- Quality must be measured against the current exact solver, not assumed.

The current exact solver is valuable because it gives us a correctness reference, but it uses exact polygon/area operations that get slower as painted geometry grows. The optimization direction is to keep exact mode as the reference implementation and add faster solver modes with explicit quality gates.

## Core Principle

Every solver optimization must answer two questions:

1. Does it produce the exact same exported line list when it claims to preserve exactness?
2. If it intentionally changes the solver model for speed, is final quality measurably close enough to the exact reference?

For exact-preserving optimizations, we use golden exported line lists.

For fast/approximate optimizations, we compare metrics and rendered output against exact mode.

## Current State

- Shared-best solving runs in a worker.
- The worker owns candidate search, current painted geometry, and bucket line state.
- The main thread applies accepted worker lines to canvas/UI state.
- A 2-color Mona Lisa nearest-source golden test exists for the first `100` lines.
- Exact line-list equality has already been used to validate worker-side cache optimizations.

Known bottleneck:

- Exact current-painted overlap still depends on growing geometry complexity.
- Around hundreds of lines, exact polygon/overlap work can become too slow for the `10-20ms/line` target.

## Milestones

### Milestone 5 kickoff status (2026-05-02)

- Milestone 4 confirmed exact candidate-local polygon approaches are not viable in the hot path at scale.
- A concrete implementation plan now exists in `docs/milestone-5-bitset-prototype-plan.md`.
- Next implementation step is adding opt-in `solverMode` (`exact-global-union` default, `bitset-prototype` experimental) in the worker.


### 1. Exact Golden Harness

Goal: make correctness regression checks easy and repeatable.

Tasks:

- Capture golden line exports for the standard 2-color flow at `100`, `500`, and `1000` lines.
- Store ordered line lists and per-color line lists.
- Add a script that runs the flow and compares output exactly against a selected golden.
- Fail on the first differing line.

Exit criteria:

- Exact mode can be regression-tested without manual browser steps.
- Any exact-preserving optimization must pass the golden comparison before it is accepted.

### 2. Exact Solver Profiling at Scale

Goal: measure where time goes as line count grows.

Tasks:

- Record per-line timings for `100`, `500`, `1000`, and `2000` lines.
- Break timings into search, target overlap, current overlap, geometry union/update, canvas application, and UI synchronization.
- Save reports in `diagnostics/`.

Exit criteria:

- We know which part dominates at each scale.
- We can prove whether an optimization is attacking the actual bottleneck.

### 3. Exact-Preserving Cache Improvements

Goal: improve constants without changing output.

Candidate work:

- Cache static line geometry by undirected nail pair.
- Cache static target overlap per color and line.
- Maintain used-line sets incrementally.
- Add spatial indexes for target region rectangles/polygons.
- Add spatial indexes for accepted line bounds while keeping exact current-overlap math.

Validation:

- Must pass exact golden comparisons.

Exit criteria:

- Meaningful speedup on `100`, `500`, and `1000` line goldens.
- No exported line-list differences.

### 4. Candidate-Local Exact Overlap Engine

Goal: replace growing global polygon union with candidate-local exact overlap.

Concept:

- Store accepted thread strips as individual geometric primitives.
- For a candidate strip, query only accepted strips whose bounds intersect it.
- Compute exact union area of accepted-strip intersections inside the candidate strip.
- Use that as `alreadyPaintedOverlap`.

Why:

- Avoids global current geometry becoming more complex forever.
- Keeps exact geometry possible while limiting work to local intersections.

Validation:

- Compare candidate overlap values against current exact polygon solver on sampled candidates.
- Then compare exported line lists against goldens.

Exit criteria:

- Exact line-list match for existing goldens.
- Better scaling at `500+` lines.

### 5. Fast Bitset Solver Prototype

Goal: build a solver that can plausibly reach `10-20ms/line` at high line counts.

Concept:

- Precompute candidate coverage as bitsets.
- Maintain painted coverage as bitsets.
- Score with fast bit operations and popcount.
- Keep final export as vector lines.

Important:

- This solver is not expected to produce the exact same line sequence as the exact solver.
- It must be judged by quality metrics and visual comparison.

Validation metrics:

- Residual target error per color.
- High-resolution rendered pixel difference.
- SSIM or perceptual image difference.
- Color overpaint/underpaint area.
- Side-by-side exact vs fast render.
- Difference heatmap.

Exit criteria:

- Significant speedup over exact mode.
- Quality is close enough to exact reference under agreed thresholds.

### 6. Hybrid Fast-Then-Exact Solver

Goal: preserve quality while keeping most of the speed.

Concept:

- Fast bitset solver generates top `K` candidate lines.
- Exact geometry scorer chooses among those `K`.
- Increase `K` until quality is close enough.

Validation:

- Compare against exact solver line lists for small `K` experiments.
- Compare final quality metrics for longer runs.

Exit criteria:

- Much faster than full exact scan.
- Better quality than pure bitset mode.
- Tunable `K` gives a clear speed/quality tradeoff.

### 7. Production-Scale Run

Goal: demonstrate the actual target.

Tasks:

- Run `20,000` lines on a standard image/palette.
- Track per-line time distribution throughout the run.
- Export final vector art.
- Produce quality report.

Exit criteria:

- Sustained `10-20ms/line` target is met or blockers are documented.
- Final vector output passes visual and metric quality gates.

## Quality Gate Philosophy

Exactness is binary for exact-preserving work: the exported line list must match.

Quality is measured for fast solver work: the line list may differ, but the final art must be close enough by metrics and visual inspection.

We should not accept a fast solver because it "looks okay" once. We need repeatable reports, standard fixtures, and thresholds that can fail.

