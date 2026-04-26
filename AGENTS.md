# Working Agreement

This repo is implementing the algorithm described in `new.txt`.

## Source of Truth

- `new.txt` is the product and algorithm spec.
- When behavior in code and `new.txt` disagree, prefer `new.txt` unless the user explicitly decides otherwise.

## Milestone Workflow

- Work in small milestones.
- Each milestone should be visually and interactively testable.
- Milestones do not need to be tiny. Prefer meaningful vertical slices when several closely related changes belong together and can still be tested clearly in the UI.
- Good milestone outputs include things like:
  - toggles
  - overlays
  - coloring
  - drawing
  - visibility states
  - ranking displays
  - stats panels
- After each milestone:
  - Codex implements it
  - the user manually tests it visually
  - the user approves or reports issues
  - only then move to the next milestone
- When the user says `good, next`, Codex chooses the next sensible milestone from `new.txt`.
- Chosen milestones should follow the spec order when practical, but Codex may pick a nearby prerequisite or UI-supporting step if that makes the next testable milestone clearer.
- Prefer bigger milestones when they create a clearer end-to-end behavior for manual approval, instead of splitting one concept into too many thin steps.

## Definition of Done for a Milestone

- The feature is visible in the UI.
- The feature can be manually checked without reading code.
- Codex explains exactly how to test it and what result is expected.
- If a milestone is not easily testable in the UI yet, it should be split again.

## Current Implementation Status

The app is implementing the multicolor thread-art algorithm in `new.txt`. The current work is in the TAS/SCCL/connector/global-order phase.

Implemented and visually testable:

- TAS chord network generation from nails.
- TAS region inspection with selected-D and all-D view modes.
- Pixel ownership preview for selected TAS region.
- TAS palette-fit preview for selected D, with SVG rendering for vector-true zoom.
- Active A-limit per region, preserving the selected low-error tail inside each region.
- Same-color chord lists (SCCLs), with scope toggle:
  - `Global SCCL` uses active A-limited rows from all enabled regions.
  - `D# SCCL` uses active A-limited rows only from the selected D.
- Global SCCL ordering now follows the spec more closely:
  - active rows are collected region-by-region from inner to outer,
  - each region applies the A-limit,
  - selected region order is preserved before splitting by color.
- Greedy SCCL continuity planning:
  - continuous rows are chained by shared endpoint where possible,
  - missing continuity is shown as connector gaps.
- Connector search UI:
  - direct and multi-string connector candidates,
  - connector rows show string path, D path, error, length, damage, and outward reach,
  - candidate ranking uses damage first, then error, then shorter length, then closer outer region.
- Selected connector preview:
  - two SCCL endpoint strings draw in black,
  - connector strings draw in yellow,
  - full nail-to-nail strings are drawn, not only TAS tangent segments.
- Global winding-order preview:
  - interleaves active color lists by innermost available region,
  - breaks same-region ties by larger error,
  - rows are clickable and highlight their full string in the preview.

Important corrections already made:

- Preview zoom no longer changes TAS geometry/radius values.
- `Selected SCCL chain` no longer disappears only because the D slider is on a low D; use the SCCL scope toggle to choose global or selected-D behavior.
- Clicking connector candidates no longer recolors connector strings as black; only SCCL endpoints are black.
- Single-string connector candidates now pass the actual connector chord key into the preview.
- The sidebar was widened and horizontally contained to reduce overflow.
- Palette-fit rendering was tested as canvas for performance, then reverted to SVG because vector zoom and stroke behavior are more important for visual inspection.

Known remaining gaps:

- SCCL continuity planning is still greedy. It does not yet implement the full `new.txt` goal of finding the longest possible natural chain within each region and pushing that chain toward the end of the region sequence.
- Connector insertion is visual/planning-level. Generated connector chords are not yet inserted into final color lists as durable drawing-order objects.
- Connector reuse/removal rules from `new.txt` are not fully implemented:
  - reused active connector chords are not yet removed from later active drawing lists,
  - duplicate drawing prevention is not complete.
- Global winding order previews active TAS chords, but does not yet include generated connectors as final inserted rows.
- All-region palette fit at 300 nails can still be heavy; selected-D fit is the safer default.

## Communication Style

- Keep scope tight.
- Prefer one milestone at a time.
- When finishing a milestone, report:
  - what changed
  - how to test it
  - what expected result should appear
