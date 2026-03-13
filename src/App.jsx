import { useEffect, useRef, useState } from 'react';

const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
const MIN_PREVIEW_SCALE = 50;
const MAX_PREVIEW_SCALE = 1000;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function App() {
  const [imageUrl, setImageUrl] = useState('');
  const [imageName, setImageName] = useState('');
  const [imageSize, setImageSize] = useState(null);
  const [cropToCircle, setCropToCircle] = useState(true);
  const [isBlackAndWhite, setIsBlackAndWhite] = useState(false);
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

  const handlePreviewScaleChange = (value, shouldClampToSlider = false) => {
    const numericValue = Number.parseInt(value, 10);
    if (Number.isNaN(numericValue)) {
      return;
    }

    setPreviewScale(
      shouldClampToSlider
        ? clamp(numericValue, MIN_PREVIEW_SCALE, MAX_PREVIEW_SCALE)
        : Math.max(numericValue, MIN_PREVIEW_SCALE),
    );
  };

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

          <label className="scale-control">
            <span>Circle size</span>
            <input
              type="range"
              min={MIN_PREVIEW_SCALE}
              max={MAX_PREVIEW_SCALE}
              value={clamp(previewScale, MIN_PREVIEW_SCALE, MAX_PREVIEW_SCALE)}
              onChange={(event) => handlePreviewScaleChange(event.target.value, true)}
            />
            <div className="percent-input-row">
              <input
                type="number"
                min={MIN_PREVIEW_SCALE}
                value={previewScale}
                onChange={(event) => handlePreviewScaleChange(event.target.value)}
              />
              <span>%</span>
            </div>
          </label>
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
              <img
                ref={imageRef}
                className="preview-image"
                src={imageUrl}
                alt="Selected preview"
                draggable="false"
                style={imageStyle}
              />
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
            RGB({hoveredPixel.r}, {hoveredPixel.g}, {hoveredPixel.b})
          </div>
        </>
      )}
    </div>
  );
}

export default App;
