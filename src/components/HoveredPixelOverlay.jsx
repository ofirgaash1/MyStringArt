function HoveredPixelOverlay({
  hoveredPixel,
  isArtMode,
  isBlackAndWhite,
  isBrushMode,
}) {
  if (!hoveredPixel || isArtMode) {
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
          : isBlackAndWhite
            ? `Darkness ${hoveredPixel.darkness}`
            : `RGB(${hoveredPixel.r}, ${hoveredPixel.g}, ${hoveredPixel.b})`}
      </div>
    </>
  );
}

export default HoveredPixelOverlay;
