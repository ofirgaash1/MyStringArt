import { useEffect, useMemo, useRef, useState } from 'react';
import {
  clonePalettePreset,
  drawImageDataToCanvas,
  MULTICOLOR_DEBUG_VIEWS,
  MULTICOLOR_PALETTE_PRESETS,
} from '../multicolor';
import { useRenderDiagnostics } from '../renderDiagnostics';

const DEBUG_VIEW_LABELS = {
  original: 'original',
  'current-grayscale': 'grayscale',
  'shared-residual': 'residual',
  'palette-preview': 'preview',
  'color-mask': 'isolate',
};

function MulticolorLab({
  activePaletteColor,
  activePaletteColorId,
  activeColorExperimentFromIndex,
  activeColorExperimentNextNailNumber,
  activeExperimentalLineCount,
  activeBucketPlannedLineCount,
  activeBucketRemainingLineCount,
  blurredActiveMaskImage,
  canApplyExperimentalStep,
  isSharedStateLoopRunning,
  sharedStateLoopStatus,
  currentActiveTargetImage,
  exactColorAreaStats,
  ditheredComparisonCanvasRef,
  enabledPalettePreviewColors,
  globalLineStrength,
  globalMinDistance,
  hasOriginalImage,
  isActiveColorOnlyControlVisible,
  isExperimentalColorLinesOnlyPreviewEnabled,
  isExperimentalRoundRobinSteppingEnabled,
  isExperimentalSharedBestSteppingEnabled,
  isActivePaletteColorOnlyEnabled,
  isMulticolorFastSteppingEnabled,
  isMulticolorStepProfilingEnabled,
  isMulticolorLabEnabled,
  isPaletteDitheringEnabled,
  isPaletteMaskVisible,
  isPalettePreviewEnabled,
  isWhiteTestOverlayEnabled,
  maskBlurRadius,
  multicolorDebugView,
  multicolorLineBuckets,
  multicolorMaskImages,
  multicolorPaletteColors,
  multicolorPaletteCoverage,
  multicolorPaletteCoverageWithLineAllocation,
  multicolorPaletteCoverageWithSuggestions,
  multicolorPaletteFinderColorCount,
  multicolorInterleaveOrder,
  multicolorLineStrengthMode,
  multicolorLockedLineOverride,
  multicolorMinDistanceMode,
  lineCoverageBackendId,
  lineCoverageBackendOptions,
  multicolorPalettePixelCountMap,
  multicolorPalettePreset,
  multicolorReadOnlyInterleavePassCount,
  multicolorUsedLineExclusionMode,
  onMoveMulticolorInterleaveEntryDown,
  onMoveMulticolorInterleaveEntryUp,
  onResetMulticolorInterleaveOrder,
  onSetMulticolorBucketLineStrength,
  onSetMulticolorBucketMinDistance,
  multicolorTargetTotalLines,
  onShowAllMulticolorBuckets,
  onSoloMulticolorBucket,
  onToggleMulticolorBucketVisibility,
  originalComparisonCanvasRef,
  onApplyActiveColorExperimentStep,
  onFindBestFitPalette,
  onExportMulticolorSession,
  onImportMulticolorSession,
  onRefreshMulticolorPreviews,
  onResetAllMulticolorState,
  onResetMulticolorBucket,
  onProfileEffect,
  onDiagnosticRender,
  paletteComparisonCanvasRef,
  rawActiveMaskImage,
  setActivePaletteColorId,
  setIsActivePaletteColorOnlyEnabled,
  setIsExperimentalColorLinesOnlyPreviewEnabled,
  setIsExperimentalRoundRobinSteppingEnabled,
  setIsExperimentalSharedBestSteppingEnabled,
  setIsMulticolorFastSteppingEnabled,
  setIsMulticolorStepProfilingEnabled,
  setIsMulticolorLabEnabled,
  setIsPaletteDitheringEnabled,
  setIsPalettePreviewEnabled,
  setMaskBlurRadius,
  setMulticolorDebugView,
  setMulticolorLineStrengthMode,
  setMulticolorLockedLineOverride,
  setMulticolorMinDistanceMode,
  setLineCoverageBackendId,
  setMulticolorPaletteColors,
  setMulticolorPaletteFinderColorCount,
  setMulticolorPalettePresetId,
  setMulticolorTargetTotalLines,
  setMulticolorUsedLineExclusionMode,
  shouldShowPaletteComparison,
  sharedStateNextColorLabel,
  totalExperimentalMulticolorLines,
  totalAllocatedSuggestedLines,
  totalPaletteCoverageTenths,
  onToggleSharedStateLoop,
  onToggleWhiteTestOverlay,
}) {
  const SHOW_MULTICOLOR_INSPECT_BLOCKS = false;
  const SHOW_BUCKETS_PANEL = false;
  const SHOW_INTERLEAVE_PANEL = false;
  const rawMaskCanvasRef = useRef(null);
  const blurredMaskCanvasRef = useRef(null);
  const currentTargetCanvasRef = useRef(null);
  const maskGridCanvasRefs = useRef(new Map());
  const sessionImportInputRef = useRef(null);
  const selectedDebugView = MULTICOLOR_DEBUG_VIEWS.find(
    (view) => view.id === multicolorDebugView,
  );
  const selectedDebugViewLabel =
    DEBUG_VIEW_LABELS[multicolorDebugView] ?? selectedDebugView?.label ?? multicolorDebugView;
  const suggestedLinesByColorId = useMemo(
    () => new Map(
      multicolorPaletteCoverageWithSuggestions.map((color) => [color.id, color.allocatedUnits]),
    ),
    [multicolorPaletteCoverageWithSuggestions],
  );
  const plannedLinesByColorId = useMemo(
    () => new Map(
      multicolorPaletteCoverageWithLineAllocation.map((color) => [color.id, color.allocatedUnits]),
    ),
    [multicolorPaletteCoverageWithLineAllocation],
  );
  const visibleMaskImages = useMemo(
    () => multicolorMaskImages.filter((color) => color.imageData),
    [multicolorMaskImages],
  );
  const activeCoverage = multicolorPaletteCoverage.find(
    (color) => color.id === activePaletteColorId,
  ) ?? null;
  const hasActiveCoverage = (activeCoverage?.pixelCount ?? 0) > 0;
  const visibleExperimentalBucketCount = multicolorLineBuckets.filter((bucket) => bucket.visible).length;
  const enabledBucketCount = multicolorLineBuckets.filter((bucket) => bucket.enabled).length;
  const sourceLabel = isPaletteDitheringEnabled ? 'dithered' : 'nearest';
  const steppingModeLabel = isExperimentalSharedBestSteppingEnabled
    ? 'shared best'
    : isExperimentalRoundRobinSteppingEnabled
      ? 'round-robin'
      : 'single';
  const scoringModeShortLabel = isExperimentalSharedBestSteppingEnabled
    ? 'shared masks'
    : selectedDebugViewLabel === 'isolate'
      ? 'active color'
      : 'grayscale';
  const hasSuggestedLineTarget = multicolorTargetTotalLines > 0;
  const hasInterleaveOrder = multicolorInterleaveOrder.length > 0;
  const coverageBackendOptions = lineCoverageBackendOptions ?? [];
  const [isAdvancedControlsExpanded, setIsAdvancedControlsExpanded] = useState(false);
  const exactAreaRows = exactColorAreaStats?.stats ?? [];
  const exactAreaTotal = exactColorAreaStats?.totalArea ?? 0;

  useRenderDiagnostics(
    'MulticolorLab',
    {
      activePaletteColorId,
      activeExperimentalLineCount,
      bucketCount: multicolorLineBuckets.length,
      currentTargetImage: currentActiveTargetImage,
      debugView: multicolorDebugView,
      fastStepping: isMulticolorFastSteppingEnabled,
      isPaletteMaskVisible,
      isPalettePreviewEnabled,
      maskImageCount: visibleMaskImages.length,
      paletteCoverageCount: multicolorPaletteCoverage.length,
      stepProfiling: isMulticolorStepProfilingEnabled,
      totalExperimentalMulticolorLines,
    },
    onDiagnosticRender,
  );

  useEffect(() => {
    if (!isPaletteMaskVisible) {
      return;
    }
    onProfileEffect('lab raw mask canvas draw', () => {
      drawImageDataToCanvas(rawMaskCanvasRef.current, rawActiveMaskImage);
    });
  }, [isPaletteMaskVisible, onProfileEffect, rawActiveMaskImage]);

  useEffect(() => {
    if (!isPaletteMaskVisible) {
      return;
    }
    onProfileEffect('lab blurred mask canvas draw', () => {
      drawImageDataToCanvas(blurredMaskCanvasRef.current, blurredActiveMaskImage);
    });
  }, [blurredActiveMaskImage, isPaletteMaskVisible, onProfileEffect]);

  useEffect(() => {
    if (!isPaletteMaskVisible) {
      return;
    }
    onProfileEffect('lab current target canvas draw', () => {
      drawImageDataToCanvas(currentTargetCanvasRef.current, currentActiveTargetImage);
    });
  }, [currentActiveTargetImage, isPaletteMaskVisible, onProfileEffect]);

  useEffect(() => {
    if (!isPaletteMaskVisible) {
      return;
    }

    onProfileEffect('lab mask grid canvas draw', () => {
      for (const maskColor of visibleMaskImages) {
        drawImageDataToCanvas(
          maskGridCanvasRefs.current.get(maskColor.id),
          maskColor.imageData,
        );
      }
    });
  }, [isPaletteMaskVisible, onProfileEffect, visibleMaskImages]);

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
            <span className="multicolor-status-chip">Coverage: {lineCoverageBackendId}</span>
            <span className="multicolor-status-chip">
              Exact painted: {exactAreaRows.length > 0 ? 'on' : 'off'}
            </span>
          </div>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>Exact areas</h3>
              <p>Vector boolean regions in current art order.</p>
              <button
                className="multicolor-debug-toggle"
                type="button"
                onClick={onToggleWhiteTestOverlay}
              >
                {isWhiteTestOverlayEnabled ? 'hide test white' : 'test white'}
              </button>
            </div>
            <div className="multicolor-lab-section-card">
              {exactAreaRows.length === 0 ? (
                <p className="multicolor-mini-note">No area data yet.</p>
              ) : (
                <>
                  <div className="multicolor-inline-stats">
                    <span className="multicolor-inline-stat">
                      Total area {exactAreaTotal.toFixed(2)}
                    </span>
                  </div>
                  <div className="multicolor-bucket-list">
                    {exactAreaRows.map((row) => (
                      <div key={row.id} className="multicolor-bucket-row">
                        <div className="multicolor-bucket-row-main">
                          <span
                            className="multicolor-palette-swatch"
                            style={{ backgroundColor: row.hex }}
                          />
                          <span className="multicolor-bucket-name">{row.label}</span>
                          <span className="multicolor-bucket-stat">
                            {row.percent.toFixed(2)}%
                          </span>
                          <span className="multicolor-bucket-stat">
                            area {row.area.toFixed(2)}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </section>

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
              <div className="multicolor-inline-controls">
                <label className="multicolor-histogram-input">
                  <span>Find colors</span>
                  <input
                    type="number"
                    min="2"
                    max="12"
                    value={multicolorPaletteFinderColorCount}
                    onChange={(event) =>
                      setMulticolorPaletteFinderColorCount(
                        Math.max(2, Math.min(12, Number.parseInt(event.target.value, 10) || 2)),
                      )
                    }
                    disabled={!hasOriginalImage}
                  />
                </label>
                <button
                  className="multicolor-debug-toggle"
                  type="button"
                  onClick={onFindBestFitPalette}
                  disabled={!hasOriginalImage}
                >
                  find best palette
                </button>
                <p className="multicolor-mini-note">
                  Uses OKLab clustering over the visible image circle.
                </p>
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
                <div className="multicolor-inspect-block" style={{ display: 'none' }}>
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
                <div className="multicolor-inspect-block" style={{ display: 'none' }}>
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
                        Current target
                        {activePaletteColor ? ` for ${activePaletteColor.label}` : ''}
                      </figcaption>
                      {hasActiveCoverage && currentActiveTargetImage ? (
                        <canvas
                          ref={currentTargetCanvasRef}
                          className="multicolor-comparison-canvas"
                        />
                      ) : (
                        <div className="multicolor-comparison-empty">
                          No current target preview for this color.
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
                    Raw isolate shows the current source split. Current target shows what remains
                    for the active color after applied lines. The cards below are all raw isolates.
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

              <div className="multicolor-inspect-block" style={{ display: 'none' }}>
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
                  {isExperimentalSharedBestSteppingEnabled
                    ? `shared residual masks (${sourceLabel})`
                    : `palette isolate (${sourceLabel})`}
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
                      !isExperimentalRoundRobinSteppingEnabled &&
                      !isExperimentalSharedBestSteppingEnabled
                        ? 'is-active'
                        : '',
                    ].filter(Boolean).join(' ')}
                    type="button"
                    role="radio"
                    aria-checked={
                      !isExperimentalRoundRobinSteppingEnabled &&
                      !isExperimentalSharedBestSteppingEnabled
                    }
                    onClick={() => {
                      setIsExperimentalSharedBestSteppingEnabled(false);
                      setIsExperimentalRoundRobinSteppingEnabled(false);
                    }}
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
                  <button
                    className={[
                      'multicolor-debug-toggle',
                      isExperimentalSharedBestSteppingEnabled ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                    type="button"
                    role="radio"
                    aria-checked={isExperimentalSharedBestSteppingEnabled}
                    onClick={() => setIsExperimentalSharedBestSteppingEnabled(true)}
                    disabled={enabledBucketCount === 0}
                  >
                    shared best
                  </button>
                </div>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={isMulticolorStepProfilingEnabled}
                    onChange={(event) =>
                      setIsMulticolorStepProfilingEnabled(event.target.checked)
                    }
                  />
                  <span>Log step timings</span>
                </label>
                <label className="checkbox-row">
                  <input
                    type="checkbox"
                    checked={isMulticolorFastSteppingEnabled}
                    onChange={(event) =>
                      setIsMulticolorFastSteppingEnabled(event.target.checked)
                    }
                  />
                  <span>Fast stepping</span>
                </label>
                <button
                  className="multicolor-debug-toggle"
                  type="button"
                  onClick={onRefreshMulticolorPreviews}
                  disabled={!isMulticolorFastSteppingEnabled}
                >
                  refresh previews
                </button>
              </div>

              <div className="multicolor-experiment-actions">
                <button
                  className="action-button"
                  type="button"
                  onClick={onApplyActiveColorExperimentStep}
                  disabled={!canApplyExperimentalStep}
                >
                  {isExperimentalSharedBestSteppingEnabled
                    ? sharedStateNextColorLabel
                      ? `Apply one shared-state line (last: ${sharedStateNextColorLabel})`
                      : 'Apply one shared-state line'
                    : isExperimentalRoundRobinSteppingEnabled
                    ? 'Apply one round-robin line'
                    : activeBucketRemainingLineCount <= 0
                      ? 'Active bucket is at target'
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
              {isExperimentalSharedBestSteppingEnabled && (
                <div className="multicolor-inline-controls">
                  <button
                    className="action-button action-button-secondary"
                    type="button"
                    onClick={onToggleSharedStateLoop}
                    disabled={!isSharedStateLoopRunning && !canApplyExperimentalStep}
                  >
                    {isSharedStateLoopRunning
                      ? 'Stop shared-state loop'
                      : sharedStateNextColorLabel
                        ? `Start shared-state loop (last: ${sharedStateNextColorLabel})`
                        : 'Start shared-state loop'}
                  </button>
                </div>
              )}
              {isExperimentalSharedBestSteppingEnabled && sharedStateLoopStatus && (
                <p className="multicolor-mini-note">{sharedStateLoopStatus}</p>
              )}

              <div className="multicolor-inline-stats">
                <span className="multicolor-inline-stat">
                  Active {activeExperimentalLineCount.toLocaleString()} /{' '}
                  {activeBucketPlannedLineCount.toLocaleString()} planned
                </span>
                <span className="multicolor-inline-stat">
                  Total {totalExperimentalMulticolorLines.toLocaleString()} lines
                </span>
                <span className="multicolor-inline-stat">
                  Remaining {activeBucketRemainingLineCount.toLocaleString()}
                </span>
              </div>
              <p className="multicolor-mini-note">
                <code>isolate</code> uses the active color from the current
                {' '}
                <code>{sourceLabel}</code>
                {' '}
                source. Every other view uses grayscale.
              </p>
            </div>
          </section>

          <section className="multicolor-lab-section" style={{ display: 'none' }}>
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
                          actual {(bucket.lineCount ?? 0).toLocaleString()}
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
                        <button
                          className="multicolor-debug-toggle"
                          type="button"
                          onClick={() => onResetMulticolorBucket(bucket.colorId)}
                          disabled={(bucket.lineCount ?? 0) === 0}
                        >
                          reset
                        </button>
                        <span className="multicolor-bucket-status">
                          {bucket.enabled ? 'enabled' : 'disabled'}
                        </span>
                        {multicolorLineStrengthMode === 'per-color' && (
                          <label className="multicolor-histogram-input">
                            <span>strength</span>
                            <input
                              type="number"
                              min="1"
                              max="50"
                              step="1"
                              value={bucket.lineStrength}
                              onChange={(event) =>
                                onSetMulticolorBucketLineStrength(
                                  bucket.colorId,
                                  event.target.value,
                                )
                              }
                            />
                          </label>
                        )}
                        {multicolorMinDistanceMode === 'per-color' && (
                          <label className="multicolor-histogram-input">
                            <span>min distance</span>
                            <input
                              type="number"
                              min="0"
                              max="50"
                              step="1"
                              value={bucket.minDistance}
                              onChange={(event) =>
                                onSetMulticolorBucketMinDistance(
                                  bucket.colorId,
                                  event.target.value,
                                )
                              }
                            />
                          </label>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="multicolor-bucket-panel-footer">
                <div className="multicolor-inline-stats">
                  <span className="multicolor-inline-stat">
                    Planned {multicolorTargetTotalLines.toLocaleString()}
                  </span>
                  <span className="multicolor-inline-stat">
                    Actual {totalExperimentalMulticolorLines.toLocaleString()}
                  </span>
                </div>
                <div className="multicolor-bucket-session-actions">
                  <button
                    className="multicolor-debug-toggle"
                    type="button"
                    onClick={onResetAllMulticolorState}
                    disabled={totalExperimentalMulticolorLines === 0}
                  >
                    reset multicolor
                  </button>
                  <button
                    className="multicolor-debug-toggle"
                    type="button"
                    onClick={onExportMulticolorSession}
                  >
                    export session
                  </button>
                  <button
                    className="multicolor-debug-toggle"
                    type="button"
                    onClick={() => sessionImportInputRef.current?.click()}
                  >
                    import session
                  </button>
                  <input
                    ref={sessionImportInputRef}
                    type="file"
                    accept="application/json,.json"
                    hidden
                    onChange={(event) => {
                      const nextFile = event.target.files?.[0] ?? null;
                      if (nextFile) {
                        onImportMulticolorSession(nextFile);
                      }
                      event.target.value = '';
                    }}
                  />
                </div>
              </div>
            </div>
          </section>

          <section className="multicolor-lab-section" style={{ display: 'none' }}>
            <div className="multicolor-lab-section-head">
              <h3>Interleave</h3>
              <p>Reorder the final multicolor art layering without recomputing any lines.</p>
            </div>
            <div className="multicolor-lab-section-card">
              {hasInterleaveOrder ? (
                <>
                  <div className="multicolor-inline-stats">
                    <span className="multicolor-inline-stat">
                      Art render order
                    </span>
                    <span className="multicolor-inline-stat">
                      {multicolorReadOnlyInterleavePassCount.toLocaleString()} passes
                    </span>
                    <span className="multicolor-inline-stat">
                      {multicolorInterleaveOrder.length.toLocaleString()} groups
                    </span>
                    <button
                      className="multicolor-debug-toggle"
                      type="button"
                      onClick={onResetMulticolorInterleaveOrder}
                    >
                      reset order
                    </button>
                  </div>
                  <p className="multicolor-mini-note">
                    This only changes final art-mode layering. It does not change generation,
                    quotas, or per-color buckets.
                  </p>
                  <div className="multicolor-bucket-list">
                    {multicolorInterleaveOrder.map((entry, index) => (
                      <div
                        key={entry.id}
                        className={[
                          'multicolor-bucket-row',
                          entry.colorId === activePaletteColorId ? 'is-active' : '',
                        ].filter(Boolean).join(' ')}
                      >
                        <div className="multicolor-bucket-row-main">
                          <span className="multicolor-bucket-stat">
                            #{index + 1}
                          </span>
                          <span
                            className="multicolor-palette-swatch"
                            style={{ backgroundColor: entry.hex }}
                          />
                          <span className="multicolor-bucket-name">{entry.label}</span>
                          <span className="multicolor-bucket-stat">
                            pass {entry.passIndex}
                          </span>
                          <span className="multicolor-bucket-stat">
                            {entry.plannedLines.toLocaleString()} planned lines
                          </span>
                        </div>
                        <div className="multicolor-bucket-row-actions">
                          <button
                            className="multicolor-debug-toggle"
                            type="button"
                            onClick={() => onMoveMulticolorInterleaveEntryUp(entry.id)}
                            disabled={index === 0}
                          >
                            up
                          </button>
                          <button
                            className="multicolor-debug-toggle"
                            type="button"
                            onClick={() => onMoveMulticolorInterleaveEntryDown(entry.id)}
                            disabled={index === multicolorInterleaveOrder.length - 1}
                          >
                            down
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <p className="multicolor-mini-note">
                  Enable colors with planned lines to build an editable interleave order.
                </p>
              )}
            </div>
          </section>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>Advanced controls</h3>
              <p>Less common multicolor rule switches.</p>
            </div>
            <div className="multicolor-lab-section-card">
              <button
                className="multicolor-advanced-toggle"
                type="button"
                onClick={() => setIsAdvancedControlsExpanded((currentValue) => !currentValue)}
                aria-expanded={isAdvancedControlsExpanded}
              >
                <span>{isAdvancedControlsExpanded ? 'Hide advanced controls' : 'Show advanced controls'}</span>
                <span className="multicolor-advanced-summary">
                  exclusion {multicolorUsedLineExclusionMode},
                  {' '}strength {multicolorLineStrengthMode},
                  {' '}distance {multicolorMinDistanceMode},
                  {' '}coverage {lineCoverageBackendId}
                </span>
              </button>
              {isAdvancedControlsExpanded && (
                <div className="multicolor-inline-controls">
                  <div
                    className="multicolor-debug-toggle-group"
                    role="radiogroup"
                    aria-label="Used line exclusion mode"
                  >
                    <button
                      className={[
                        'multicolor-debug-toggle',
                        multicolorUsedLineExclusionMode === 'shared' ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="radio"
                      aria-checked={multicolorUsedLineExclusionMode === 'shared'}
                      onClick={() => setMulticolorUsedLineExclusionMode('shared')}
                    >
                      shared line exclusion
                    </button>
                    <button
                      className={[
                        'multicolor-debug-toggle',
                        multicolorUsedLineExclusionMode === 'per-color' ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="radio"
                      aria-checked={multicolorUsedLineExclusionMode === 'per-color'}
                      onClick={() => setMulticolorUsedLineExclusionMode('per-color')}
                    >
                      per-color exclusion
                    </button>
                  </div>
                  <div
                    className="multicolor-debug-toggle-group"
                    role="radiogroup"
                    aria-label="Line strength mode"
                  >
                    <button
                      className={[
                        'multicolor-debug-toggle',
                        multicolorLineStrengthMode === 'shared' ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="radio"
                      aria-checked={multicolorLineStrengthMode === 'shared'}
                      onClick={() => setMulticolorLineStrengthMode('shared')}
                    >
                      shared strength {globalLineStrength}
                    </button>
                    <button
                      className={[
                        'multicolor-debug-toggle',
                        multicolorLineStrengthMode === 'per-color' ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="radio"
                      aria-checked={multicolorLineStrengthMode === 'per-color'}
                      onClick={() => setMulticolorLineStrengthMode('per-color')}
                    >
                      per-color strength
                    </button>
                  </div>
                  <div
                    className="multicolor-debug-toggle-group"
                    role="radiogroup"
                    aria-label="Minimum distance mode"
                  >
                    <button
                      className={[
                        'multicolor-debug-toggle',
                        multicolorMinDistanceMode === 'shared' ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="radio"
                      aria-checked={multicolorMinDistanceMode === 'shared'}
                      onClick={() => setMulticolorMinDistanceMode('shared')}
                    >
                      shared min distance {globalMinDistance}
                    </button>
                    <button
                      className={[
                        'multicolor-debug-toggle',
                        multicolorMinDistanceMode === 'per-color' ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="radio"
                      aria-checked={multicolorMinDistanceMode === 'per-color'}
                      onClick={() => setMulticolorMinDistanceMode('per-color')}
                    >
                      per-color min distance
                    </button>
                  </div>
                  <div
                    className="multicolor-debug-toggle-group"
                    role="radiogroup"
                    aria-label="Line coverage backend"
                  >
                    {coverageBackendOptions.map((backend) => (
                      <button
                        key={backend.id}
                        className={[
                          'multicolor-debug-toggle',
                          lineCoverageBackendId === backend.id ? 'is-active' : '',
                        ].filter(Boolean).join(' ')}
                        type="button"
                        role="radio"
                        aria-checked={lineCoverageBackendId === backend.id}
                        onClick={() => setLineCoverageBackendId(backend.id)}
                      >
                        coverage {backend.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default MulticolorLab;
