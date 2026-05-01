# Shared-State Loop Mona Lisa Performance Diagnostics

Date: 2026-05-01

Fixture: `mona_lisa.PNG`

Image size: `379 x 357`

Pixel count: `135,303`

Mode: shared-state loop, shared-best stepping, dithered warmup palette.

## Region Polygon Count

The dithered paletted Mona Lisa image currently becomes `78,349` exact region polygons.

This is below `379 * 357 = 135,303`, but it is not dramatically below it. The region count is about `57.9%` of the pixel count.

| Color | Region polygons | Rings |
| --- | ---: | ---: |
| black | 19,905 | 19,905 |
| ivory | 10,777 | 10,777 |
| coral | 17,962 | 17,962 |
| olive | 29,705 | 29,705 |
| total | 78,349 | 78,349 |

Region build time in the browser probe was about `95.4ms`.

Interpretation: exact vertical run merging is working, because the count is below the pixel count, but Floyd-Steinberg dithering still creates many short alternating regions. The vector representation is exact for the dithered image, but it is still a large geometry set.

## Step Timing Spread

Measured from the first 3 shared-state loop steps in a headed Chromium run.

Important finding: the run evaluated `300` candidate nails per color, not `80`. With 4 active colors, that is about `1,200` candidate line checks per shared-best step.

Average timing:

| Logic unit | Average ms | Share of total |
| --- | ---: | ---: |
| shared best line search | 992.13 | 56.2% |
| shared geometry update | 767.57 | 43.5% |
| canvas read | 0.30 | ~0.0% |
| line application | 1.13 | 0.1% |
| canvas write | 0.13 | ~0.0% |
| React state commit | 4.00 | 0.2% |
| total through commit | 1,765.93 | 100% |

The actual drawing operation is not the bottleneck. The expensive work is choosing the line and then updating the vector painted-region union.

## Shared-Best Search Breakdown

Per-color search time is mostly target-region overlap. Line quad construction and line prep are negligible.

Step 1:

| Color | Search ms | Candidates | Valid | Target overlap ms | Target polygons scanned | Bounds hits / clips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| black | 246.9 | 300 | 205 | 244.8 | 5,334,540 | 772,815 |
| ivory | 142.9 | 300 | 232 | 142.2 | 2,888,236 | 607,482 |
| coral | 231.6 | 300 | 268 | 229.6 | 4,813,816 | 997,635 |
| olive | 349.5 | 300 | 268 | 347.2 | 7,960,940 | 1,319,970 |

Step 2:

| Color | Search ms | Candidates | Valid | Target overlap ms | Target polygons scanned | Bounds hits / clips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| black | 240.7 | 300 | 209 | 239.7 | 5,334,540 | 805,355 |
| ivory | 145.9 | 300 | 268 | 145.0 | 2,888,236 | 569,427 |
| coral | 262.3 | 300 | 268 | 260.7 | 4,813,816 | 973,010 |
| olive | 367.2 | 300 | 268 | 365.3 | 7,960,940 | 1,324,977 |

Step 3:

| Color | Search ms | Candidates | Valid | Target overlap ms | Target polygons scanned | Bounds hits / clips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| black | 241.1 | 300 | 215 | 239.6 | 5,334,540 | 821,249 |
| ivory | 141.4 | 300 | 256 | 140.0 | 2,888,236 | 613,495 |
| coral | 240.3 | 300 | 268 | 238.3 | 4,813,816 | 1,008,619 |
| olive | 366.5 | 300 | 268 | 364.2 | 7,960,940 | 1,319,653 |

Per shared-best step, target-overlap scoring scans about:

`5,334,540 + 2,888,236 + 4,813,816 + 7,960,940 = 20,997,532` region polygons.

That is the main search bottleneck.

## Why Polygon Scans Are So High

The current fast path still uses a flat list per color:

1. For each active color bucket, iterate all candidate nails.
2. For each candidate line, build a thin line quad.
3. For each color region polygon, do a bounding-box overlap check.
4. For each bounds hit, clip the polygon against the line quad and compute exact area.

The bounding-box check avoids clipping many polygons, but it does not avoid scanning them. With `300` candidates per color and tens of thousands of polygons per color, the count gets large quickly.

Example: olive has `29,705` polygons. Step 1 scanned `7,960,940` olive polygons, which is roughly `268` non-distance-filtered candidates multiplied by `29,705` polygons.

## Shared Geometry Update Bottleneck

The second large cost is `shared geometry update`, about `754-795ms` per step.

This is the accepted-line update:

1. Intersect the accepted line geometry with the target color geometry.
2. Union that painted geometry into the current painted geometry for that color.
3. Rebuild the geometry area index for that color.

This still uses the general polygon boolean library for `geometryIntersection()` and `geometryUnion()`. It runs only once per accepted line, but it intersects against the large target color geometry, so it is still expensive.

## Non-Bottlenecks

These are not significant in the measured run:

| Logic unit | Typical time |
| --- | ---: |
| line geometry build across all candidates in one color | `<1ms` |
| line prep across all candidates in one color | `<1ms` |
| current painted overlap in early steps | `0-1.1ms` |
| canvas read/write/application | usually `<3ms` total |
| React commit | about `3-6ms` |

## Improvement Ideas

1. Add a spatial index for target regions.

The highest-impact fix is to stop scanning every polygon for every candidate. Use a grid/tile index or row-interval index keyed by image-space bounds. For each line quad, query only tiles/intervals touched by the line bounds, dedupe polygon ids, then clip only those polygons.

Expected effect: reduce target polygon scans from about `21M` per step to the polygons near each line path. This should attack the `~992ms` search hotspot directly without changing quality.

2. Replace accepted-line boolean update with clipped-fragment storage.

For `shared geometry update`, instead of intersecting the line with the full target geometry via general boolean and then unioning, reuse the same spatial query and convex clipping to produce painted fragments. Store accepted painted fragments in an indexed structure.

Quality caveat: to keep exact non-double-counted coverage, current overlap must remain area-correct. A fragment store can do this if later scoring subtracts an exact current index and periodic union/normalization is used, or if per-color painted fragments are kept non-overlapping by exact clipping against already-painted geometry.

3. Cache candidate line geometry and bounds.

The measured line-geometry cost is small, so this is not the first optimization. Still, all nail-pair quads and bounds can be precomputed for a given nail count, image transform, and thread width.

Expected effect: small but easy; less than `1%` of current runtime.

4. Confirm and control nail count in tests.

The diagnostic run attempted to set the nails slider to `80`, but the measured candidate count was `300` per color. Either the control did not update through the current test interaction or the app reverted to the default. The current performance numbers are therefore for the actual 300-nail run. If a test is intended to measure 80 nails, it must assert the resulting candidate count or visible slider value before starting the loop.

5. Consider non-dithered or grouped geometry modes as optional quality/performance modes.

Dithering is a major source of region fragmentation. The current exact mode should remain available, but an optional mode could generate smoother geometric regions from non-dithered palette assignment or from exact same-color connected components. This would be a quality/performance choice and should not replace exact dithered mode by default.

## Current Conclusion

The app is slow because it now does real vector area scoring over `78,349` exact dither-region polygons and evaluates about `1,200` candidate lines per step. About `56%` of the step time is target-overlap search over flat polygon lists, and about `44%` is the accepted-line vector boolean update.

The next implementation target should be a spatial index for target geometry, followed by replacing the accepted-line boolean update with indexed clipped-fragment updates.

## Nearest Source Comparison

Requested follow-up: rerun the same diagnosis with `Source = nearest` instead of `Source = dithered`.

The nearest-source run used the same image, warmup palette, shared-best loop, and headed browser path.

### Nearest Region Polygon Count

With `Source = nearest`, the Mona Lisa image becomes `7,489` exact region polygons.

This is far below `379 * 357 = 135,303`, about `5.5%` of the pixel count.

| Color | Region polygons | Rings |
| --- | ---: | ---: |
| black | 1,495 | 1,495 |
| ivory | 946 | 946 |
| coral | 2,210 | 2,210 |
| olive | 2,838 | 2,838 |
| total | 7,489 | 7,489 |

Nearest region build time in the browser probe was about `60.8ms`.

### Dithered vs Nearest Region Count

| Source | Total polygons | Percent of pixels | Region build ms |
| --- | ---: | ---: | ---: |
| dithered | 78,349 | 57.9% | 95.4 |
| nearest | 7,489 | 5.5% | 60.8 |

Nearest has about `10.46x` fewer region polygons than dithered.

### Nearest Step Timing Spread

Average timing across the first 3 shared-state loop steps:

| Logic unit | Average ms | Share of total |
| --- | ---: | ---: |
| shared best line search | 121.37 | 61.0% |
| shared geometry update | 71.27 | 35.8% |
| canvas read | 0.27 | 0.1% |
| line application | 2.73 | 1.4% |
| canvas write | 0.13 | 0.1% |
| React state commit | 2.73 | 1.4% |
| total through commit | 198.90 | 100% |

The expensive shape is the same as dithered, but the absolute cost is much lower because the target geometries are much smaller.

### Dithered vs Nearest Step Timing

| Source | Total step ms | Shared-best search ms | Shared geometry update ms |
| --- | ---: | ---: | ---: |
| dithered | 1,765.93 | 992.13 | 767.57 |
| nearest | 198.90 | 121.37 | 71.27 |

Nearest is about `8.88x` faster overall in this probe.

### Nearest Search Breakdown

Step 1:

| Color | Search ms | Candidates | Valid | Target overlap ms | Bound-check scans | Bounds hits / clips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| black | 38.9 | 300 | 200 | 37.6 | 400,660 | 69,889 |
| ivory | 12.3 | 300 | 139 | 11.4 | 253,528 | 40,348 |
| coral | 31.8 | 300 | 213 | 30.8 | 592,280 | 111,308 |
| olive | 48.4 | 300 | 268 | 47.0 | 760,584 | 130,868 |

Step 2:

| Color | Search ms | Candidates | Valid | Target overlap ms | Bound-check scans | Bounds hits / clips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| black | 26.7 | 300 | 212 | 25.3 | 400,660 | 64,135 |
| ivory | 12.6 | 300 | 183 | 11.9 | 253,528 | 41,875 |
| coral | 29.7 | 300 | 264 | 28.9 | 592,280 | 117,267 |
| olive | 39.6 | 300 | 268 | 38.4 | 760,584 | 139,903 |

Step 3:

| Color | Search ms | Candidates | Valid | Target overlap ms | Bound-check scans | Bounds hits / clips |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| black | 41.9 | 300 | 197 | 41.3 | 400,660 | 57,378 |
| ivory | 11.8 | 300 | 123 | 10.6 | 253,528 | 40,601 |
| coral | 32.5 | 300 | 174 | 31.5 | 592,280 | 117,431 |
| olive | 37.9 | 300 | 268 | 36.2 | 760,584 | 125,782 |

Per nearest shared-best step, target-overlap scoring does about:

`400,660 + 253,528 + 592,280 + 760,584 = 2,007,052` bound-check scans.

That is about `10.46x` fewer than the dithered run's `20,997,532` bound-check scans per step.

### Nearest Interpretation

Nearest confirms the bottleneck model:

1. Runtime tracks region polygon count closely.
2. Candidate count stayed at `300` per color.
3. Search is still dominated by target overlap.
4. Accepted-line geometry update is still the second hotspot, but it drops from about `768ms` to about `71ms` because the target geometry is much smaller.

Nearest mode is already usable at around `0.2s` per step in this run. Dithered mode is slow because it is a much more fragmented exact vector target, not because the line drawing or React rendering is expensive.
