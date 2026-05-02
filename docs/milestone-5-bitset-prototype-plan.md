# Milestone 5 – Fast Bitset Solver Prototype Plan

## Scope

Build an opt-in worker solver path that scores candidates using bitset coverage instead of polygon booleans in the hot path.

- Keep current exact worker mode as the default.
- Keep final exports as vector line lists.
- Use exact mode as quality reference, not as implementation dependency per candidate.


## What "bitset solver" means here

Yes—this is effectively a pixel-grid approximation for scoring.

- We choose a fixed analysis raster (for example `512x512` or `1024x1024`) in worker memory.
- Each candidate vector thread strip is rasterized into covered pixel indices and stored as a bitset.
- In practice, this can be implemented with a supercover/Bresenham-style traversal for the centerline plus a thickness rule (dilation or distance check) so strip width is represented.
- Solver scoring then uses bitwise ops + popcount on those covered pixels, instead of polygon boolean operations per candidate.

Important nuance:

- The bitset grid is only for *scoring/state estimation* speed.
- Accepted output lines remain the same vector nail-to-nail exports.
- Exact polygon geometry remains the reference for validation and quality checks.

## Phase 1: Worker data model

1. Add `solverMode` worker option:
   - `exact-global-union` (default)
   - `bitset-prototype` (experimental)
2. For each color bucket, allocate:
   - `targetBitset`
   - `paintedBitset`
3. Precompute per undirected line key:
   - `lineBitset`
   - `lineCoveragePopcount`

## Phase 2: Candidate scoring

For each candidate line in bitset mode:

- `targetGain = popcount(lineBitset & targetBitset & ~paintedBitset)`
- `coverage = lineCoveragePopcount`
- `score = targetGain / coverage`

Choose the highest score using the existing tie-break rules where practical.

## Phase 3: State update

After accepting a line in bitset mode:

- `paintedBitset |= lineBitset`
- Keep existing bucket sequencing, line-distance checks, and export logic unchanged.

## Phase 4: Quality report

Add a script that compares exact vs fast exports/renders and reports:

- Residual target error per color
- Overpaint vs underpaint area
- Render pixel diff statistics
- Optional SSIM/perceptual score when available

## Exit criteria for milestone 5 prototype

- `bitset-prototype` runs end-to-end in worker.
- Baseline exact mode remains default and unchanged for normal users.
- Speedup is measurable at 500+ lines.
- Quality report artifacts are saved in `diagnostics/`.


## Grid resolution guidance (targeting ~99% area agreement)

Short answer: start at **`1024x1024`** for a 300-nail circular board, and expect to move to **`1536x1536`** (or occasionally `2048x2048`) if you want ~99% agreement against exact polygon-area overlap across diverse candidates.

Why this range:

- Quantization error drops roughly with smaller pixel size; doubling linear resolution usually gives a strong reduction in area error.
- The hardest cases are thin grazing overlaps and near-tangent strip intersections; these dominate residual error.
- With thread-strip widths typical of this project, `512x512` is usually too coarse for a strict 99% target, while `1024x1024` is often close and `1536x1536` is a safer default.

Practical recommendation for Milestone 5:

1. Default prototype grid: **`1024x1024`** (speed-first).
2. "High quality" prototype grid: **`1536x1536`**.
3. Keep an escape hatch for **`2048x2048`** for validation runs, not normal solving.

Calibration protocol (required before claiming 99%):

- Sample a fixed candidate set (e.g., 5k–20k candidate checks) across early/mid/late solver states.
- For each sample, compute:
  - exact overlap area from polygon booleans (reference),
  - raster overlap area from bitset mode.
- Track relative area agreement and summary stats (mean, p95, worst-case).
- Choose the smallest grid where p95 (and ideally p99) agreement meets the target threshold.

Important:

- "99%" should be enforced as a dataset-level metric (e.g., p95/p99 agreement), not a per-sample absolute guarantee.
- Even with high agreement on area, line-order decisions can still diverge; quality gates must still compare final renders and residuals.
