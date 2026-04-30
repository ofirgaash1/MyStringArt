import { useRenderDiagnostics } from '../renderDiagnostics';

function HoveredPixelOverlay({
  hoveredPixel,
  isArtMode,
  isBlackAndWhite,
  isBrushMode,
  onDiagnosticRender,
}) {
  useRenderDiagnostics(
    'HoveredPixelOverlay',
    {
      hasHoveredPixel: Boolean(hoveredPixel),
      isArtMode,
      isBlackAndWhite,
      isBrushMode,
    },
    onDiagnosticRender,
  );

  if (!hoveredPixel) {
    return null;
  }

  return (
    <>
      <div
        className="pixel-outline"
        style={{
          left: hoveredPixel.left,
          top: hoveredPixel.top,
          width: hoveredPixel.width,
          height: hoveredPixel.height,
          borderRadius: hoveredPixel.borderRadius ?? undefined,
        }}
      />
      <div
        className="pixel-hint"
        style={{
          left: hoveredPixel.x,
          top: hoveredPixel.y - 16,
        }}
      >
        {isBrushMode
          ? `${hoveredPixel.pixelX},${hoveredPixel.pixelY}`
          : `${hoveredPixel.hoverModeLabel ?? 'pixel'} target: ${
            hoveredPixel.targetColorNumber !== null ? `#${hoveredPixel.targetColorNumber}` : 'n/a'
          }; current: ${
            hoveredPixel.currentColorLabel ??
            (
              hoveredPixel.isCurrentColorWhite
                ? 'white'
                : hoveredPixel.currentColorNumber !== null
                  ? `#${hoveredPixel.currentColorNumber}`
                  : 'n/a'
            )
          }`}
      </div>
    </>
  );
}

export default HoveredPixelOverlay;
