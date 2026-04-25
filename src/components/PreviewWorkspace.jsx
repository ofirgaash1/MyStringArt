import { useEffect, useRef } from 'react';
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
  selectedTasRegionIndex,
  shouldShowPreviewLine,
  showNailNumbers,
  tasOwnershipPreviewImageData,
  tasPaletteFitSegments = [],
  tasPreviewSegments = [],
  onDiagnosticRender,
  onPointerUp,
  onPointerCancel,
  onPointerLeave,
}) {
  const tasOwnershipCanvasRef = useRef(null);

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
      showNailNumbers,
      shouldShowPreviewLine,
      tasOwnershipPreview: Boolean(tasOwnershipPreviewImageData),
      tasPaletteFitSegmentCount: tasPaletteFitSegments.length,
      tasPreviewSegmentCount: tasPreviewSegments.length,
    },
    onDiagnosticRender,
  );

  useEffect(() => {
    const canvas = tasOwnershipCanvasRef.current;
    if (!canvas) {
      return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    if (!tasOwnershipPreviewImageData) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    canvas.width = tasOwnershipPreviewImageData.width;
    canvas.height = tasOwnershipPreviewImageData.height;
    context.putImageData(tasOwnershipPreviewImageData, 0, 0);
  }, [tasOwnershipPreviewImageData]);

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
                    <line
                      key={segment.key}
                      className={segment.className ?? 'art-line'}
                      x1={segment.x1}
                      y1={segment.y1}
                      x2={segment.x2}
                      y2={segment.y2}
                      style={segment.stroke ? { stroke: segment.stroke } : undefined}
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
              {tasPreviewSegments.length > 0 && (
                <svg
                  className="tas-preview-layer"
                  aria-hidden="true"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                >
                  {tasPreviewSegments.map((segment) => (
                    <line
                      key={segment.key}
                      className={[
                        'tas-preview-line',
                        segment.regionIndex % 2 === 0 ? 'is-even-region' : 'is-odd-region',
                        segment.regionIndex === selectedTasRegionIndex ? 'is-selected-region' : '',
                      ].join(' ')}
                      x1={segment.x1}
                      y1={segment.y1}
                      x2={segment.x2}
                      y2={segment.y2}
                    />
                  ))}
                </svg>
              )}
              {tasPaletteFitSegments.length > 0 && (
                <svg
                  className="tas-palette-fit-layer"
                  aria-hidden="true"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                >
                  {tasPaletteFitSegments.map((segment) => (
                    <line
                      key={segment.key}
                      className="tas-palette-fit-line"
                      x1={segment.x1}
                      y1={segment.y1}
                      x2={segment.x2}
                      y2={segment.y2}
                      style={{ stroke: segment.stroke }}
                    />
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
              {tasOwnershipPreviewImageData && (
                <canvas
                  ref={tasOwnershipCanvasRef}
                  className="tas-ownership-layer"
                  aria-hidden="true"
                  width={tasOwnershipPreviewImageData.width}
                  height={tasOwnershipPreviewImageData.height}
                  style={imageLayerStyle}
                />
              )}
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
              {tasPreviewSegments.length > 0 && (
                <svg
                  className="tas-preview-layer"
                  aria-hidden="true"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                >
                  {tasPreviewSegments.map((segment) => (
                    <line
                      key={segment.key}
                      className={[
                        'tas-preview-line',
                        segment.regionIndex % 2 === 0 ? 'is-even-region' : 'is-odd-region',
                        segment.regionIndex === selectedTasRegionIndex ? 'is-selected-region' : '',
                      ].join(' ')}
                      x1={segment.x1}
                      y1={segment.y1}
                      x2={segment.x2}
                      y2={segment.y2}
                    />
                  ))}
                </svg>
              )}
              {tasPaletteFitSegments.length > 0 && (
                <svg
                  className="tas-palette-fit-layer"
                  aria-hidden="true"
                  viewBox="0 0 100 100"
                  preserveAspectRatio="none"
                >
                  {tasPaletteFitSegments.map((segment) => (
                    <line
                      key={segment.key}
                      className="tas-palette-fit-line"
                      x1={segment.x1}
                      y1={segment.y1}
                      x2={segment.x2}
                      y2={segment.y2}
                      style={{ stroke: segment.stroke }}
                    />
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
