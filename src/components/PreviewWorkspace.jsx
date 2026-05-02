import { useEffect, useRef } from 'react';
import { useRenderDiagnostics } from '../renderDiagnostics';

const ART_PREVIEW_CANVAS_SIZE = 1200;
const ART_PREVIEW_DRAW_BATCH_SIZE = 400;

function drawBitsetPreview(canvas, preview) {
  if (!canvas || !preview || !Number.isFinite(preview.gridSize) || preview.gridSize <= 0) {
    return;
  }

  const { gridSize, targetMask, paintedMask } = preview;
  if (!(targetMask instanceof Uint32Array) || !(paintedMask instanceof Uint32Array)) {
    return;
  }

  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }

  canvas.width = gridSize;
  canvas.height = gridSize;
  const imageData = context.createImageData(gridSize, gridSize);
  const { data } = imageData;
  const cellCount = gridSize * gridSize;
  for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
    const wordIndex = cellIndex >>> 5;
    const bitMask = 1 << (cellIndex & 31);
    const isTarget = (targetMask[wordIndex] & bitMask) !== 0;
    const isPainted = (paintedMask[wordIndex] & bitMask) !== 0;
    const pixelIndex = cellIndex * 4;

    if (isTarget && isPainted) {
      data[pixelIndex] = 34;
      data[pixelIndex + 1] = 197;
      data[pixelIndex + 2] = 94;
      data[pixelIndex + 3] = 245;
    } else if (isTarget) {
      data[pixelIndex] = 248;
      data[pixelIndex + 1] = 113;
      data[pixelIndex + 2] = 113;
      data[pixelIndex + 3] = 215;
    } else if (isPainted) {
      data[pixelIndex] = 59;
      data[pixelIndex + 1] = 130;
      data[pixelIndex + 2] = 246;
      data[pixelIndex + 3] = 120;
    } else {
      data[pixelIndex + 3] = 0;
    }
  }

  context.putImageData(imageData, 0, 0);
}

function drawArtPreviewChunk(context, lines, nails, startIndex, endIndex, scale) {
  for (let lineIndex = startIndex; lineIndex < endIndex; lineIndex += 1) {
    const line = lines[lineIndex];
    if (!line) {
      continue;
    }

    const startNail = nails[line.startNailNumber - 1];
    const endNail = nails[line.endNailNumber - 1];
    if (!startNail || !endNail) {
      continue;
    }

    context.beginPath();
    context.strokeStyle = line.stroke ?? '#020617';
    context.lineWidth = 16;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.moveTo(startNail.cx * scale, startNail.cy * scale);
    context.lineTo(endNail.cx * scale, endNail.cy * scale);
    context.stroke();
  }
}

function forEachPackedLine(linesPacked, callback) {
  if (!Array.isArray(linesPacked) && !ArrayBuffer.isView(linesPacked)) {
    return;
  }

  for (let index = 0; index + 2 < linesPacked.length; index += 3) {
    callback({
      startNailNumber: linesPacked[index],
      endNailNumber: linesPacked[index + 1],
      stepOrder: linesPacked[index + 2],
    }, index / 3);
  }
}

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
  multicolorLineBuckets,
  savedNailSequence,
  previewRef,
  previewStyle,
  sharedLoopBitsetPreview,
  sharedLoopSolverMode,
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
  const bitsetPreviewCanvasRef = useRef(null);
  const artPreviewCanvasRef = useRef(null);

  useEffect(() => {
    if (sharedLoopSolverMode !== 'bitset-prototype' || !sharedLoopBitsetPreview) {
      return;
    }
    drawBitsetPreview(bitsetPreviewCanvasRef.current, sharedLoopBitsetPreview);
  }, [sharedLoopBitsetPreview, sharedLoopSolverMode]);

  useEffect(() => {
    const canvas = artPreviewCanvasRef.current;
    if (!canvas || sharedLoopSolverMode === 'bitset-prototype' || !isArtMode) {
      return;
    }

    const context = canvas.getContext('2d');
    if (!context) {
      return;
    }

    canvas.width = ART_PREVIEW_CANVAS_SIZE;
    canvas.height = ART_PREVIEW_CANVAS_SIZE;
    context.clearRect(0, 0, canvas.width, canvas.height);
    let cancelled = false;
    let animationFrameId = 0;
    const lineQueue = [];
    for (let index = 0; index < savedNailSequence.length; index += 1) {
      const endNailNumber = savedNailSequence[index];
      const startNailNumber = index === 0 ? 1 : savedNailSequence[index - 1];
      lineQueue.push({
        startNailNumber,
        endNailNumber,
        stroke: '#020617',
      });
    }
    for (const bucket of multicolorLineBuckets) {
      if (!bucket?.visible || (bucket.lineCount ?? 0) <= 0) {
        continue;
      }
      forEachPackedLine(bucket.linesPacked, (line) => {
        lineQueue.push({
          startNailNumber: line.startNailNumber,
          endNailNumber: line.endNailNumber,
          stroke: bucket.hex ?? '#020617',
        });
      });
    }

    if (lineQueue.length === 0) {
      return undefined;
    }

    const scale = ART_PREVIEW_CANVAS_SIZE / 100;
    let drawIndex = 0;
    const drawNextChunk = () => {
      if (cancelled) {
        return;
      }

      const nextIndex = Math.min(drawIndex + ART_PREVIEW_DRAW_BATCH_SIZE, lineQueue.length);
      drawArtPreviewChunk(context, lineQueue, nails, drawIndex, nextIndex, scale);
      drawIndex = nextIndex;
      if (drawIndex < lineQueue.length) {
        animationFrameId = window.requestAnimationFrame(drawNextChunk);
      }
    };

    animationFrameId = window.requestAnimationFrame(drawNextChunk);
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(animationFrameId);
    };
  }, [isArtMode, multicolorLineBuckets, nails, savedNailSequence, sharedLoopSolverMode]);

  useRenderDiagnostics(
    'PreviewWorkspace',
    {
      artLineSegmentCount: artLineSegments.length,
      cropToCircle,
      bitsetGridSize: sharedLoopBitsetPreview?.gridSize ?? 0,
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
              {sharedLoopSolverMode === 'bitset-prototype' && sharedLoopBitsetPreview && (
                <>
                  <canvas
                    ref={bitsetPreviewCanvasRef}
                    className="art-bitset-preview-layer"
                    aria-hidden="true"
                    width={sharedLoopBitsetPreview.gridSize}
                    height={sharedLoopBitsetPreview.gridSize}
                  />
                  <div className="art-bitset-preview-caption" aria-hidden="true">
                    bitset raster {sharedLoopBitsetPreview.gridSize}x{sharedLoopBitsetPreview.gridSize}
                  </div>
                </>
              )}
              {sharedLoopSolverMode !== 'bitset-prototype' && (
                <canvas
                  ref={artPreviewCanvasRef}
                  className="art-canvas-layer"
                  aria-hidden="true"
                  width={ART_PREVIEW_CANVAS_SIZE}
                  height={ART_PREVIEW_CANVAS_SIZE}
                />
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
