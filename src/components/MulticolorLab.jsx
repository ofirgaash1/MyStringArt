import {
  clonePalettePreset,
  MULTICOLOR_DEBUG_VIEWS,
  MULTICOLOR_PALETTE_PRESETS,
} from '../multicolor';

function MulticolorLab({
  activePaletteColor,
  activePaletteColorId,
  ditheredComparisonCanvasRef,
  enabledPalettePreviewColors,
  canUseActiveColorMaskForLineScoring,
  isActiveColorOnlyControlVisible,
  isActiveColorMaskScoringEnabled,
  isActivePaletteColorOnlyEnabled,
  isMulticolorLabEnabled,
  isPaletteDitheringEnabled,
  isPaletteMaskVisible,
  isPalettePreviewEnabled,
  maskBlurRadius,
  multicolorDebugView,
  multicolorPaletteColors,
  multicolorPaletteCoverage,
  multicolorPaletteCoverageWithLineAllocation,
  multicolorPaletteCoverageWithSuggestions,
  multicolorLockedLineOverride,
  multicolorPalettePixelCountMap,
  multicolorPalettePreset,
  originalComparisonCanvasRef,
  paletteComparisonCanvasRef,
  palettePreviewModeLabel,
  setActivePaletteColorId,
  setIsActivePaletteColorOnlyEnabled,
  setIsActiveColorMaskScoringEnabled,
  setIsMulticolorLabEnabled,
  setIsPaletteDitheringEnabled,
  setIsPalettePreviewEnabled,
  setMaskBlurRadius,
  setMulticolorDebugView,
  setMulticolorLockedLineOverride,
  setMulticolorPaletteColors,
  setMulticolorPalettePresetId,
  shouldShowPaletteComparison,
  totalAllocatedSuggestedLines,
  totalPaletteCoverageTenths,
  totalSuggestedMulticolorLines,
  hasOriginalImage,
}) {
  const selectedDebugView = MULTICOLOR_DEBUG_VIEWS.find(
    (view) => view.id === multicolorDebugView,
  );
  const suggestedLinesByColorId = new Map(
    multicolorPaletteCoverageWithSuggestions.map((color) => [color.id, color.allocatedUnits]),
  );

  return (
    <div className="multicolor-lab">
      <div className="multicolor-lab-header">
        <h2>Multicolor lab</h2>
        <p>
          Isolated staging area for the slow multicolor port. Solver behavior stays untouched;
          preview changes here are display-only.
        </p>
      </div>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={isMulticolorLabEnabled}
          onChange={(event) => setIsMulticolorLabEnabled(event.target.checked)}
        />
        <span>Enable multicolor lab</span>
      </label>
      {isMulticolorLabEnabled && (
        <div className="multicolor-lab-body">
          <div className="multicolor-lab-placeholder">
            <span className="multicolor-lab-label">Debug view</span>
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
                    {view.label}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="multicolor-lab-placeholder">
            <span className="multicolor-lab-label">Palette preset</span>
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
            <p className="multicolor-lab-helper">
              Active preset: {multicolorPalettePreset.name}
            </p>
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
                  <span className="multicolor-palette-value">{color.hex}</span>
                  <span className="multicolor-palette-count-value">
                    {hasOriginalImage
                      ? `${(multicolorPalettePixelCountMap.get(color.id) ?? 0).toLocaleString()} px`
                      : '-'}
                  </span>
                </div>
              ))}
            </div>
            {isActiveColorOnlyControlVisible && (
              <>
                <label className="checkbox-row multicolor-lab-helper-row">
                  <input
                    type="checkbox"
                    checked={isActivePaletteColorOnlyEnabled}
                    onChange={(event) => setIsActivePaletteColorOnlyEnabled(event.target.checked)}
                    disabled={!activePaletteColor || enabledPalettePreviewColors.length === 0}
                  />
                  <span>
                    Show active color only
                    {activePaletteColor ? ` (${activePaletteColor.hex})` : ''}
                  </span>
                </label>
                <p className="multicolor-lab-helper">
                  Click a swatch to make it active. This mode hides all non-active palette matches
                  in the palette preview.
                </p>
              </>
            )}
          </div>
          <label className="checkbox-row multicolor-lab-placeholder">
            <input
              type="checkbox"
              checked={isPaletteDitheringEnabled}
              onChange={(event) => setIsPaletteDitheringEnabled(event.target.checked)}
              disabled={!isPalettePreviewEnabled}
            />
            <span>Use Floyd-Steinberg dithering preview</span>
          </label>
          <p className="multicolor-lab-note">
            {selectedDebugView?.label} using {palettePreviewModeLabel.toLowerCase()}.
          </p>
          <div className="multicolor-lab-placeholder">
            <span className="multicolor-lab-label">Mask source coverage</span>
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
                      <span className="multicolor-histogram-lines">
                        {color.isLocked ? 'Locked ' : ''}
                        {color.allocatedUnits.toLocaleString()} lines
                      </span>
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
                        <span>Lock line count</span>
                      </label>
                      <label className="multicolor-histogram-input">
                        <span>Manual lines</span>
                        <input
                          type="number"
                          min="0"
                          max={totalSuggestedMulticolorLines}
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
                        Auto: {(suggestedLinesByColorId.get(color.id) ?? 0).toLocaleString()} lines
                      </span>
                    </div>
                  </div>
                ))}
                <p className="multicolor-histogram-total">
                  Total: {(totalPaletteCoverageTenths / 10).toFixed(1)}%
                </p>
                <p className="multicolor-histogram-total">
                  Displayed split: {totalAllocatedSuggestedLines.toLocaleString()} /{' '}
                  {totalSuggestedMulticolorLines.toLocaleString()} lines
                </p>
                <p className="multicolor-lab-helper multicolor-histogram-helper">
                  Auto suggestions are based on the current monochrome sequence length. Locking one
                  color only changes this preview allocation; the solver still ignores it.
                  {totalSuggestedMulticolorLines === 0
                    ? ' Save some lines first to get non-zero per-color suggestions.'
                    : ''}
                </p>
              </div>
            ) : (
              <p className="multicolor-lab-helper">
                Load an image and keep at least one palette color enabled to see coverage
                percentages for the current {palettePreviewModeLabel.toLowerCase()} source.
              </p>
            )}
          </div>
          <div className="multicolor-lab-placeholder">
            <label className="slider-control">
              <span>Mask blur radius: {maskBlurRadius}</span>
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
          </div>
          <label className="checkbox-row multicolor-lab-placeholder">
            <input
              type="checkbox"
              checked={isActiveColorMaskScoringEnabled}
              onChange={(event) => setIsActiveColorMaskScoringEnabled(event.target.checked)}
              disabled={!canUseActiveColorMaskForLineScoring}
            />
            <span>Use active color mask for line scoring</span>
          </label>
          <p className="multicolor-lab-helper">
            Dev toggle. The darkness chart and next-nail selection read from the active palette
            color mask instead of the grayscale target. Existing rendering and export flow stay
            unchanged.
          </p>
          {isPaletteMaskVisible && (
            <p className="multicolor-lab-helper">
              Showing a black/white mask for the active palette color using the current
              {` ${palettePreviewModeLabel.toLowerCase()}`} source. Set the blur radius to{' '}
              <code>0</code> for the raw mask and increase it to preview a softened version.
            </p>
          )}
          {shouldShowPaletteComparison && (
            <div className="multicolor-lab-placeholder">
              <span className="multicolor-lab-label">Palette comparison</span>
              <div className="multicolor-comparison-grid">
                <figure className="multicolor-comparison-card">
                  <figcaption>Original RGB</figcaption>
                  <canvas
                    ref={originalComparisonCanvasRef}
                    className="multicolor-comparison-canvas"
                  />
                </figure>
                <figure className="multicolor-comparison-card">
                  <figcaption>Nearest-palette preview</figcaption>
                  <canvas
                    ref={paletteComparisonCanvasRef}
                    className="multicolor-comparison-canvas"
                  />
                </figure>
                {isPaletteDitheringEnabled && (
                  <figure className="multicolor-comparison-card">
                    <figcaption>Floyd-Steinberg preview</figcaption>
                    <canvas
                      ref={ditheredComparisonCanvasRef}
                      className="multicolor-comparison-canvas"
                    />
                  </figure>
                )}
              </div>
            </div>
          )}
          <label className="checkbox-row multicolor-lab-placeholder">
            <input
              type="checkbox"
              checked={isPalettePreviewEnabled}
              onChange={(event) => setIsPalettePreviewEnabled(event.target.checked)}
            />
            <span>Use palette preview</span>
          </label>
        </div>
      )}
    </div>
  );
}

export default MulticolorLab;
