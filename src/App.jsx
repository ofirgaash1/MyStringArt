import { useEffect, useRef, useState } from 'react';

const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
const MIN_PREVIEW_SCALE = 50;
const MAX_PREVIEW_SCALE = 1000;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function rasterizeLinePixels(startX, startY, endX, endY, width, height) {
  const pixels = [];
  const x0 = Math.round(startX);
  const y0 = Math.round(startY);
  const x1 = Math.round(endX);
  const y1 = Math.round(endY);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let error = dx - dy;
  let x = x0;
  let y = y0;

  while (true) {
    if (x >= 0 && x < width && y >= 0 && y < height) {
      pixels.push({ key: `${x}-${y}`, x, y });
    }

    if (x === x1 && y === y1) {
      break;
    }

    const doubledError = error * 2;
    if (doubledError > -dy) {
      error -= dy;
      x += sx;
    }
    if (doubledError < dx) {
      error += dx;
      y += sy;
    }
  }

  return pixels;
}

function getPixelDarkness(imageData, width, x, y) {
  const index = (y * width + x) * 4;
  return (
    (imageData[index] + imageData[index + 1] + imageData[index + 2]) / 3
  );
}

function App() {
  const [imageUrl, setImageUrl] = useState('');
  const [imageName, setImageName] = useState('');
  const [imageSize, setImageSize] = useState(null);
  const [cropToCircle, setCropToCircle] = useState(true);
  const [isBlackAndWhite, setIsBlackAndWhite] = useState(true);
  const [showNailNumbers, setShowNailNumbers] = useState(true);
  const [nailsCount, setNailsCount] = useState(300);
  const [lineFrom, setLineFrom] = useState('');
  const [lineTo, setLineTo] = useState('');
  const [scale, setScale] = useState(1);
  const [previewScale, setPreviewScale] = useState(100);
  const [imageOffset, setImageOffset] = useState({ x: 0, y: 0 });
  const [previewOffset, setPreviewOffset] = useState({ x: 0, y: 0 });
  const [dragState, setDragState] = useState(null);
  const [hoveredPixel, setHoveredPixel] = useState(null);

  const previewRef = useRef(null);
  const imageRef = useRef(null);
  const imageCanvasRef = useRef(null);

  useEffect(() => {
    return () => {
      if (imageUrl) {
        URL.revokeObjectURL(imageUrl);
      }
    };
  }, [imageUrl]);

  const handleFileChange = (event) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (imageUrl) {
      URL.revokeObjectURL(imageUrl);
    }

    const nextUrl = URL.createObjectURL(file);
    setImageUrl(nextUrl);
    setImageName(file.name);
    setImageOffset({ x: 0, y: 0 });
    setPreviewOffset({ x: 0, y: 0 });

    const img = new Image();
    img.onload = () => {
      const previewSize = previewRef.current?.clientWidth ?? 420;
      const fittedScale = Math.max(
        previewSize / img.width,
        previewSize / img.height,
      );

      setImageSize({ width: img.width, height: img.height });
      setScale(clamp(fittedScale, MIN_SCALE, MAX_SCALE));

      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const context = canvas.getContext('2d', { willReadFrequently: true });
      context?.drawImage(img, 0, 0);
      imageCanvasRef.current = canvas;
    };
    img.src = nextUrl;
  };

  const updateHoveredPixel = (event) => {
    if (!imageUrl || !imageSize || !imageCanvasRef.current) {
      setHoveredPixel(null);
      return;
    }

    const imageRect = imageRef.current?.getBoundingClientRect();
    if (!imageRect) {
      setHoveredPixel(null);
      return;
    }

    const imageX =
      ((event.clientX - imageRect.left) / imageRect.width) * imageSize.width;
    const imageY =
      ((event.clientY - imageRect.top) / imageRect.height) * imageSize.height;

    if (
      imageX < 0 ||
      imageY < 0 ||
      imageX >= imageSize.width ||
      imageY >= imageSize.height
    ) {
      setHoveredPixel(null);
      return;
    }

    const context = imageCanvasRef.current.getContext('2d', {
      willReadFrequently: true,
    });
    const pixelColumn = Math.floor(imageX);
    const pixelRow = Math.floor(imageY);
    const pixel = context?.getImageData(
      pixelColumn,
      pixelRow,
      1,
      1,
    ).data;

    if (!pixel) {
      setHoveredPixel(null);
      return;
    }

    setHoveredPixel({
      x: event.clientX,
      y: event.clientY,
      left: imageRect.left + (pixelColumn / imageSize.width) * imageRect.width,
      top: imageRect.top + (pixelRow / imageSize.height) * imageRect.height,
      width: imageRect.width / imageSize.width,
      height: imageRect.height / imageSize.height,
      r: pixel[0],
      g: pixel[1],
      b: pixel[2],
      darkness: Math.round((pixel[0] + pixel[1] + pixel[2]) / 3),
    });
  };

  const handlePointerDown = (event) => {
    if (!imageUrl) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    if (event.shiftKey) {
      setDragState({
        mode: 'preview',
        pointerStart: { x: event.clientX, y: event.clientY },
        startOffset: previewOffset,
      });
      return;
    }

    setDragState({
      mode: 'image',
      pointerStart: { x: event.clientX, y: event.clientY },
      startOffset: imageOffset,
    });
  };

  const handlePointerMove = (event) => {
    if (!dragState) {
      updateHoveredPixel(event);
      return;
    }

    if (dragState.mode === 'preview') {
      setPreviewOffset({
        x: dragState.startOffset.x + event.clientX - dragState.pointerStart.x,
        y: dragState.startOffset.y + event.clientY - dragState.pointerStart.y,
      });
      updateHoveredPixel(event);
      return;
    }

    setImageOffset({
      x:
        dragState.startOffset.x +
        (event.clientX - dragState.pointerStart.x) / (previewScale / 100),
      y:
        dragState.startOffset.y +
        (event.clientY - dragState.pointerStart.y) / (previewScale / 100),
    });
    updateHoveredPixel(event);
  };

  const stopDragging = (event) => {
    if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragState(null);
  };

  const handleWheel = (event) => {
    event.preventDefault();
    const previewRect = previewRef.current?.getBoundingClientRect();
    if (!previewRect) {
      return;
    }

    const imageRect = imageRef.current?.getBoundingClientRect() ?? null;
    const zoomFactor = event.deltaY < 0 ? 1.08 : 0.92;

    if (event.shiftKey) {
      const nextPreviewScale = Math.max(
        Math.round(previewScale * zoomFactor),
        MIN_PREVIEW_SCALE,
      );
      const previewRatio = nextPreviewScale / previewScale;

      if (!imageRect || !imageUrl) {
        const previewCenterX = previewRect.left + previewRect.width / 2;
        const previewCenterY = previewRect.top + previewRect.height / 2;

        setPreviewOffset((currentOffset) => ({
          x: currentOffset.x + (1 - previewRatio) * (event.clientX - previewCenterX),
          y: currentOffset.y + (1 - previewRatio) * (event.clientY - previewCenterY),
        }));
        setPreviewScale(nextPreviewScale);
        return;
      }

      const imageCenterX = imageRect.left + imageRect.width / 2;
      const imageCenterY = imageRect.top + imageRect.height / 2;
      const previewCenterX = previewRect.left + previewRect.width / 2;
      const previewCenterY = previewRect.top + previewRect.height / 2;
      const cursorRatioX = (event.clientX - imageRect.left) / imageRect.width;
      const cursorRatioY = (event.clientY - imageRect.top) / imageRect.height;
      const nextImageWidth = imageRect.width * previewRatio;
      const nextImageHeight = imageRect.height * previewRatio;
      const predictedCenterX =
        previewCenterX + (imageCenterX - previewCenterX) * previewRatio;
      const predictedCenterY =
        previewCenterY + (imageCenterY - previewCenterY) * previewRatio;
      const predictedLeft = predictedCenterX - nextImageWidth / 2;
      const predictedTop = predictedCenterY - nextImageHeight / 2;
      const desiredLeft = event.clientX - cursorRatioX * nextImageWidth;
      const desiredTop = event.clientY - cursorRatioY * nextImageHeight;

      setPreviewOffset((currentOffset) => ({
        x: currentOffset.x + (desiredLeft - predictedLeft),
        y: currentOffset.y + (desiredTop - predictedTop),
      }));
      setPreviewScale(nextPreviewScale);
      return;
    }

    if (!imageUrl) {
      return;
    }

    if (!imageRect) {
      return;
    }

    const nextScale = clamp(scale * zoomFactor, MIN_SCALE, MAX_SCALE);
    const imageRatio = nextScale / scale;
    const imageCenterX = imageRect.left + imageRect.width / 2;
    const imageCenterY = imageRect.top + imageRect.height / 2;
    const nextCenterX =
      event.clientX - imageRatio * (event.clientX - imageCenterX);
    const nextCenterY =
      event.clientY - imageRatio * (event.clientY - imageCenterY);
    const previewScreenScale = previewScale / 100;

    setImageOffset((currentOffset) => ({
      x: currentOffset.x + (nextCenterX - imageCenterX) / previewScreenScale,
      y: currentOffset.y + (nextCenterY - imageCenterY) / previewScreenScale,
    }));
    setScale(nextScale);
  };

  const imageStyle = {
    transform: `translate(-50%, -50%) translate(${imageOffset.x}px, ${imageOffset.y}px) scale(${scale})`,
    cursor: dragState?.mode === 'image' ? 'grabbing' : imageUrl ? 'grab' : 'default',
    filter: isBlackAndWhite ? 'grayscale(1)' : 'none',
  };

  const previewStyle = {
    transform: `translate(${previewOffset.x}px, ${previewOffset.y}px) scale(${previewScale / 100})`,
    cursor: dragState?.mode === 'preview' ? 'grabbing' : 'default',
  };
  const inversePreviewScale = 100 / previewScale;
  const nailRadius = 0.8 * inversePreviewScale;
  const nailOrbitRadius = 50 - nailRadius;
  const nailLabelRadius = 50 + 2.6 * inversePreviewScale;
  const nailFontSize = 2.2 * inversePreviewScale;

  const nails = Array.from({ length: nailsCount }, (_, index) => {
    const angle = (index / nailsCount) * Math.PI * 2 - Math.PI / 2;

    return {
      key: `nail-${index}`,
      cx: 50 + Math.cos(angle) * nailOrbitRadius,
      cy: 50 + Math.sin(angle) * nailOrbitRadius,
      labelX: 50 + Math.cos(angle) * nailLabelRadius,
      labelY: 50 + Math.sin(angle) * nailLabelRadius,
      number: index + 1,
    };
  });

  const fromIndex = Number.parseInt(lineFrom, 10);
  const toIndex = Number.parseInt(lineTo, 10);
  const hasValidLine =
    Number.isInteger(fromIndex) &&
    Number.isInteger(toIndex) &&
    fromIndex >= 1 &&
    toIndex >= 1 &&
    fromIndex <= nailsCount &&
    toIndex <= nailsCount;
  const lineStart = hasValidLine ? nails[fromIndex - 1] : null;
  const lineEnd = hasValidLine ? nails[toIndex - 1] : null;
  const hasValidFromIndex =
    Number.isInteger(fromIndex) && fromIndex >= 1 && fromIndex <= nailsCount;
  const previewSize = previewRef.current?.clientWidth ?? 0;
  const imageData =
    imageCanvasRef.current && imageSize
      ? imageCanvasRef.current
          .getContext('2d', { willReadFrequently: true })
          ?.getImageData(0, 0, imageSize.width, imageSize.height).data ?? null
      : null;

  let linePixels = [];
  if (lineStart && lineEnd && imageSize && previewSize > 0) {
    const startPreviewX = (lineStart.cx / 100) * previewSize;
    const startPreviewY = (lineStart.cy / 100) * previewSize;
    const endPreviewX = (lineEnd.cx / 100) * previewSize;
    const endPreviewY = (lineEnd.cy / 100) * previewSize;
    const startImageX =
      (startPreviewX - previewSize / 2 - imageOffset.x) / scale +
      imageSize.width / 2;
    const startImageY =
      (startPreviewY - previewSize / 2 - imageOffset.y) / scale +
      imageSize.height / 2;
    const endImageX =
      (endPreviewX - previewSize / 2 - imageOffset.x) / scale +
      imageSize.width / 2;
    const endImageY =
      (endPreviewY - previewSize / 2 - imageOffset.y) / scale +
      imageSize.height / 2;

    linePixels = rasterizeLinePixels(
      startImageX,
      startImageY,
      endImageX,
      endImageY,
      imageSize.width,
      imageSize.height,
    );
  }

  let averageLineDarkness = null;
  if (linePixels.length > 0 && imageData && imageSize) {
    let darknessSum = 0;

    for (const pixel of linePixels) {
      darknessSum += getPixelDarkness(
        imageData,
        imageSize.width,
        pixel.x,
        pixel.y,
      );
    }

    averageLineDarkness = Math.round(darknessSum / linePixels.length);
  }

  let darknessSeries = [];
  if (hasValidFromIndex && imageSize && previewSize > 0 && imageData) {
    const originNail = nails[fromIndex - 1];
    const originPreviewX = (originNail.cx / 100) * previewSize;
    const originPreviewY = (originNail.cy / 100) * previewSize;
    const originImageX =
      (originPreviewX - previewSize / 2 - imageOffset.x) / scale +
      imageSize.width / 2;
    const originImageY =
      (originPreviewY - previewSize / 2 - imageOffset.y) / scale +
      imageSize.height / 2;

    darknessSeries = nails.map((targetNail) => {
      const targetPreviewX = (targetNail.cx / 100) * previewSize;
      const targetPreviewY = (targetNail.cy / 100) * previewSize;
      const targetImageX =
        (targetPreviewX - previewSize / 2 - imageOffset.x) / scale +
        imageSize.width / 2;
      const targetImageY =
        (targetPreviewY - previewSize / 2 - imageOffset.y) / scale +
        imageSize.height / 2;
      const pixels = rasterizeLinePixels(
        originImageX,
        originImageY,
        targetImageX,
        targetImageY,
        imageSize.width,
        imageSize.height,
      );

      let darknessSum = 0;
      for (const pixel of pixels) {
        darknessSum += getPixelDarkness(
          imageData,
          imageSize.width,
          pixel.x,
          pixel.y,
        );
      }

      return {
        nail: targetNail.number,
        darkness: pixels.length > 0 ? darknessSum / pixels.length : 0,
      };
    });
  }

  const graphWidth = 320;
  const graphHeight = 120;
  const graphPadding = { top: 8, right: 8, bottom: 22, left: 30 };
  const graphInnerWidth = graphWidth - graphPadding.left - graphPadding.right;
  const graphInnerHeight = graphHeight - graphPadding.top - graphPadding.bottom;
  const barWidth =
    darknessSeries.length > 0 ? graphInnerWidth / darknessSeries.length : 0;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <h1>Image Preview</h1>
        <label className="upload-field">
          <span>Choose image</span>
          <input
            type="file"
            accept="image/*"
            onChange={handleFileChange}
          />
        </label>

        <div className="panel">
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={cropToCircle}
              onChange={(event) => setCropToCircle(event.target.checked)}
            />
            <span>Crop to a circle</span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={isBlackAndWhite}
              onChange={(event) => setIsBlackAndWhite(event.target.checked)}
            />
            <span>B&amp;W</span>
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={showNailNumbers}
              onChange={(event) => setShowNailNumbers(event.target.checked)}
            />
            <span>Nails numbers</span>
          </label>

          <label className="slider-control">
            <span>Nails: {nailsCount}</span>
            <input
              type="range"
              min="0"
              max="300"
              step="1"
              value={nailsCount}
              onChange={(event) => {
                setNailsCount(clamp(Number(event.target.value), 0, 300));
              }}
            />
          </label>

          <div className="line-inputs">
            <label className="line-input">
              <span>From</span>
              <input
                type="range"
                min="1"
                max={Math.max(nailsCount, 1)}
                step="1"
                value={lineFrom === '' ? 1 : lineFrom}
                onChange={(event) => setLineFrom(event.target.value)}
              />
              <input
                type="number"
                min="1"
                max={Math.max(nailsCount, 1)}
                value={lineFrom}
                onChange={(event) => setLineFrom(event.target.value)}
              />
            </label>
            <label className="line-input">
              <span>To</span>
              <input
                type="range"
                min="1"
                max={Math.max(nailsCount, 1)}
                step="1"
                value={lineTo === '' ? 1 : lineTo}
                onChange={(event) => setLineTo(event.target.value)}
              />
              <input
                type="number"
                min="1"
                max={Math.max(nailsCount, 1)}
                value={lineTo}
                onChange={(event) => setLineTo(event.target.value)}
              />
            </label>
          </div>
          {averageLineDarkness !== null && (
            <p className="line-darkness">
              Average darkness: {averageLineDarkness}
            </p>
          )}
          {darknessSeries.length > 0 && (
            <div className="darkness-chart">
              <svg
                viewBox={`0 0 ${graphWidth} ${graphHeight}`}
                aria-label="Average darkness by target nail"
              >
                <line
                  className="chart-axis"
                  x1={graphPadding.left}
                  y1={graphPadding.top}
                  x2={graphPadding.left}
                  y2={graphHeight - graphPadding.bottom}
                />
                <line
                  className="chart-axis"
                  x1={graphPadding.left}
                  y1={graphHeight - graphPadding.bottom}
                  x2={graphWidth - graphPadding.right}
                  y2={graphHeight - graphPadding.bottom}
                />
                {darknessSeries.map((point, index) => {
                  const barHeight = (point.darkness / 255) * graphInnerHeight;
                  const x = graphPadding.left + index * barWidth;
                  const y =
                    graphHeight - graphPadding.bottom - barHeight;

                  return (
                    <rect
                      key={`bar-${point.nail}`}
                      className={`chart-bar ${point.nail === toIndex ? 'is-active' : ''}`}
                      x={x}
                      y={y}
                      width={Math.max(barWidth - 0.2, 0.4)}
                      height={barHeight}
                    />
                  );
                })}
                <text
                  className="chart-label"
                  x={graphPadding.left}
                  y={graphHeight - 4}
                >
                  1
                </text>
                <text
                  className="chart-label"
                  x={graphWidth - graphPadding.right}
                  y={graphHeight - 4}
                  textAnchor="end"
                >
                  {nailsCount}
                </text>
                <text
                  className="chart-label"
                  x={10}
                  y={graphPadding.top + 4}
                >
                  255
                </text>
                <text
                  className="chart-label"
                  x={14}
                  y={graphHeight - graphPadding.bottom}
                  dominantBaseline="ideographic"
                >
                  0
                </text>
              </svg>
            </div>
          )}
        </div>

        <div className="panel helper-text">
          <p>Drag inside the preview to reposition the image.</p>
          <p>Use the mouse wheel to zoom in or out.</p>
          <p>Hold Shift to move or resize the whole circle.</p>
          {imageName && <p>Loaded: {imageName}</p>}
          {imageSize && (
            <p>
              Original size: {imageSize.width} x {imageSize.height}
            </p>
          )}
        </div>
      </aside>

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
            onPointerUp={stopDragging}
            onPointerLeave={(event) => {
              stopDragging(event);
              setHoveredPixel(null);
            }}
            onPointerCancel={(event) => {
              stopDragging(event);
              setHoveredPixel(null);
            }}
            onWheel={handleWheel}
          >
            {imageUrl ? (
              <>
                <img
                  ref={imageRef}
                  className="preview-image"
                  src={imageUrl}
                  alt="Selected preview"
                  draggable="false"
                  style={imageStyle}
                />
                {linePixels.length > 0 && (
                  <svg
                    className="line-pixels-layer"
                    aria-hidden="true"
                    viewBox={`0 0 ${imageSize.width} ${imageSize.height}`}
                    style={{
                      width: `${imageSize.width}px`,
                      height: `${imageSize.height}px`,
                      transform: imageStyle.transform,
                    }}
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
                    {lineStart && lineEnd && (
                      <line
                        className="nail-line"
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
      {hoveredPixel && (
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
            {isBlackAndWhite
              ? `Darkness ${hoveredPixel.darkness}`
              : `RGB(${hoveredPixel.r}, ${hoveredPixel.g}, ${hoveredPixel.b})`}
          </div>
        </>
      )}
    </div>
  );
}

export default App;
