import { useMemo } from 'react';
import {
  clonePalettePreset,
  MULTICOLOR_PALETTE_PRESETS,
} from '../multicolor';
import { useRenderDiagnostics } from '../renderDiagnostics';

function MulticolorLab({
  activePaletteColor,
  activePaletteColorId,
  allTasPaletteFit,
  ditheredComparisonCanvasRef,
  hasOriginalImage,
  isBlackAndWhite,
  isMulticolorLabEnabled,
  isPaletteDitheringEnabled,
  isPalettePreviewEnabled,
  isTasOwnershipPreviewEnabled,
  isTasPaletteFitPreviewEnabled,
  isTasPaletteFitLimitedToPalette,
  isTasPreviewEnabled,
  multicolorPaletteColors,
  multicolorPaletteCoverage,
  multicolorPaletteCoverageWithLineAllocation,
  multicolorPaletteCoverageWithSuggestions,
  multicolorLockedLineOverride,
  multicolorPalettePixelCountMap,
  multicolorPalettePreset,
  multicolorTargetTotalLines,
  normalizedSelectedTasRegionIndex,
  originalComparisonCanvasRef,
  onDiagnosticRender,
  paletteComparisonCanvasRef,
  setActivePaletteColorId,
  setIsBlackAndWhite,
  setIsMulticolorLabEnabled,
  setIsPaletteDitheringEnabled,
  setIsPalettePreviewEnabled,
  setIsTasOwnershipPreviewEnabled,
  setIsTasPaletteFitLimitedToPalette,
  setIsTasPaletteFitPreviewEnabled,
  setIsTasPreviewEnabled,
  setMulticolorLockedLineOverride,
  setMulticolorPaletteColors,
  setMulticolorPalettePresetId,
  setMulticolorTargetTotalLines,
  setSelectedTasRegionIndex,
  selectedTasRegion,
  shouldShowPaletteComparison,
  tasOwnershipPreview,
  tasPaletteFit,
  tasNetwork,
  tasViewScope,
  totalAllocatedSuggestedLines,
  totalPaletteCoverageTenths,
  setTasViewScope,
}) {
  const suggestedLinesByColorId = useMemo(
    () => new Map(
      multicolorPaletteCoverageWithSuggestions.map((color) => [color.id, color.allocatedUnits]),
    ),
    [multicolorPaletteCoverageWithSuggestions],
  );
  const sourceLabel = isPaletteDitheringEnabled ? 'dithered' : 'nearest';
  const hasSuggestedLineTarget = multicolorTargetTotalLines > 0;

  useRenderDiagnostics(
    'MulticolorLab',
    {
      activePaletteColorId,
      isPalettePreviewEnabled,
      paletteCoverageCount: multicolorPaletteCoverage.length,
      tasPreviewEnabled: isTasPreviewEnabled,
      tasRegionCount: tasNetwork.regionCount,
    },
    onDiagnosticRender,
  );

  return (
    <div className="multicolor-lab">
      <div className="multicolor-lab-header">
        <h2>Multicolor lab</h2>
        <p>Palette setup, TAS inspection, and region planning.</p>
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
            <span className="multicolor-status-chip">Source: {sourceLabel}</span>
            <span className="multicolor-status-chip">
              TAS regions: {tasNetwork.regionCount.toLocaleString()}
            </span>
          </div>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>Palette</h3>
              <p>Choose the working colors for TAS assignment.</p>
            </div>
            <div className="multicolor-lab-section-card">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isBlackAndWhite}
                  onChange={(event) => setIsBlackAndWhite(event.target.checked)}
                />
                <span>Show grayscale</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isPalettePreviewEnabled}
                  onChange={(event) => setIsPalettePreviewEnabled(event.target.checked)}
                />
                <span>Enable palette preview</span>
              </label>
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
                              ? { ...currentColor, enabled: event.target.checked }
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
                <span className="multicolor-lab-label">Palette source</span>
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
                  This affects palette preview and coverage. TAS coloring will use the same source.
                </p>
              </div>
            </div>
          </section>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>Inspect</h3>
              <p>Review palette reduction and coverage before TAS color fitting.</p>
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

              <div className="multicolor-inspect-block">
                <span className="multicolor-lab-label">Coverage</span>
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
              <h3>TAS regions</h3>
              <p>Inspect the chord inventory from the new region model.</p>
            </div>
            <div className="multicolor-lab-section-card">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isTasPreviewEnabled}
                  onChange={(event) => setIsTasPreviewEnabled(event.target.checked)}
                  disabled={tasNetwork.regionCount === 0}
                />
                <span>Show TAS lines</span>
              </label>
              <div
                className="multicolor-debug-toggle-group"
                role="radiogroup"
                aria-label="TAS view scope"
              >
                <button
                  className={[
                    'multicolor-debug-toggle',
                    tasViewScope === 'selected' ? 'is-active' : '',
                  ].filter(Boolean).join(' ')}
                  type="button"
                  role="radio"
                  aria-checked={tasViewScope === 'selected'}
                  onClick={() => setTasViewScope('selected')}
                >
                  view selected TAS
                </button>
                <button
                  className={[
                    'multicolor-debug-toggle',
                    tasViewScope === 'all' ? 'is-active' : '',
                  ].filter(Boolean).join(' ')}
                  type="button"
                  role="radio"
                  aria-checked={tasViewScope === 'all'}
                  onClick={() => setTasViewScope('all')}
                >
                  view all TAS
                </button>
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isTasOwnershipPreviewEnabled}
                  onChange={(event) => setIsTasOwnershipPreviewEnabled(event.target.checked)}
                  disabled={tasNetwork.regionCount === 0 || !hasOriginalImage}
                />
                <span>Show selected TAS pixel ownership</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isTasPaletteFitPreviewEnabled}
                  onChange={(event) => setIsTasPaletteFitPreviewEnabled(event.target.checked)}
                  disabled={tasNetwork.regionCount === 0 || !hasOriginalImage}
                />
                <span>Show TAS palette fit</span>
              </label>
              <div
                className="multicolor-debug-toggle-group"
                role="radiogroup"
                aria-label="TAS palette fit mode"
              >
                <button
                  className={[
                    'multicolor-debug-toggle',
                    isTasPaletteFitLimitedToPalette ? 'is-active' : '',
                  ].filter(Boolean).join(' ')}
                  type="button"
                  role="radio"
                  aria-checked={isTasPaletteFitLimitedToPalette}
                  onClick={() => setIsTasPaletteFitLimitedToPalette(true)}
                >
                  fit to palette colors
                </button>
                <button
                  className={[
                    'multicolor-debug-toggle',
                    !isTasPaletteFitLimitedToPalette ? 'is-active' : '',
                  ].filter(Boolean).join(' ')}
                  type="button"
                  role="radio"
                  aria-checked={!isTasPaletteFitLimitedToPalette}
                  onClick={() => setIsTasPaletteFitLimitedToPalette(false)}
                >
                  fit to closest color
                </button>
              </div>
              <label className="slider-control">
                <span>
                  Region D{normalizedSelectedTasRegionIndex}
                  {selectedTasRegion
                    ? ` (${selectedTasRegion.chordCount.toLocaleString()} chords)`
                    : ''}
                </span>
                <input
                  type="range"
                  min="0"
                  max={Math.max(0, tasNetwork.regionCount - 1)}
                  step="1"
                  value={normalizedSelectedTasRegionIndex}
                  onChange={(event) =>
                    setSelectedTasRegionIndex(Number.parseInt(event.target.value, 10) || 0)
                  }
                  disabled={tasNetwork.regionCount === 0}
                />
              </label>
              <div className="multicolor-inline-stats">
                <span className="multicolor-inline-stat">
                  Regions {tasNetwork.regionCount.toLocaleString()}
                </span>
                <span className="multicolor-inline-stat">
                  Chords {tasNetwork.totalChords.toLocaleString()}
                </span>
                {selectedTasRegion && (
                  <>
                    <span className="multicolor-inline-stat">
                      Radius {selectedTasRegion.minRadius.toFixed(1)}-{selectedTasRegion.maxRadius.toFixed(1)}
                    </span>
                    <span className="multicolor-inline-stat">
                      Active {selectedTasRegion.chordCount.toLocaleString()}
                    </span>
                    {tasOwnershipPreview && (
                      <>
                        <span className="multicolor-inline-stat">
                          Pixels {tasOwnershipPreview.assignedPixelCount.toLocaleString()}
                        </span>
                        <span className="multicolor-inline-stat">
                          Owners {tasOwnershipPreview.usedTasCount.toLocaleString()} /{' '}
                          {tasOwnershipPreview.regionTasCount.toLocaleString()}
                        </span>
                      </>
                    )}
                    {tasPaletteFit && (
                      <>
                        <span className="multicolor-inline-stat">
                          Fit {tasPaletteFit.fittedTasCount.toLocaleString()} /{' '}
                          {tasPaletteFit.regionTasCount.toLocaleString()}
                        </span>
                        <span className="multicolor-inline-stat">
                          Avg error{' '}
                          {!isTasPaletteFitLimitedToPalette || tasPaletteFit.averageError === null
                            ? '-'
                            : Math.round(tasPaletteFit.averageError).toLocaleString()}
                        </span>
                      </>
                    )}
                    {allTasPaletteFit && (
                      <>
                        <span className="multicolor-inline-stat">
                          All fit {allTasPaletteFit.fittedTasCount.toLocaleString()} /{' '}
                          {allTasPaletteFit.regionTasCount.toLocaleString()}
                        </span>
                        <span className="multicolor-inline-stat">
                          All avg error{' '}
                          {!isTasPaletteFitLimitedToPalette || allTasPaletteFit.averageError === null
                            ? '-'
                            : Math.round(allTasPaletteFit.averageError).toLocaleString()}
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>
              <p className="multicolor-mini-note">
                Pixel ownership assigns each in-circle pixel to the nearest finite TAS globally.
                The selected preview shows pixels whose winning TAS belongs to the selected D.
                For a quick geometry check, set nails to 10: D0 should show 5 diameter TASs,
                and D1-D4 should show 10 TASs each.
              </p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default MulticolorLab;
