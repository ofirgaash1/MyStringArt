# Shared-State Loop UI Count Timing After Bucket Commit Decoupling

Flow:
- Loaded built-in `mona_lisa.PNG`
- Algorithm mode
- Nails: 180
- Find colors: 2
- Find best palette
- Source: nearest
- Shared-state loop

Measurement method:
- `window.__totalLineCountCommitEvents` records `Date.now()` and `performance.now()` each time the UI-visible total line count commits.
- The displayed line count now comes from a lightweight shared-loop counter while the loop is running.
- Full `multicolorLineBuckets` React state commits are skipped during algorithm mode and flushed when the loop stops.

Result for first 80 UI line-count commits:

| Counts | Avg UI count delta | Max UI count delta | Avg solver apply time |
| --- | ---: | ---: | ---: |
| 1-20 | 78.9 ms | 89 ms | 81.0 ms |
| 21-40 | 94.1 ms | 103 ms | 90.2 ms |
| 41-60 | 106.1 ms | 128 ms | 101.7 ms |
| 61-80 | 114.8 ms | 139 ms | 110.6 ms |

Before this change, the same class of algorithm-mode measurement showed multi-second count commit gaps caused by waiting on full bucket state/render commits. After disabling periodic full bucket commits in algorithm mode, the UI count timing tracks the solver apply time instead of the expensive bucket render path.

Remaining caveat:
- In art mode, full bucket state is still flushed periodically so preview polygons can appear while the loop runs. That means art mode can still pay expensive SVG/bucket render costs. Algorithm mode now avoids that cost until stop/final flush.

