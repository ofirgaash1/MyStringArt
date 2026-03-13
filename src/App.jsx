import { useEffect, useRef, useState } from 'react';

const MIN_SCALE = 0.2;
const MAX_SCALE = 5;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function App() {
  const [imageUrl, setImageUrl] = useState('');
  const [imageName, setImageName] = useState('');
  const [imageSize, setImageSize] = useState(null);
  const [cropToCircle, setCropToCircle] = useState(true);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState(null);

  const previewRef = useRef(null);

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
    setOffset({ x: 0, y: 0 });

    const img = new Image();
    img.onload = () => {
      const previewSize = previewRef.current?.clientWidth ?? 420;
      const fittedScale = Math.max(
        previewSize / img.width,
        previewSize / img.height,
      );

      setImageSize({ width: img.width, height: img.height });
      setScale(clamp(fittedScale, MIN_SCALE, MAX_SCALE));
    };
    img.src = nextUrl;
  };

  const handlePointerDown = (event) => {
    if (!imageUrl) {
      return;
    }

    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    setIsDragging(true);
    setDragStart({
      x: event.clientX - offset.x,
      y: event.clientY - offset.y,
    });
  };

  const handlePointerMove = (event) => {
    if (!isDragging || !dragStart) {
      return;
    }

    setOffset({
      x: event.clientX - dragStart.x,
      y: event.clientY - dragStart.y,
    });
  };

  const stopDragging = (event) => {
    if (event?.currentTarget?.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setIsDragging(false);
    setDragStart(null);
  };

  const handleWheel = (event) => {
    if (!imageUrl) {
      return;
    }

    event.preventDefault();
    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect) {
      return;
    }

    const pointerX = event.clientX - rect.left - rect.width / 2;
    const pointerY = event.clientY - rect.top - rect.height / 2;
    const zoomFactor = event.deltaY < 0 ? 1.08 : 0.92;

    setScale((currentScale) => {
      const nextScale = clamp(currentScale * zoomFactor, MIN_SCALE, MAX_SCALE);
      const ratio = nextScale / currentScale;

      setOffset((currentOffset) => ({
        x: pointerX - (pointerX - currentOffset.x) * ratio,
        y: pointerY - (pointerY - currentOffset.y) * ratio,
      }));

      return nextScale;
    });
  };

  const imageStyle = {
    transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
    cursor: isDragging ? 'grabbing' : imageUrl ? 'grab' : 'default',
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
          <h2>Size Options</h2>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={cropToCircle}
              onChange={(event) => setCropToCircle(event.target.checked)}
            />
            <span>Crop to a circle</span>
          </label>
        </div>

        <div className="panel helper-text">
          <p>Drag inside the preview to reposition the image.</p>
          <p>Use the mouse wheel to zoom in or out.</p>
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
          ref={previewRef}
          className={`preview-frame ${cropToCircle ? 'is-circle' : ''}`}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={stopDragging}
          onPointerLeave={stopDragging}
          onPointerCancel={stopDragging}
          onWheel={handleWheel}
        >
          {imageUrl ? (
            <img
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
      </main>
    </div>
  );
}

export default App;
