import { useEffect, useRef } from 'react';
import {
  clonePalettePreset,
  drawImageDataToCanvas,
  MULTICOLOR_DEBUG_VIEWS,
  MULTICOLOR_PALETTE_PRESETS,
} from '../multicolor';

const DEBUG_VIEW_LABELS = {
  original: 'original',
  'current-grayscale': 'grayscale',
  'palette-preview': 'preview',
  'color-mask': 'isolate',
};

function MulticolorLab({
  activePaletteColor,
  activePaletteColorId,
  activeColorExperimentFromIndex,
  activeColorExperimentNextNailNumber,
  activeExperimentalLineCount,
  blurredActiveMaskImage,
  ditheredComparisonCanvasRef,
  enabledPalettePreviewColors,
  canUseActiveColorMaskForLineScoring,
  hasOriginalImage,
  isActiveColorOnlyControlVisible,
  isExperimentalColorLinesOnlyPreviewEnabled,
  isExperimentalRoundRobinSteppingEnabled,
  isActivePaletteColorOnlyEnabled,
  isMulticolorLabEnabled,
  isPaletteDitheringEnabled,
  isPaletteMaskVisible,
  isPalettePreviewEnabled,
  maskBlurRadius,
  multicolorDebugView,
  multicolorLineBuckets,
  multicolorMaskImages,
  multicolorPaletteColors,
  multicolorPaletteCoverage,
  multicolorPaletteCoverageWithLineAllocation,
  multicolorPaletteCoverageWithSuggestions,
  multicolorLockedLineOverride,
  multicolorPalettePixelCountMap,
  multicolorPalettePreset,
  multicolorTargetTotalLines,
  onShowAllMulticolorBuckets,
  onSoloMulticolorBucket,
  onToggleMulticolorBucketVisibility,
  originalComparisonCanvasRef,
  onApplyActiveColorExperimentStep,
  paletteComparisonCanvasRef,
  rawActiveMaskImage,
  setActivePaletteColorId,
  setIsActivePaletteColorOnlyEnabled,
  setIsExperimentalColorLinesOnlyPreviewEnabled,
  setIsExperimentalRoundRobinSteppingEnabled,
  setIsMulticolorLabEnabled,
  setIsPaletteDitheringEnabled,
  setIsPalettePreviewEnabled,
  setMaskBlurRadius,
  setMulticolorDebugView,
  setMulticolorLockedLineOverride,
  setMulticolorPaletteColors,
  setMulticolorPalettePresetId,
  setMulticolorTargetTotalLines,
  shouldShowPaletteComparison,
  totalExperimentalMulticolorLines,
  totalAllocatedSuggestedLines,
  totalPaletteCoverageTenths,
}) {
  const rawMaskCanvasRef = useRef(null);
  const blurredMaskCanvasRef = useRef(null);
  const maskGridCanvasRefs = useRef(new Map());
  const selectedDebugView = MULTICOLOR_DEBUG_VIEWS.find(
    (view) => view.id === multicolorDebugView,
  );
  const selectedDebugViewLabel =
    DEBUG_VIEW_LABELS[multicolorDebugView] ?? selectedDebugView?.label ?? multicolorDebugView;
  const suggestedLinesByColorId = new Map(
    multicolorPaletteCoverageWithSuggestions.map((color) => [color.id, color.allocatedUnits]),
  );
  const plannedLinesByColorId = new Map(
    multicolorPaletteCoverageWithLineAllocation.map((color) => [color.id, color.allocatedUnits]),
  );
  const visibleMaskImages = multicolorMaskImages.filter((color) => color.imageData);
  const activeCoverage = multicolorPaletteCoverage.find(
    (color) => color.id === activePaletteColorId,
  ) ?? null;
  const hasActiveCoverage = (activeCoverage?.pixelCount ?? 0) > 0;
  const visibleExperimentalBucketCount = multicolorLineBuckets.filter((bucket) => bucket.visible).length;
  const enabledBucketCount = multicolorLineBuckets.filter((bucket) => bucket.enabled).length;
  const canApplyActiveColorExperimentStep =
    canUseActiveColorMaskForLineScoring &&
    (
      isExperimentalRoundRobinSteppingEnabled
        ? enabledBucketCount > 0
        : activeColorExperimentNextNailNumber !== null
    );
  const sourceLabel = isPaletteDitheringEnabled ? 'dithered' : 'nearest';
  const steppingModeLabel = isExperimentalRoundRobinSteppingEnabled ? 'round-robin' : 'single';
  const scoringModeShortLabel = selectedDebugViewLabel === 'isolate' ? 'active color' : 'grayscale';
  const hasSuggestedLineTarget = multicolorTargetTotalLines > 0;

  useEffect(() => {
    if (!isPaletteMaskVisible) {
      return;
    }
    drawImageDataToCanvas(rawMaskCanvasRef.current, rawActiveMaskImage);
  }, [isPaletteMaskVisible, rawActiveMaskImage]);

  useEffect(() => {
    if (!isPaletteMaskVisible) {
      return;
    }
    drawImageDataToCanvas(blurredMaskCanvasRef.current, blurredActiveMaskImage);
  }, [isPaletteMaskVisible, blurredActiveMaskImage]);

  useEffect(() => {
    for (const maskColor of visibleMaskImages) {
      drawImageDataToCanvas(
        maskGridCanvasRefs.current.get(maskColor.id),
        maskColor.imageData,
      );
    }
  }, [visibleMaskImages]);

  return (
    <div className="multicolor-lab">
      <div className="multicolor-lab-header">
        <h2>Multicolor lab</h2>
        <p>Palette, inspect, experiment, then bucket review.</p>
      </div>
      <label className="checkbox-row multicolor-lab-toggle-row">
        <input
          type="checkbox"
          checked={isMulticolorLabEnabled}
          onChange={(event) => setIsMulticolorLabEnabled(event.target.checked)}
        />
        <span>Enable multicolor lab</span>
      </label>
      {isMulticolorLabEnabled && (
        <div className="multicolor-lab-body">
          <div className="multicolor-status-strip">
            <span className="multicolor-status-chip">
              Active: {activePaletteColor?.label ?? 'none'}
            </span>
            <span className="multicolor-status-chip">View: {selectedDebugViewLabel}</span>
            <span className="multicolor-status-chip">Source: {sourceLabel}</span>
            <span className="multicolor-status-chip">Step: {steppingModeLabel}</span>
            <span className="multicolor-status-chip">Score: {scoringModeShortLabel}</span>
          </div>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>Palette</h3>
              <p>Choose the working colors and preview mode.</p>
            </div>
            <div className="multicolor-lab-section-card">
              <div className="multicolor-inline-controls">
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={isPalettePreviewEnabled}
                    onChange={(event) => setIsPalettePreviewEnabled(event.target.checked)}
                  />
                  <span>Enable palette tools</span>
                </label>
              </div>
              <div
                className="multicolor-debug-toggle-group"
                role="radiogroup"
                aria-label="Multicolor debug view"
              >
                {MULTICOLOR_DEBUG_VIEWS.map((view) => {
                  const isActive = multicolorDebugView === view.id;
                  return (
                    <button
                      key={view.id}
                      className={[
                        'multicolor-debug-toggle',
                        isActive ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      onClick={() => setMulticolorDebugView(view.id)}
                    >
                      {DEBUG_VIEW_LABELS[view.id] ?? view.label}
                    </button>
                  );
                })}
              </div>
              <div
                className="multicolor-debug-toggle-group"
                role="radiogroup"
                aria-label="Multicolor palette preset"
              >
                {MULTICOLOR_PALETTE_PRESETS.map((preset) => {
                  const isActive = multicolorPalettePreset.id === preset.id;
                  return (
                    <button
                      key={preset.id}
                      className={[
                        'multicolor-debug-toggle',
                        isActive ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      onClick={() => {
                        setMulticolorPalettePresetId(preset.id);
                        setMulticolorPaletteColors(clonePalettePreset(preset).colors);
                        setActivePaletteColorId(preset.colors[0]?.id ?? null);
                      }}
                    >
                      {preset.name}
                    </button>
                  );
                })}
              </div>
              <div className="multicolor-palette-list">
                {multicolorPaletteColors.map((color) => (
                  <div
                    key={color.id}
                    className={[
                      'multicolor-palette-row',
                      color.enabled ? '' : 'is-disabled',
                      color.id === activePaletteColorId ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <input
                      type="checkbox"
                      checked={color.enabled}
                      onChange={(event) => {
                        setMulticolorPaletteColors((currentColors) =>
                          currentColors.map((currentColor) =>
                            currentColor.id === color.id
                              ? {
                                  ...currentColor,
                                  enabled: event.target.checked,
                                }
                              : currentColor,
                          ),
                        );
                      }}
                    />
                    <button
                      className={[
                        'multicolor-palette-swatch-button',
                        color.id === activePaletteColorId ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      onClick={() => setActivePaletteColorId(color.id)}
                      aria-label={`Set active palette color ${color.label}`}
                      title={`Active color: ${color.label}`}
                    >
                      <span
                        className="multicolor-palette-swatch"
                        style={{ backgroundColor: color.hex }}
                      />
                    </button>
                    <span className="multicolor-palette-name">{color.label}</span>
                    <span className="multicolor-palette-count-value">
                      {hasOriginalImage
                        ? `${(multicolorPalettePixelCountMap.get(color.id) ?? 0).toLocaleString()} px`
                        : '-'}
                    </span>
                  </div>
                ))}
              </div>
              <div className="multicolor-inline-controls">
                <span className="multicolor-lab-label">Source</span>
                <div
                  className="multicolor-debug-toggle-group"
                  role="radiogroup"
                  aria-label="Palette source"
                >
                  <button
                    className={[
                      'multicolor-debug-toggle',
                      !isPaletteDitheringEnabled ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                    type="button"
                    role="radio"
                    aria-checked={!isPaletteDitheringEnabled}
                    onClick={() => setIsPaletteDitheringEnabled(false)}
                    disabled={!isPalettePreviewEnabled}
                  >
                    nearest
                  </button>
                  <button
                    className={[
                      'multicolor-debug-toggle',
                      isPaletteDitheringEnabled ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                    type="button"
                    role="radio"
                    aria-checked={isPaletteDitheringEnabled}
                    onClick={() => setIsPaletteDitheringEnabled(true)}
                    disabled={!isPalettePreviewEnabled}
                  >
                    dithered
                  </button>
                </div>
                <p className="multicolor-mini-note">
                  Source affects preview, isolate, and coverage.
                </p>
                {isActiveColorOnlyControlVisible && (
                  <label className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={isActivePaletteColorOnlyEnabled}
                      onChange={(event) => setIsActivePaletteColorOnlyEnabled(event.target.checked)}
                      disabled={!activePaletteColor || enabledPalettePreviewColors.length === 0}
                    />
                    <span>Show active color only</span>
                  </label>
                )}
              </div>
            </div>
          </section>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>Inspect</h3>
              <p>Review preprocessing and line allocation before solving.</p>
            </div>
            <div className="multicolor-lab-section-card">
              {shouldShowPaletteComparison && (
                <div className="multicolor-inspect-block">
                  <span className="multicolor-lab-label">Preview comparison</span>
                  <div className="multicolor-comparison-grid">
                    <figure className="multicolor-comparison-card">
                      <figcaption>Original</figcaption>
                      <canvas
                        ref={originalComparisonCanvasRef}
                        className="multicolor-comparison-canvas"
                      />
                    </figure>
                    <figure className="multicolor-comparison-card">
                      <figcaption>Nearest</figcaption>
                      <canvas
                        ref={paletteComparisonCanvasRef}
                        className="multicolor-comparison-canvas"
                      />
                    </figure>
                    {isPaletteDitheringEnabled && (
                      <figure className="multicolor-comparison-card">
                        <figcaption>Dithered</figcaption>
                        <canvas
                          ref={ditheredComparisonCanvasRef}
                          className="multicolor-comparison-canvas"
                        />
                      </figure>
                    )}
                  </div>
                </div>
              )}

              {isPaletteMaskVisible && (
                <div className="multicolor-inspect-block">
                  <span className="multicolor-lab-label">
                    Isolate view
                    {activePaletteColor ? `: ${activePaletteColor.label}` : ''}
                  </span>
                  <label className="slider-control">
                    <span>Soften: {maskBlurRadius}</span>
                    <input
                      type="range"
                      min="0"
                      max="12"
                      step="1"
                      value={maskBlurRadius}
                      onChange={(event) => {
                        setMaskBlurRadius(Math.max(0, Number(event.target.value) || 0));
                      }}
                      disabled={!isPaletteMaskVisible}
                    />
                  </label>
                  <div className="multicolor-comparison-grid">
                    <figure className="multicolor-comparison-card">
                      <figcaption>
                        Raw isolate
                        {activePaletteColor ? ` for ${activePaletteColor.label}` : ''}
                      </figcaption>
                      {hasActiveCoverage ? (
                        <canvas
                          ref={rawMaskCanvasRef}
                          className="multicolor-comparison-canvas"
                        />
                      ) : (
                        <div className="multicolor-comparison-empty">
                          No pixels for this color in the current source.
                        </div>
                      )}
                    </figure>
                    <figure className="multicolor-comparison-card">
                      <figcaption>
                        Softened isolate
                        {activePaletteColor ? ` for ${activePaletteColor.label}` : ''}
                      </figcaption>
                      {hasActiveCoverage ? (
                        <canvas
                          ref={blurredMaskCanvasRef}
                          className="multicolor-comparison-canvas"
                        />
                      ) : (
                        <div className="multicolor-comparison-empty">
                          Nothing to soften for this color.
                        </div>
                      )}
                    </figure>
                  </div>
                  <p className="multicolor-mini-note">
                    The cards below are all raw isolates. The top-left card matches the currently
                    active color from the palette.
                  </p>
                  <div className="multicolor-mask-grid">
                    {visibleMaskImages.map((maskColor) => (
                      <div
                        key={maskColor.id}
                        className={[
                          'multicolor-mask-card',
                          maskColor.id === activePaletteColorId ? 'is-active' : '',
                        ].filter(Boolean).join(' ')}
                      >
                        <span className="multicolor-mask-card-meta">
                          <span
                            className="multicolor-palette-swatch"
                            style={{ backgroundColor: maskColor.hex }}
                          />
                          <span>{maskColor.label}</span>
                        </span>
                        <canvas
                          ref={(element) => {
                            if (element) {
                              maskGridCanvasRefs.current.set(maskColor.id, element);
                              return;
                            }

                            maskGridCanvasRefs.current.delete(maskColor.id);
                          }}
                          className="multicolor-comparison-canvas"
                        />
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="multicolor-inspect-block">
                <span className="multicolor-lab-label">Coverage</span>
                <div className="multicolor-inline-controls">
                  <label className="multicolor-histogram-input">
                    <span>Target total lines</span>
                    <input
                      type="number"
                      min="0"
                      step="1"
                      value={multicolorTargetTotalLines}
                      onChange={(event) => {
                        const parsedValue = Number.parseInt(event.target.value, 10);
                        setMulticolorTargetTotalLines(
                          Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0,
                        );
                      }}
                    />
                  </label>
                  <p className="multicolor-mini-note">
                    Planning uses this multicolor target, not the grayscale run.
                  </p>
                </div>
                {multicolorPaletteCoverage.length > 0 ? (
                  <div className="multicolor-histogram-list">
                    {multicolorPaletteCoverageWithLineAllocation.map((color) => (
                      <div
                        key={color.id}
                        className="multicolor-histogram-row"
                      >
                        <div className="multicolor-histogram-meta">
                          <span
                            className="multicolor-palette-swatch"
                            style={{ backgroundColor: color.hex }}
                          />
                          <span className="multicolor-histogram-name">{color.label}</span>
                          <span className="multicolor-histogram-value">
                            {color.percentageLabel}
                          </span>
                          {hasSuggestedLineTarget && (
                            <span className="multicolor-histogram-lines">
                              {color.allocatedUnits.toLocaleString()} lines
                            </span>
                          )}
                        </div>
                        <div className="multicolor-histogram-bar-track">
                          <div
                            className="multicolor-histogram-bar-fill"
                            style={{
                              width: `${color.percentage}%`,
                              backgroundColor: color.hex,
                            }}
                          />
                        </div>
                        {hasSuggestedLineTarget && (
                          <div className="multicolor-histogram-controls">
                            <label className="checkbox-row">
                              <input
                                type="checkbox"
                                checked={multicolorLockedLineOverride?.colorId === color.id}
                                onChange={(event) => {
                                  if (!event.target.checked) {
                                    setMulticolorLockedLineOverride((currentOverride) =>
                                      currentOverride?.colorId === color.id ? null : currentOverride,
                                    );
                                    return;
                                  }

                                  setMulticolorLockedLineOverride({
                                    colorId: color.id,
                                    lineCount: suggestedLinesByColorId.get(color.id) ?? 0,
                                  });
                                }}
                              />
                              <span>Lock</span>
                            </label>
                            <label className="multicolor-histogram-input">
                              <span>Manual</span>
                              <input
                                type="number"
                                min="0"
                                max={multicolorTargetTotalLines}
                                step="1"
                                value={
                                  multicolorLockedLineOverride?.colorId === color.id
                                    ? multicolorLockedLineOverride.lineCount
                                    : suggestedLinesByColorId.get(color.id) ?? 0
                                }
                                onChange={(event) => {
                                  const parsedValue = Number.parseInt(event.target.value, 10);
                                  setMulticolorLockedLineOverride({
                                    colorId: color.id,
                                    lineCount: Number.isFinite(parsedValue) ? parsedValue : 0,
                                  });
                                }}
                                disabled={multicolorLockedLineOverride?.colorId !== color.id}
                              />
                            </label>
                            <span className="multicolor-histogram-auto-lines">
                              Auto {(suggestedLinesByColorId.get(color.id) ?? 0).toLocaleString()}
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                    <div className="multicolor-inline-stats">
                      <span className="multicolor-inline-stat">
                        Total {(totalPaletteCoverageTenths / 10).toFixed(1)}%
                      </span>
                      {hasSuggestedLineTarget && (
                        <span className="multicolor-inline-stat">
                          Split {totalAllocatedSuggestedLines.toLocaleString()} /{' '}
                          {multicolorTargetTotalLines.toLocaleString()}
                        </span>
                      )}
                    </div>
                    {!hasSuggestedLineTarget && (
                      <p className="multicolor-mini-note">
                        Set a multicolor target to see planned lines.
                      </p>
                    )}
                  </div>
                ) : (
                  <p className="multicolor-mini-note">
                    Load an image and enable at least one color to see the split.
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>Experiment</h3>
              <p>Test one line at a time without touching export.</p>
            </div>
            <div className="multicolor-lab-section-card">
              <div className="multicolor-inline-controls">
                <span className="multicolor-lab-label">Line source</span>
                <span className="multicolor-inline-stat">
                  {selectedDebugViewLabel === 'isolate' ? 'active isolate' : 'whole image'}
                </span>
              </div>

              <div className="multicolor-inline-controls">
                <span className="multicolor-lab-label">Step mode</span>
                <div
                  className="multicolor-debug-toggle-group"
                  role="radiogroup"
                  aria-label="Experimental stepping mode"
                >
                  <button
                    className={[
                      'multicolor-debug-toggle',
                      !isExperimentalRoundRobinSteppingEnabled ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                    type="button"
                    role="radio"
                    aria-checked={!isExperimentalRoundRobinSteppingEnabled}
                    onClick={() => setIsExperimentalRoundRobinSteppingEnabled(false)}
                  >
                    single
                  </button>
                  <button
                    className={[
                      'multicolor-debug-toggle',
                      isExperimentalRoundRobinSteppingEnabled ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                    type="button"
                    role="radio"
                    aria-checked={isExperimentalRoundRobinSteppingEnabled}
                    onClick={() => setIsExperimentalRoundRobinSteppingEnabled(true)}
                    disabled={enabledBucketCount === 0}
                  >
                    round-robin
                  </button>
                </div>
              </div>

              <div className="multicolor-experiment-actions">
                <button
                  className="action-button"
                  type="button"
                  onClick={onApplyActiveColorExperimentStep}
                  disabled={!canApplyActiveColorExperimentStep}
                >
                  {isExperimentalRoundRobinSteppingEnabled
                    ? 'Apply one round-robin line'
                    : activeColorExperimentNextNailNumber === null
                      ? 'Apply one line'
                      : `Apply line ${activeColorExperimentFromIndex} -> ${activeColorExperimentNextNailNumber}`}
                </button>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={isExperimentalColorLinesOnlyPreviewEnabled}
                    onChange={(event) =>
                      setIsExperimentalColorLinesOnlyPreviewEnabled(event.target.checked)
                    }
                    disabled={totalExperimentalMulticolorLines === 0}
                  />
                  <span>Show only experiment lines in art mode</span>
                </label>
              </div>

              <div className="multicolor-inline-stats">
                <span className="multicolor-inline-stat">
                  Active bucket {activeExperimentalLineCount.toLocaleString()} lines
                </span>
                <span className="multicolor-inline-stat">
                  Total {totalExperimentalMulticolorLines.toLocaleString()} lines
                </span>
              </div>
              <p className="multicolor-mini-note">
                Line source follows the current view. <code>isolate</code> uses the active color;
                every other view uses grayscale.
              </p>
            </div>
          </section>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>Buckets</h3>
              <p>Use one row per color for visibility, plan, and quick stats.</p>
            </div>
            <div className="multicolor-lab-section-card">
              <div className="multicolor-bucket-panel-header">
                <div className="multicolor-inline-stats">
                  <span className="multicolor-inline-stat">
                    Visible {visibleExperimentalBucketCount.toLocaleString()} /{' '}
                    {multicolorLineBuckets.length.toLocaleString()}
                  </span>
                  <span className="multicolor-inline-stat">
                    Enabled {enabledBucketCount.toLocaleString()} /{' '}
                    {multicolorLineBuckets.length.toLocaleString()}
                  </span>
                </div>
                <button
                  className="multicolor-debug-toggle"
                  type="button"
                  onClick={onShowAllMulticolorBuckets}
                  disabled={multicolorLineBuckets.length === 0}
                >
                  show all
                </button>
              </div>
              <div className="multicolor-bucket-list">
                {multicolorLineBuckets.map((bucket) => {
                  const plannedLineCount = plannedLinesByColorId.get(bucket.colorId) ?? 0;

                  return (
                    <div
                      key={bucket.colorId}
                      className={[
                        'multicolor-bucket-row',
                        bucket.colorId === activePaletteColorId ? 'is-active' : '',
                        !bucket.enabled ? 'is-disabled' : '',
                      ].filter(Boolean).join(' ')}
                    >
                      <div className="multicolor-bucket-row-main">
                        <button
                          className={[
                            'multicolor-palette-swatch-button',
                            bucket.colorId === activePaletteColorId ? 'is-active' : '',
                          ].filter(Boolean).join(' ')}
                          type="button"
                          onClick={() => setActivePaletteColorId(bucket.colorId)}
                          aria-label={`Set active color bucket ${bucket.label}`}
                          title={`Active bucket: ${bucket.label}`}
                        >
                          <span
                            className="multicolor-palette-swatch"
                            style={{ backgroundColor: bucket.hex }}
                          />
                        </button>
                        <span className="multicolor-bucket-name">{bucket.label}</span>
                        <span className="multicolor-bucket-stat">
                          actual {bucket.lines.length.toLocaleString()}
                        </span>
                        <span className="multicolor-bucket-stat">
                          planned {plannedLineCount.toLocaleString()}
                        </span>
                        <span className="multicolor-bucket-stat">
                          last {bucket.lastNailNumber ?? 1}
                        </span>
                      </div>
                      <div className="multicolor-bucket-row-actions">
                        <label className="checkbox-row">
                          <input
                            type="checkbox"
                            checked={bucket.visible}
                            onChange={(event) =>
                              onToggleMulticolorBucketVisibility(
                                bucket.colorId,
                                event.target.checked,
                              )
                            }
                          />
                          <span>{bucket.visible ? 'visible' : 'hidden'}</span>
                        </label>
                        <button
                          className="multicolor-debug-toggle"
                          type="button"
                          onClick={() => onSoloMulticolorBucket(bucket.colorId)}
                        >
                          solo
                        </button>
                        <span className="multicolor-bucket-status">
                          {bucket.enabled ? 'enabled' : 'disabled'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default MulticolorLab;
