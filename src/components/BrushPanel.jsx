import { useRenderDiagnostics } from '../renderDiagnostics';

function BrushPanel({
  activeGroup,
  activeGroupId,
  brushRadius,
  hasLoadedImage,
  isArtMode,
  isBrushMode,
  maxBrushRadius,
  maxGroupValue,
  minBrushRadius,
  minGroupValue,
  groupValueStep,
  pixelGroups,
  onActiveGroupChange,
  onAddPixelGroup,
  onBrushModeChange,
  onBrushRadiusChange,
  onGroupValueChange,
  onRemovePixelGroup,
  onDiagnosticRender,
}) {
  useRenderDiagnostics(
    'BrushPanel',
    {
      activeGroupId,
      brushRadius,
      groupCount: pixelGroups.length,
      hasLoadedImage,
      isArtMode,
      isBrushMode,
    },
    onDiagnosticRender,
  );

  return (
    <div className="brush-panel">
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={isBrushMode}
          onChange={(event) => onBrushModeChange(event.target.checked)}
          disabled={!hasLoadedImage || isArtMode}
        />
        <span>Brush select</span>
      </label>
      <label className="slider-control brush-radius-control">
        <span>Brush radius: {brushRadius}px</span>
        <input
          type="range"
          min={minBrushRadius}
          max={maxBrushRadius}
          step="1"
          value={brushRadius}
          onChange={(event) => onBrushRadiusChange(event.target.value)}
          disabled={!hasLoadedImage || isArtMode}
        />
      </label>
      <button
        className="action-button action-button-secondary"
        type="button"
        onClick={onAddPixelGroup}
        disabled={!hasLoadedImage || isArtMode}
      >
        add group
      </button>
      <div className="group-list">
        {pixelGroups.map((group) => {
          const isActiveGroup = group.id === activeGroupId;
          return (
            <div
              key={group.id}
              className={`group-card ${isActiveGroup ? 'is-active' : ''}`}
            >
              <button
                className="group-select-button"
                type="button"
                onClick={() => onActiveGroupChange(group.id)}
              >
                <span
                  className="group-swatch"
                  style={{ backgroundColor: group.color }}
                />
                <span>{group.name}</span>
              </button>
              <label className="group-value-control">
                <span>Weight: {group.value}</span>
                <input
                  type="range"
                  min={minGroupValue}
                  max={maxGroupValue}
                  step={groupValueStep}
                  value={group.value}
                  onChange={(event) => onGroupValueChange(group.id, event.target.value)}
                />
              </label>
              <p className="group-meta">
                {group.pixelCount} pixels
              </p>
              <button
                className="action-button action-button-secondary group-remove-button"
                type="button"
                onClick={() => onRemovePixelGroup(group.id)}
              >
                remove
              </button>
            </div>
          );
        })}
      </div>
      <p className="brush-summary">
        {activeGroup
          ? `${activeGroup.name}: ${activeGroup.pixelCount} pixels, value ${activeGroup.value.toFixed(2)}`
          : 'No active group'}
      </p>
    </div>
  );
}

export default BrushPanel;
