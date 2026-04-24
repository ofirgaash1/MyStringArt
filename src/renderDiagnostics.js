import { useEffect, useRef } from 'react';

function describeValue(value) {
  if (Array.isArray(value)) {
    return `array(${value.length})`;
  }

  if (value instanceof ImageData) {
    return `image(${value.width}x${value.height})`;
  }

  if (value && typeof value === 'object') {
    return 'object';
  }

  return String(value);
}

export function useRenderDiagnostics(componentName, trackedValues, onDiagnosticRender) {
  const previousValuesRef = useRef(null);

  useEffect(() => {
    const previousValues = previousValuesRef.current;
    const changedKeys = [];

    if (previousValues) {
      for (const [key, value] of Object.entries(trackedValues)) {
        if (!Object.is(previousValues[key], value)) {
          changedKeys.push({
            key,
            previous: describeValue(previousValues[key]),
            next: describeValue(value),
          });
        }
      }
    }

    onDiagnosticRender?.(componentName, changedKeys);
    previousValuesRef.current = trackedValues;
  });
}
