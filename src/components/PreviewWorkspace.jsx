import { useRenderDiagnostics } from '../renderDiagnostics';

function PreviewWorkspace({
  artLineSegments,
  cropToCircle,
  handlePointerDown,
  handlePointerMove,
  hasLoadedImage,
  imageLayerStyle,
  imageRef,
  imageSize,
  imageStyle,
  isArtMode,
  lineEnd,
  linePixels,
  lineStart,
  nailFontSize,
  nailRadius,
  nails,
  nailsCount,
  previewRef,
  previewStyle,
  selectionOverlayRef,
  shouldShowPreviewLine,
  showNailNumbers,
  isWhiteTestOverlayEnabled,
  whiteTestOverlayPathData,
  onDiagnosticRender,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
}) {
  useRenderDiagnostics(
    'PreviewWorkspace',
    {
      artLineSegmentCount: artLineSegments.length,
      cropToCircle,
      hasLoadedImage,
      imageHeight: imageSize?.height ?? 0,
      imageWidth: imageSize?.width ?? 0,
      isArtMode,
      linePixelCount: linePixels.length,
      nailsCount,
      whiteTestOverlayEnabled: isWhiteTestOverlayEnabled,
      showNailNumbers,
      shouldShowPreviewLine,
    },
    onDiagnosticRender,
  );

  return (
    <main className="workspace">
      <div
        className="preview-shell"
        style={previewStyle}
      >
        {nailsCount > 0 && showNailNumbers && (
          <svg
            className="nails-labels-layer"
            aria-hidden="true"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            {nails.map((nail) => (
              <text
                key={`${nail.key}-label`}
                className="nail-number"
                x={nail.labelX}
                y={nail.labelY}
                fontSize={nailFontSize}
              >
                {nail.number}
              </text>
            ))}
          </svg>
        )}
        <div
          ref={previewRef}
          className={`preview-frame ${cropToCircle ? 'is-circle' : ''}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={onPointerUp}
          onPointerLeave={onPointerLeave}
          onPointerCancel={onPointerCancel}
        >
          {isArtMode ? (
            <>
              {nailsCount > 0 && (
                <svg
                  className="art-lines-layer"
                  aria-hidden="true"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                >
                  {artLineSegments.map((segment) => (
                    <polygon
                      key={segment.key}
                      className={segment.className ?? 'art-line'}
                      points={segment.polygonPoints}
                      style={segment.stroke ? { fill: segment.stroke } : undefined}
                    />
                  ))}
                </svg>
              )}
              {isWhiteTestOverlayEnabled && whiteTestOverlayPathData && (
                <svg
                  className="art-white-test-layer"
                  aria-hidden="true"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                >
                  <path
                    className="art-white-test-path"
                    d={whiteTestOverlayPathData}
                    fillRule="evenodd"
                  />
                </svg>
              )}
              {nailsCount > 0 && (
                <svg
                  className="nails-layer"
                  aria-hidden="true"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                >
                  {nails.map((nail) => (
                    <g key={nail.key}>
                      <circle
                        className="nail"
                        cx={nail.cx}
                        cy={nail.cy}
                        r={nailRadius}
                      />
                    </g>
                  ))}
                </svg>
              )}
            </>
          ) : hasLoadedImage ? (
            <>
              <canvas
                ref={imageRef}
                className="preview-image"
                width={imageSize.width}
                height={imageSize.height}
                style={imageStyle}
              />
              <canvas
                ref={selectionOverlayRef}
                className="brush-selection-layer"
                aria-hidden="true"
                width={imageSize.width}
                height={imageSize.height}
                style={imageLayerStyle}
              />
              {linePixels.length > 0 && (
                <svg
                  className="line-pixels-layer"
                  aria-hidden="true"
                  viewBox={`0 0 ${imageSize.width} ${imageSize.height}`}
                  style={imageLayerStyle}
                >
                  {linePixels.map((pixel) => (
                    <rect
                      key={pixel.key}
                      className="line-pixel"
                      x={pixel.x}
                      y={pixel.y}
                      width="1"
                      height="1"
                    />
                  ))}
                </svg>
              )}
              {nailsCount > 0 && (
                <svg
                  className="nails-layer"
                  aria-hidden="true"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                >
                  {shouldShowPreviewLine && (
                    <line
                      className="preview-debug-line"
                      x1={lineStart.cx}
                      y1={lineStart.cy}
                      x2={lineEnd.cx}
                      y2={lineEnd.cy}
                    />
                  )}
                  {nails.map((nail) => (
                    <g key={nail.key}>
                      <circle
                        className="nail"
                        cx={nail.cx}
                        cy={nail.cy}
                        r={nailRadius}
                      />
                    </g>
                  ))}
                </svg>
              )}
            </>
          ) : (
            <div className="empty-state">
              <p>Choose an image to start.</p>
              <p>The preview will appear here.</p>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

export default PreviewWorkspace;
