import { useMemo, useState } from 'react';
import {
  clonePalettePreset,
  MULTICOLOR_PALETTE_PRESETS,
} from '../multicolor';
import { useRenderDiagnostics } from '../renderDiagnostics';

function planSameColorChain(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      orderedRows: [],
      continuousTransitions: 0,
      connectorTransitions: 0,
    };
  }

  const remainingRows = rows.map((row) => ({ ...row }));
  const firstRow = remainingRows.shift();
  const orderedRows = [{
    ...firstRow,
    chainFromNailNumber: firstRow.startNailNumber,
    chainToNailNumber: firstRow.endNailNumber,
    needsConnector: false,
  }];
  let currentNailNumber = firstRow.endNailNumber;
  let continuousTransitions = 0;
  let connectorTransitions = 0;

  while (remainingRows.length > 0) {
    let nextIndex = remainingRows.findIndex(
      (row) =>
        row.startNailNumber === currentNailNumber ||
        row.endNailNumber === currentNailNumber,
    );
    let needsConnector = false;

    if (nextIndex < 0) {
      nextIndex = 0;
      needsConnector = true;
      connectorTransitions += 1;
    } else {
      continuousTransitions += 1;
    }

    const [nextRow] = remainingRows.splice(nextIndex, 1);
    const shouldFlip = nextRow.endNailNumber === currentNailNumber;
    const chainFromNailNumber = shouldFlip ? nextRow.endNailNumber : nextRow.startNailNumber;
    const chainToNailNumber = shouldFlip ? nextRow.startNailNumber : nextRow.endNailNumber;
    orderedRows.push({
      ...nextRow,
      chainFromNailNumber,
      chainToNailNumber,
      needsConnector,
    });
    currentNailNumber = chainToNailNumber;
  }

  return {
    orderedRows,
    continuousTransitions,
    connectorTransitions,
  };
}

function getChordEndpointKey(firstNailNumber, secondNailNumber) {
  return firstNailNumber < secondNailNumber
    ? `${firstNailNumber}-${secondNailNumber}`
    : `${secondNailNumber}-${firstNailNumber}`;
}

function getTasLimitCountForPercentage(totalCount, limitPercent) {
  if (totalCount <= 0 || limitPercent <= 0) {
    return 0;
  }

  return Math.min(totalCount, Math.max(1, Math.round((totalCount * limitPercent) / 100)));
}

function getActiveChordKeysByRegionLimit(rows, limitPercent) {
  const activeChordKeys = new Set();
  if (!Array.isArray(rows) || rows.length === 0) {
    return activeChordKeys;
  }

  const rowsByRegion = new Map();
  for (const row of rows) {
    const regionRows = rowsByRegion.get(row.regionIndex) ?? [];
    regionRows.push(row);
    rowsByRegion.set(row.regionIndex, regionRows);
  }

  for (const regionRows of rowsByRegion.values()) {
    const regionLimit = getTasLimitCountForPercentage(regionRows.length, limitPercent);
    for (const row of regionRows.slice(-regionLimit)) {
      activeChordKeys.add(row.chordKey);
    }
  }

  return activeChordKeys;
}

function getActiveRowsByRegionOrder(rows, limitPercent) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  if (!Number.isFinite(limitPercent) || limitPercent <= 0) {
    return [];
  }

  const rowsByRegion = new Map();
  for (const row of rows) {
    const regionRows = rowsByRegion.get(row.regionIndex) ?? [];
    regionRows.push(row);
    rowsByRegion.set(row.regionIndex, regionRows);
  }

  return [...rowsByRegion.entries()]
    .sort(([firstRegion], [secondRegion]) => firstRegion - secondRegion)
    .flatMap(([, regionRows]) => {
      const regionLimit = getTasLimitCountForPercentage(regionRows.length, limitPercent);
      return regionRows.slice(-regionLimit);
    });
}

function getConnectorSearchSummary({
  allRows,
  activeChordKeys,
  colorId,
  fromNailNumber,
  toNailNumber,
  sourceRegionIndex,
}) {
  if (
    !Array.isArray(allRows) ||
    allRows.length === 0 ||
    !colorId ||
    !Number.isInteger(fromNailNumber) ||
    !Number.isInteger(toNailNumber)
  ) {
    return null;
  }

  const sameColorRows = allRows.filter(
    (row) =>
      row.assignedColorId === colorId &&
      row.regionIndex > sourceRegionIndex &&
      activeChordKeys.has(row.chordKey),
  );
  const rowsByNailNumber = new Map();
  for (const row of sameColorRows) {
    for (const nailNumber of [row.startNailNumber, row.endNailNumber]) {
      const nailRows = rowsByNailNumber.get(nailNumber) ?? [];
      nailRows.push(row);
      rowsByNailNumber.set(nailNumber, nailRows);
    }
  }

  const pathCandidates = [];
  let frontier = [{
    currentNailNumber: fromNailNumber,
    nailPath: [fromNailNumber],
    legs: [],
    usedChordKeys: new Set(),
  }];

  while (frontier.length > 0 && pathCandidates.length === 0) {
    const nextFrontier = [];
    for (const state of frontier) {
      const nextRows = rowsByNailNumber.get(state.currentNailNumber) ?? [];
      for (const row of nextRows) {
        if (state.usedChordKeys.has(row.chordKey)) {
          continue;
        }

        const nextNailNumber =
          row.startNailNumber === state.currentNailNumber
            ? row.endNailNumber
            : row.startNailNumber;
        if (state.nailPath.includes(nextNailNumber) && nextNailNumber !== toNailNumber) {
          continue;
        }

        const nextLegs = [...state.legs, row];
        const nextNailPath = [...state.nailPath, nextNailNumber];
        const nextUsedChordKeys = new Set(state.usedChordKeys);
        nextUsedChordKeys.add(row.chordKey);

        if (nextNailNumber === toNailNumber) {
          const totalError = nextLegs.reduce(
            (sum, leg) => sum + (Number.isFinite(leg.error) ? leg.error : Infinity),
            0,
          );
          const totalLength = nextLegs.reduce(
            (sum, leg) => sum + (Number.isFinite(leg.chordLength) ? leg.chordLength : 0),
            0,
          );
          const totalDamage = nextLegs.reduce(
            (sum, leg) => sum + getConnectorLegDamage(leg),
            0,
          );
          pathCandidates.push({
            key: nextLegs.map((leg) => leg.chordKey).join('+'),
            legs: nextLegs,
            nailPath: nextNailPath,
            regionPath: nextLegs.map((leg) => leg.regionIndex),
            minRegionIndex: Math.min(...nextLegs.map((leg) => leg.regionIndex)),
            totalError,
            totalLength,
            totalDamage,
            maxRegionIndex: Math.max(...nextLegs.map((leg) => leg.regionIndex)),
          });
        } else {
          nextFrontier.push({
            currentNailNumber: nextNailNumber,
            nailPath: nextNailPath,
            legs: nextLegs,
            usedChordKeys: nextUsedChordKeys,
          });
        }
      }
    }

    frontier = nextFrontier;
  }

  pathCandidates.sort((firstCandidate, secondCandidate) => {
    if (firstCandidate.totalDamage !== secondCandidate.totalDamage) {
      return firstCandidate.totalDamage - secondCandidate.totalDamage;
    }

    if (firstCandidate.totalError !== secondCandidate.totalError) {
      return firstCandidate.totalError - secondCandidate.totalError;
    }

    if (firstCandidate.totalLength !== secondCandidate.totalLength) {
      return firstCandidate.totalLength - secondCandidate.totalLength;
    }

    return firstCandidate.maxRegionIndex - secondCandidate.maxRegionIndex;
  });

  const decoratedCandidates = pathCandidates.map((candidate) => ({
    ...candidate,
    outerSpan: Math.max(0, candidate.maxRegionIndex - sourceRegionIndex),
  }));
  const nearestOuterSpan = decoratedCandidates.reduce(
    (best, candidate) => Math.min(best, candidate.outerSpan),
    Infinity,
  );

  return {
    fromNailNumber,
    sourceRegionIndex,
    toNailNumber,
    direct:
      decoratedCandidates
        .map((candidate) => ({
          ...candidate,
          isClosestOuterCandidate: candidate.outerSpan === nearestOuterSpan,
        }))
        .find((candidate) => candidate.legs.length === 1) ?? null,
    pathCandidates: decoratedCandidates
      .map((candidate) => ({
        ...candidate,
        isClosestOuterCandidate: candidate.outerSpan === nearestOuterSpan,
      }))
      .filter((candidate) => candidate.legs.length > 1)
      .slice(0, 5),
  };
}

function getPreviewChordKeys(...chordKeyGroups) {
  return [...new Set(chordKeyGroups.flat().filter(Boolean))];
}

function getConnectorLegDamage(leg) {
  if (!leg) {
    return Infinity;
  }

  const error = Number.isFinite(leg.error) ? leg.error : Infinity;
  const chordLength = Number.isFinite(leg.chordLength) ? leg.chordLength : Infinity;
  return error * chordLength;
}

function sortRowsForGlobalWinding(rows) {
  return [...rows].sort((firstRow, secondRow) => {
    if (firstRow.regionIndex !== secondRow.regionIndex) {
      return firstRow.regionIndex - secondRow.regionIndex;
    }

    const firstError = Number.isFinite(firstRow.error) ? firstRow.error : -Infinity;
    const secondError = Number.isFinite(secondRow.error) ? secondRow.error : -Infinity;
    if (secondError !== firstError) {
      return secondError - firstError;
    }

    return firstRow.chordKey.localeCompare(secondRow.chordKey);
  });
}

function buildGlobalWindingPreview(rows, paletteColors) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      steps: [],
      totalStepCount: 0,
      perColorCounts: [],
    };
  }

  const paletteById = new Map(
    (Array.isArray(paletteColors) ? paletteColors : []).map((color) => [color.id, color]),
  );
  const rowsByColorId = new Map();

  for (const row of rows) {
    if (!row.assignedColorId) {
      continue;
    }

    const colorRows = rowsByColorId.get(row.assignedColorId) ?? [];
    colorRows.push(row);
    rowsByColorId.set(row.assignedColorId, colorRows);
  }

  const queues = [...rowsByColorId.entries()].map(([colorId, colorRows]) => {
    const paletteColor = paletteById.get(colorId);
    return {
      colorId,
      colorLabel: paletteColor?.label ?? colorId,
      colorHex: paletteColor?.hex ?? colorRows[0]?.assignedColorHex ?? '#0f172a',
      rows: sortRowsForGlobalWinding(colorRows),
      index: 0,
    };
  }).filter((queue) => queue.rows.length > 0);

  const perColorCounts = queues.map((queue) => ({
    colorId: queue.colorId,
    colorLabel: queue.colorLabel,
    colorHex: queue.colorHex,
    count: queue.rows.length,
  })).sort((firstColor, secondColor) => secondColor.count - firstColor.count);

  const totalStepCount = queues.reduce((sum, queue) => sum + queue.rows.length, 0);
  const steps = [];

  while (steps.length < totalStepCount) {
    const candidates = queues
      .filter((queue) => queue.index < queue.rows.length)
      .map((queue) => ({
        queue,
        row: queue.rows[queue.index],
      }));

    if (candidates.length === 0) {
      break;
    }

    const innermostRegion = candidates.reduce(
      (minRegion, candidate) => Math.min(minRegion, candidate.row.regionIndex),
      Infinity,
    );
    const chosenCandidate = candidates
      .filter((candidate) => candidate.row.regionIndex === innermostRegion)
      .sort((firstCandidate, secondCandidate) => {
        const firstError = Number.isFinite(firstCandidate.row.error) ? firstCandidate.row.error : -Infinity;
        const secondError = Number.isFinite(secondCandidate.row.error) ? secondCandidate.row.error : -Infinity;
        if (secondError !== firstError) {
          return secondError - firstError;
        }

        if (firstCandidate.queue.colorLabel !== secondCandidate.queue.colorLabel) {
          return firstCandidate.queue.colorLabel.localeCompare(secondCandidate.queue.colorLabel);
        }

        return firstCandidate.row.chordKey.localeCompare(secondCandidate.row.chordKey);
      })[0];

    steps.push({
      stepNumber: steps.length + 1,
      colorId: chosenCandidate.queue.colorId,
      colorLabel: chosenCandidate.queue.colorLabel,
      colorHex: chosenCandidate.queue.colorHex,
      remainingInColor: chosenCandidate.queue.rows.length - chosenCandidate.queue.index - 1,
      ...chosenCandidate.row,
    });
    chosenCandidate.queue.index += 1;
  }

  return {
    steps,
    totalStepCount,
    perColorCounts,
  };
}

function MulticolorLab({
  activePaletteColor,
  activePaletteColorId,
  activeLimitedTasCount,
  allTasPaletteFit,
  ditheredComparisonCanvasRef,
  hasOriginalImage,
  isBlackAndWhite,
  isMulticolorLabEnabled,
  isPaletteDitheringEnabled,
  isPalettePreviewEnabled,
  isTasOwnershipPreviewEnabled,
  isTasPaletteFitPreviewEnabled,
  isTasPaletteFitLimitedToPalette,
  isTasPreviewEnabled,
  isSelectedTasRegionEnabled,
  isTasSameColorFocusEnabled,
  disabledTasRegionCount,
  maxEnabledTasRegionIndex,
  multicolorPaletteColors,
  multicolorPaletteCoverage,
  multicolorPaletteCoverageWithLineAllocation,
  multicolorPaletteCoverageWithSuggestions,
  multicolorLockedLineOverride,
  multicolorPalettePixelCountMap,
  multicolorPalettePreset,
  multicolorTargetTotalLines,
  normalizedSelectedTasRegionIndex,
  originalComparisonCanvasRef,
  onDiagnosticRender,
  paletteComparisonCanvasRef,
  setActivePaletteColorId,
  setIsBlackAndWhite,
  setIsMulticolorLabEnabled,
  setIsPaletteDitheringEnabled,
  setIsPalettePreviewEnabled,
  setIsTasOwnershipPreviewEnabled,
  setIsTasPaletteFitLimitedToPalette,
  setIsTasPaletteFitPreviewEnabled,
  setIsTasPreviewEnabled,
  setIsTasSameColorFocusEnabled,
  setMulticolorLockedLineOverride,
  setMulticolorPaletteColors,
  setMulticolorPalettePresetId,
  setMulticolorTargetTotalLines,
  setSelectedTasRegionIndex,
  setSelectedTasChordKey,
  setSelectedChainChordKeys,
  setSelectedConnectorGapChordKey,
  setSelectedConnectorChordKeys,
  setTasRegionChordLimitPercent,
  selectedTasRegion,
  selectedTasChordKey,
  selectedConnectorGapChordKey,
  selectedConnectorChordKeys,
  shouldShowPaletteComparison,
  tasRegionChordLimitPercent,
  tasOwnershipPreview,
  tasPaletteFit,
  tasNetwork,
  tasMinDistance,
  tasViewScope,
  totalAllocatedSuggestedLines,
  totalPaletteCoverageTenths,
  setTasViewScope,
}) {
  const [scclScope, setScclScope] = useState('global');
  const suggestedLinesByColorId = useMemo(
    () => new Map(
      multicolorPaletteCoverageWithSuggestions.map((color) => [color.id, color.allocatedUnits]),
    ),
    [multicolorPaletteCoverageWithSuggestions],
  );
  const sourceLabel = isPaletteDitheringEnabled ? 'dithered' : 'nearest';
  const hasSuggestedLineTarget = multicolorTargetTotalLines > 0;
  const effectiveScclScope =
    scclScope === 'global' && allTasPaletteFit ? 'global' : 'selected-region';
  const selectedRegionTasRows = tasPaletteFit?.sortedRows ?? [];
  const highErrorTasRows = selectedRegionTasRows.slice(0, 8);
  const lowErrorTasRows = selectedRegionTasRows.length > 8
    ? selectedRegionTasRows.slice(-4).reverse()
    : [];
  const selectedRegionChordCount = isSelectedTasRegionEnabled
    ? selectedRegionTasRows.length || selectedTasRegion?.chordCount || 0
    : 0;
  const normalizedTasRegionChordLimitPercent = Math.min(
    100,
    Math.max(0, Number.isFinite(tasRegionChordLimitPercent) ? tasRegionChordLimitPercent : 0),
  );
  const selectedRegionActiveChordCount = selectedRegionChordCount > 0 && normalizedTasRegionChordLimitPercent > 0
    ? Math.min(
        selectedRegionChordCount,
        Math.max(1, Math.round((selectedRegionChordCount * normalizedTasRegionChordLimitPercent) / 100)),
      )
    : 0;
  const selectedRegionActiveFitRowCount = selectedRegionTasRows.length > 0 && normalizedTasRegionChordLimitPercent > 0
    ? Math.min(
        selectedRegionTasRows.length,
        Math.max(1, Math.round((selectedRegionTasRows.length * normalizedTasRegionChordLimitPercent) / 100)),
      )
    : 0;
  const activeSelectedRegionTasChordKeys = useMemo(
    () => new Set(
      selectedRegionActiveFitRowCount > 0
        ? selectedRegionTasRows
            .slice(-selectedRegionActiveFitRowCount)
            .map((row) => row.chordKey)
        : [],
    ),
    [selectedRegionActiveFitRowCount, selectedRegionTasRows],
  );
  const allActiveTasChordKeys = useMemo(
    () =>
      getActiveChordKeysByRegionLimit(
        allTasPaletteFit?.sortedRows ?? [],
        normalizedTasRegionChordLimitPercent,
      ),
    [allTasPaletteFit, normalizedTasRegionChordLimitPercent],
  );
  const activeGlobalTasRows = useMemo(
    () =>
      getActiveRowsByRegionOrder(
        allTasPaletteFit?.sortedRows ?? [],
        normalizedTasRegionChordLimitPercent,
      ),
    [allTasPaletteFit, normalizedTasRegionChordLimitPercent],
  );
  const selectedTasRow = selectedTasChordKey
    ? selectedRegionTasRows.find((row) => row.chordKey === selectedTasChordKey) ?? null
    : null;
  const activeScclRows = useMemo(
    () =>
      effectiveScclScope === 'selected-region'
        ? selectedRegionTasRows.filter((row) => activeSelectedRegionTasChordKeys.has(row.chordKey))
        : activeGlobalTasRows,
    [
      activeGlobalTasRows,
      activeSelectedRegionTasChordKeys,
      effectiveScclScope,
      selectedRegionTasRows,
    ],
  );
  const activeSameColorChordLists = useMemo(
    () =>
      multicolorPaletteColors
        .map((color) => {
          const rows = activeScclRows.filter(
            (row) =>
              row.assignedColorId === color.id,
          );
          return {
            ...color,
            rows,
            chordCount: rows.length,
          };
        })
        .filter((color) => color.chordCount > 0),
    [activeScclRows, multicolorPaletteColors],
  );
  const activeColorSameColorList = activeSameColorChordLists.find(
    (color) => color.id === activePaletteColorId,
  ) ?? null;
  const activeColorChainPlan = useMemo(
    () => planSameColorChain(activeColorSameColorList?.rows ?? []),
    [activeColorSameColorList],
  );
  const selectedConnectorGap = useMemo(() => {
    let gapIndex = activeColorChainPlan.orderedRows.findIndex(
      (row) => row.chordKey === selectedConnectorGapChordKey && row.needsConnector,
    );
    if (gapIndex <= 0) {
      gapIndex = activeColorChainPlan.orderedRows.findIndex((row) => row.needsConnector);
    }
    if (gapIndex <= 0) {
      return null;
    }

    const previousRow = activeColorChainPlan.orderedRows[gapIndex - 1];
    const nextRow = activeColorChainPlan.orderedRows[gapIndex];
    return {
      index: gapIndex,
      previousRow,
      nextRow,
      fromNailNumber: previousRow.chainToNailNumber,
      toNailNumber: nextRow.chainFromNailNumber,
    };
  }, [activeColorChainPlan, selectedConnectorGapChordKey]);
  const connectorSearchSummary = useMemo(
    () =>
      selectedConnectorGap
        ? getConnectorSearchSummary({
            allRows: allTasPaletteFit?.sortedRows ?? [],
            activeChordKeys: allActiveTasChordKeys,
            colorId: activePaletteColorId,
            fromNailNumber: selectedConnectorGap.fromNailNumber,
            toNailNumber: selectedConnectorGap.toNailNumber,
            sourceRegionIndex: selectedConnectorGap.nextRow.regionIndex,
          })
        : null,
    [
      activePaletteColorId,
      allActiveTasChordKeys,
      allTasPaletteFit,
      selectedConnectorGap,
    ],
  );
  const globalWindingPreview = useMemo(
    () =>
      buildGlobalWindingPreview(
        activeGlobalTasRows,
        multicolorPaletteColors,
      ),
    [activeGlobalTasRows, multicolorPaletteColors],
  );

  useRenderDiagnostics(
    'MulticolorLab',
    {
      activePaletteColorId,
      isPalettePreviewEnabled,
      paletteCoverageCount: multicolorPaletteCoverage.length,
      tasPreviewEnabled: isTasPreviewEnabled,
      tasRegionCount: tasNetwork.regionCount,
    },
    onDiagnosticRender,
  );

  return (
    <div className="multicolor-lab">
      <div className="multicolor-lab-header">
        <h2>Multicolor lab</h2>
        <p>Palette setup, TAS inspection, and region planning.</p>
      </div>
      <label className="checkbox-row multicolor-lab-toggle-row">
        <input
          type="checkbox"
          checked={isMulticolorLabEnabled}
          onChange={(event) => setIsMulticolorLabEnabled(event.target.checked)}
        />
        <span>Enable multicolor lab</span>
      </label>
      {isMulticolorLabEnabled && (
        <div className="multicolor-lab-body">
          <div className="multicolor-status-strip">
            <span className="multicolor-status-chip">
              Active: {activePaletteColor?.label ?? 'none'}
            </span>
            <span className="multicolor-status-chip">Source: {sourceLabel}</span>
            <span className="multicolor-status-chip">
              TAS regions: {tasNetwork.regionCount.toLocaleString()}
            </span>
          </div>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>Palette</h3>
              <p>Choose the working colors for TAS assignment.</p>
            </div>
            <div className="multicolor-lab-section-card">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isBlackAndWhite}
                  onChange={(event) => setIsBlackAndWhite(event.target.checked)}
                />
                <span>Show grayscale</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isPalettePreviewEnabled}
                  onChange={(event) => setIsPalettePreviewEnabled(event.target.checked)}
                />
                <span>Enable palette preview</span>
              </label>
              <div
                className="multicolor-debug-toggle-group"
                role="radiogroup"
                aria-label="Multicolor palette preset"
              >
                {MULTICOLOR_PALETTE_PRESETS.map((preset) => {
                  const isActive = multicolorPalettePreset.id === preset.id;
                  return (
                    <button
                      key={preset.id}
                      className={[
                        'multicolor-debug-toggle',
                        isActive ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      role="radio"
                      aria-checked={isActive}
                      onClick={() => {
                        setMulticolorPalettePresetId(preset.id);
                        setMulticolorPaletteColors(clonePalettePreset(preset).colors);
                        setActivePaletteColorId(preset.colors[0]?.id ?? null);
                      }}
                    >
                      {preset.name}
                    </button>
                  );
                })}
              </div>
              <div className="multicolor-palette-list">
                {multicolorPaletteColors.map((color) => (
                  <div
                    key={color.id}
                    className={[
                      'multicolor-palette-row',
                      color.enabled ? '' : 'is-disabled',
                      color.id === activePaletteColorId ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                  >
                    <input
                      type="checkbox"
                      checked={color.enabled}
                      onChange={(event) => {
                        setMulticolorPaletteColors((currentColors) =>
                          currentColors.map((currentColor) =>
                            currentColor.id === color.id
                              ? { ...currentColor, enabled: event.target.checked }
                              : currentColor,
                          ),
                        );
                      }}
                    />
                    <button
                      className={[
                        'multicolor-palette-swatch-button',
                        color.id === activePaletteColorId ? 'is-active' : '',
                      ].filter(Boolean).join(' ')}
                      type="button"
                      onClick={() => setActivePaletteColorId(color.id)}
                      aria-label={`Set active palette color ${color.label}`}
                      title={`Active color: ${color.label}`}
                    >
                      <span
                        className="multicolor-palette-swatch"
                        style={{ backgroundColor: color.hex }}
                      />
                    </button>
                    <span className="multicolor-palette-name">{color.label}</span>
                    <span className="multicolor-palette-count-value">
                      {hasOriginalImage
                        ? `${(multicolorPalettePixelCountMap.get(color.id) ?? 0).toLocaleString()} px`
                        : '-'}
                    </span>
                  </div>
                ))}
              </div>
              <div className="multicolor-inline-controls">
                <span className="multicolor-lab-label">Palette source</span>
                <div
                  className="multicolor-debug-toggle-group"
                  role="radiogroup"
                  aria-label="Palette source"
                >
                  <button
                    className={[
                      'multicolor-debug-toggle',
                      !isPaletteDitheringEnabled ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                    type="button"
                    role="radio"
                    aria-checked={!isPaletteDitheringEnabled}
                    onClick={() => setIsPaletteDitheringEnabled(false)}
                    disabled={!isPalettePreviewEnabled}
                  >
                    nearest
                  </button>
                  <button
                    className={[
                      'multicolor-debug-toggle',
                      isPaletteDitheringEnabled ? 'is-active' : '',
                    ].filter(Boolean).join(' ')}
                    type="button"
                    role="radio"
                    aria-checked={isPaletteDitheringEnabled}
                    onClick={() => setIsPaletteDitheringEnabled(true)}
                    disabled={!isPalettePreviewEnabled}
                  >
                    dithered
                  </button>
                </div>
                <p className="multicolor-mini-note">
                  This affects palette preview and coverage. TAS coloring will use the same source.
                </p>
              </div>
            </div>
          </section>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>Inspect</h3>
              <p>Review palette reduction and coverage before TAS color fitting.</p>
            </div>
            <div className="multicolor-lab-section-card">
              {shouldShowPaletteComparison && (
                <div className="multicolor-inspect-block">
                  <span className="multicolor-lab-label">Preview comparison</span>
                  <div className="multicolor-comparison-grid">
                    <figure className="multicolor-comparison-card">
                      <figcaption>Original</figcaption>
                      <canvas
                        ref={originalComparisonCanvasRef}
                        className="multicolor-comparison-canvas"
                      />
                    </figure>
                    <figure className="multicolor-comparison-card">
                      <figcaption>Nearest</figcaption>
                      <canvas
                        ref={paletteComparisonCanvasRef}
                        className="multicolor-comparison-canvas"
                      />
                    </figure>
                    {isPaletteDitheringEnabled && (
                      <figure className="multicolor-comparison-card">
                        <figcaption>Dithered</figcaption>
                        <canvas
                          ref={ditheredComparisonCanvasRef}
                          className="multicolor-comparison-canvas"
                        />
                      </figure>
                    )}
                  </div>
                </div>
              )}

              <div className="multicolor-inspect-block">
                <span className="multicolor-lab-label">Coverage</span>
                <label className="multicolor-histogram-input">
                  <span>Target total lines</span>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={multicolorTargetTotalLines}
                    onChange={(event) => {
                      const parsedValue = Number.parseInt(event.target.value, 10);
                      setMulticolorTargetTotalLines(
                        Number.isFinite(parsedValue) ? Math.max(0, parsedValue) : 0,
                      );
                    }}
                  />
                </label>
                {multicolorPaletteCoverage.length > 0 ? (
                  <div className="multicolor-histogram-list">
                    {multicolorPaletteCoverageWithLineAllocation.map((color) => (
                      <div
                        key={color.id}
                        className="multicolor-histogram-row"
                      >
                        <div className="multicolor-histogram-meta">
                          <span
                            className="multicolor-palette-swatch"
                            style={{ backgroundColor: color.hex }}
                          />
                          <span className="multicolor-histogram-name">{color.label}</span>
                          <span className="multicolor-histogram-value">
                            {color.percentageLabel}
                          </span>
                          {hasSuggestedLineTarget && (
                            <span className="multicolor-histogram-lines">
                              {color.allocatedUnits.toLocaleString()} lines
                            </span>
                          )}
                        </div>
                        <div className="multicolor-histogram-bar-track">
                          <div
                            className="multicolor-histogram-bar-fill"
                            style={{
                              width: `${color.percentage}%`,
                              backgroundColor: color.hex,
                            }}
                          />
                        </div>
                        {hasSuggestedLineTarget && (
                          <div className="multicolor-histogram-controls">
                            <label className="checkbox-row">
                              <input
                                type="checkbox"
                                checked={multicolorLockedLineOverride?.colorId === color.id}
                                onChange={(event) => {
                                  if (!event.target.checked) {
                                    setMulticolorLockedLineOverride((currentOverride) =>
                                      currentOverride?.colorId === color.id ? null : currentOverride,
                                    );
                                    return;
                                  }

                                  setMulticolorLockedLineOverride({
                                    colorId: color.id,
                                    lineCount: suggestedLinesByColorId.get(color.id) ?? 0,
                                  });
                                }}
                              />
                              <span>Lock</span>
                            </label>
                            <label className="multicolor-histogram-input">
                              <span>Manual</span>
                              <input
                                type="number"
                                min="0"
                                max={multicolorTargetTotalLines}
                                step="1"
                                value={
                                  multicolorLockedLineOverride?.colorId === color.id
                                    ? multicolorLockedLineOverride.lineCount
                                    : suggestedLinesByColorId.get(color.id) ?? 0
                                }
                                onChange={(event) => {
                                  const parsedValue = Number.parseInt(event.target.value, 10);
                                  setMulticolorLockedLineOverride({
                                    colorId: color.id,
                                    lineCount: Number.isFinite(parsedValue) ? parsedValue : 0,
                                  });
                                }}
                                disabled={multicolorLockedLineOverride?.colorId !== color.id}
                              />
                            </label>
                            <span className="multicolor-histogram-auto-lines">
                              Auto {(suggestedLinesByColorId.get(color.id) ?? 0).toLocaleString()}
                            </span>
                          </div>
                        )}
                      </div>
                    ))}
                    <div className="multicolor-inline-stats">
                      <span className="multicolor-inline-stat">
                        Total {(totalPaletteCoverageTenths / 10).toFixed(1)}%
                      </span>
                      {hasSuggestedLineTarget && (
                        <span className="multicolor-inline-stat">
                          Split {totalAllocatedSuggestedLines.toLocaleString()} /{' '}
                          {multicolorTargetTotalLines.toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                ) : (
                  <p className="multicolor-mini-note">
                    Load an image and enable at least one color to see the split.
                  </p>
                )}
              </div>
            </div>
          </section>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>TAS regions</h3>
              <p>Inspect the chord inventory from the new region model.</p>
            </div>
            <div className="multicolor-lab-section-card">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isTasPreviewEnabled}
                  onChange={(event) => setIsTasPreviewEnabled(event.target.checked)}
                  disabled={tasNetwork.regionCount === 0}
                />
                <span>Show TAS lines</span>
              </label>
              <div
                className="multicolor-debug-toggle-group"
                role="radiogroup"
                aria-label="TAS view scope"
              >
                <button
                  className={[
                    'multicolor-debug-toggle',
                    tasViewScope === 'selected' ? 'is-active' : '',
                  ].filter(Boolean).join(' ')}
                  type="button"
                  role="radio"
                  aria-checked={tasViewScope === 'selected'}
                  onClick={() => setTasViewScope('selected')}
                >
                  view selected TAS
                </button>
                <button
                  className={[
                    'multicolor-debug-toggle',
                    tasViewScope === 'all' ? 'is-active' : '',
                  ].filter(Boolean).join(' ')}
                  type="button"
                  role="radio"
                  aria-checked={tasViewScope === 'all'}
                  onClick={() => setTasViewScope('all')}
                >
                  view all TAS
                </button>
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isTasOwnershipPreviewEnabled}
                  onChange={(event) => setIsTasOwnershipPreviewEnabled(event.target.checked)}
                  disabled={tasNetwork.regionCount === 0 || !hasOriginalImage}
                />
                <span>Show selected TAS pixel ownership</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isTasPaletteFitPreviewEnabled}
                  onChange={(event) => setIsTasPaletteFitPreviewEnabled(event.target.checked)}
                  disabled={tasNetwork.regionCount === 0 || !hasOriginalImage}
                />
                <span>Show TAS palette fit</span>
              </label>
              <div
                className="multicolor-debug-toggle-group"
                role="radiogroup"
                aria-label="TAS palette fit mode"
              >
                <button
                  className={[
                    'multicolor-debug-toggle',
                    isTasPaletteFitLimitedToPalette ? 'is-active' : '',
                  ].filter(Boolean).join(' ')}
                  type="button"
                  role="radio"
                  aria-checked={isTasPaletteFitLimitedToPalette}
                  onClick={() => setIsTasPaletteFitLimitedToPalette(true)}
                >
                  fit to palette colors
                </button>
                <button
                  className={[
                    'multicolor-debug-toggle',
                    !isTasPaletteFitLimitedToPalette ? 'is-active' : '',
                  ].filter(Boolean).join(' ')}
                  type="button"
                  role="radio"
                  aria-checked={!isTasPaletteFitLimitedToPalette}
                  onClick={() => setIsTasPaletteFitLimitedToPalette(false)}
                >
                  fit to closest color
                </button>
              </div>
              <label className="slider-control">
                <span>
                  Region D{normalizedSelectedTasRegionIndex}
                  {selectedTasRegion
                    ? ` (${selectedTasRegion.chordCount.toLocaleString()} chords)`
                    : ''}
                </span>
                <input
                  type="range"
                  min="0"
                  max={Math.max(0, tasNetwork.regionCount - 1)}
                  step="1"
                  value={normalizedSelectedTasRegionIndex}
                  onChange={(event) =>
                    setSelectedTasRegionIndex(Number.parseInt(event.target.value, 10) || 0)
                  }
                  disabled={tasNetwork.regionCount === 0}
                />
              </label>
              <label className="slider-control tas-limit-control">
                <span>
                  Region chord limit A: {normalizedTasRegionChordLimitPercent.toFixed(0)}% ={' '}
                  {selectedRegionActiveChordCount.toLocaleString()} /{' '}
                  {selectedRegionChordCount.toLocaleString()} in D{normalizedSelectedTasRegionIndex}
                </span>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={normalizedTasRegionChordLimitPercent}
                  onChange={(event) =>
                    setTasRegionChordLimitPercent(Number.parseInt(event.target.value, 10) || 0)
                  }
                  disabled={selectedRegionChordCount === 0}
                />
              </label>
              <div className="multicolor-inline-stats">
                <span className="multicolor-inline-stat">
                  Regions {tasNetwork.regionCount.toLocaleString()}
                </span>
                <span className="multicolor-inline-stat">
                  Chords {tasNetwork.totalChords.toLocaleString()}
                </span>
                <span className="multicolor-inline-stat">
                  Min distance {tasMinDistance.toLocaleString()}
                </span>
                <span className="multicolor-inline-stat">
                  Disabled outer D {disabledTasRegionCount.toLocaleString()}
                </span>
                <span className="multicolor-inline-stat">
                  Enabled through {maxEnabledTasRegionIndex >= 0
                    ? `D${maxEnabledTasRegionIndex.toLocaleString()}`
                    : 'none'}
                </span>
                {selectedTasRegion && (
                  <>
                    <span className="multicolor-inline-stat">
                      Radius {selectedTasRegion.minRadius.toFixed(1)}-{selectedTasRegion.maxRadius.toFixed(1)}
                    </span>
                    <span className="multicolor-inline-stat">
                      Active {isSelectedTasRegionEnabled
                        ? selectedTasRegion.chordCount.toLocaleString()
                        : 'disabled'}
                    </span>
                    {tasPaletteFit && (
                      <span className="multicolor-inline-stat">
                        Limited strings {activeLimitedTasCount.toLocaleString()}
                      </span>
                    )}
                    {tasOwnershipPreview && (
                      <>
                        <span className="multicolor-inline-stat">
                          Pixels {tasOwnershipPreview.assignedPixelCount.toLocaleString()}
                        </span>
                        <span className="multicolor-inline-stat">
                          Owners {tasOwnershipPreview.usedTasCount.toLocaleString()} /{' '}
                          {tasOwnershipPreview.regionTasCount.toLocaleString()}
                        </span>
                      </>
                    )}
                    {tasPaletteFit && (
                      <>
                        <span className="multicolor-inline-stat">
                          Fit {tasPaletteFit.fittedTasCount.toLocaleString()} /{' '}
                          {tasPaletteFit.regionTasCount.toLocaleString()}
                        </span>
                        <span className="multicolor-inline-stat">
                          Avg error{' '}
                          {!isTasPaletteFitLimitedToPalette || tasPaletteFit.averageError === null
                            ? '-'
                            : Math.round(tasPaletteFit.averageError).toLocaleString()}
                        </span>
                      </>
                    )}
                    {allTasPaletteFit && (
                      <>
                        <span className="multicolor-inline-stat">
                          All fit {allTasPaletteFit.fittedTasCount.toLocaleString()} /{' '}
                          {allTasPaletteFit.regionTasCount.toLocaleString()}
                        </span>
                        <span className="multicolor-inline-stat">
                          All avg error{' '}
                          {!isTasPaletteFitLimitedToPalette || allTasPaletteFit.averageError === null
                            ? '-'
                            : Math.round(allTasPaletteFit.averageError).toLocaleString()}
                        </span>
                      </>
                    )}
                  </>
                )}
              </div>
              {tasPaletteFit && (
                <div className="tas-error-list">
                  <div className="tas-error-list-head">
                    <span className="multicolor-lab-label">Region error order</span>
                    {selectedTasRow && (
                      <span className="tas-error-selected">
                        selected {selectedTasRow.startNailNumber}-{selectedTasRow.endNailNumber}
                      </span>
                    )}
                  </div>
                  <div className="tas-sccl-panel">
                    <div
                      className="multicolor-debug-toggle-group tas-sccl-scope-toggle"
                      role="group"
                      aria-label="SCCL scope"
                    >
                      {[
                        ['global', 'Global SCCL'],
                        ['selected-region', `D${normalizedSelectedTasRegionIndex} SCCL`],
                      ].map(([scope, label]) => (
                        <button
                          key={scope}
                          className={[
                            'multicolor-debug-toggle',
                            effectiveScclScope === scope ? 'is-active' : '',
                          ].filter(Boolean).join(' ')}
                          disabled={scope === 'global' && !allTasPaletteFit}
                          type="button"
                          onClick={() => {
                            setScclScope(scope);
                            setSelectedConnectorGapChordKey(null);
                            setSelectedConnectorChordKeys([]);
                          }}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={isTasSameColorFocusEnabled}
                        onChange={(event) => setIsTasSameColorFocusEnabled(event.target.checked)}
                        disabled={activeSameColorChordLists.length === 0}
                      />
                      <span>Focus active color SCCL</span>
                    </label>
                    {activeSameColorChordLists.length > 0 ? (
                      <div className="tas-sccl-list">
                        {activeSameColorChordLists.map((color) => {
                          const isActiveColor = color.id === activePaletteColorId;
                          const firstRows = color.rows.slice(0, 3);
                          return (
                            <button
                              key={color.id}
                              className={[
                                'tas-sccl-chip',
                                isActiveColor ? 'is-active' : '',
                              ].filter(Boolean).join(' ')}
                              type="button"
                              onClick={() => setActivePaletteColorId(color.id)}
                            >
                              <span
                                className="multicolor-palette-swatch"
                                style={{ backgroundColor: color.hex }}
                              />
                              <span className="tas-sccl-name">{color.label}</span>
                              <span className="tas-sccl-count">
                                {color.chordCount.toLocaleString()} TAS
                              </span>
                              <span className="tas-sccl-sample">
                                {firstRows
                                  .map((row) => `${row.startNailNumber}-${row.endNailNumber}`)
                                  .join(', ')}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="multicolor-mini-note">
                        No active same-color chord lists for this region limit.
                      </p>
                    )}
                    {activeColorSameColorList && (
                      <div className="tas-chain-panel">
                        <div className="tas-chain-head">
                          <span className="multicolor-lab-label">
                            {effectiveScclScope === 'selected-region'
                              ? `Selected D${normalizedSelectedTasRegionIndex} SCCL chain`
                              : 'Selected global SCCL chain'}
                          </span>
                          <span className="tas-error-selected">
                            {activeColorSameColorList.label}: {activeColorSameColorList.chordCount.toLocaleString()} TAS
                          </span>
                        </div>
                        <div className="multicolor-inline-stats">
                          <span className="multicolor-inline-stat">
                            Natural {activeColorChainPlan.continuousTransitions.toLocaleString()}
                          </span>
                          <span className="multicolor-inline-stat">
                            Connector gaps {activeColorChainPlan.connectorTransitions.toLocaleString()}
                          </span>
                        </div>
                        <div className="tas-chain-list">
                          {activeColorChainPlan.orderedRows.slice(0, 10).map((row, index) => (
                            <button
                              key={`chain-${row.chordKey}`}
                              className={[
                                'tas-chain-row',
                                row.needsConnector ? 'needs-connector' : '',
                                row.chordKey === selectedTasChordKey ? 'is-selected' : '',
                              ].filter(Boolean).join(' ')}
                              type="button"
                              onClick={() => {
                                const previousRow =
                                  index > 0 ? activeColorChainPlan.orderedRows[index - 1] : null;
                                setSelectedTasChordKey(row.chordKey);
                                setSelectedConnectorGapChordKey(row.needsConnector ? row.chordKey : null);
                                setSelectedChainChordKeys(
                                  row.needsConnector
                                    ? getPreviewChordKeys(previousRow?.chordKey, row.chordKey)
                                    : getPreviewChordKeys(row.chordKey),
                                );
                                setSelectedConnectorChordKeys([]);
                              }}
                            >
                              <span>#{index + 1}</span>
                              <span>{row.chainFromNailNumber}-{row.chainToNailNumber}</span>
                              <span>D{row.regionIndex}</span>
                              <span>{row.needsConnector ? 'connector needed' : 'continuous'}</span>
                            </button>
                          ))}
                        </div>
                        {selectedConnectorGap && (
                          <div className="tas-connector-panel">
                            <div className="tas-chain-head">
                              <span className="multicolor-lab-label">Connector search</span>
                              <span className="tas-error-selected">
                                gap #{selectedConnectorGap.index + 1}:{' '}
                                {selectedConnectorGap.fromNailNumber}-{selectedConnectorGap.toNailNumber}
                              </span>
                            </div>
                            <div className="tas-connector-targets">
                              <span>connect </span>
                              <span>
                                {selectedConnectorGap.previousRow.chainFromNailNumber}-{selectedConnectorGap.previousRow.chainToNailNumber}
                              </span>
                              <span> to </span>
                              <span>
                                {selectedConnectorGap.nextRow.chainFromNailNumber}-{selectedConnectorGap.nextRow.chainToNailNumber}
                              </span>
                            </div>
                            <p className="tas-connector-ranking-note">
                              ranked by damage = length x error, then error, then shorter length, then closer outer region
                            </p>
                            {connectorSearchSummary?.direct ? (
                              <button
                                className={[
                                  'tas-connector-row',
                                  connectorSearchSummary.direct.isClosestOuterCandidate ? 'is-closest-outer' : '',
                                ].filter(Boolean).join(' ')}
                                type="button"
                                onClick={() => {
                                  const directChordKey =
                                    connectorSearchSummary.direct.legs[0]?.chordKey ??
                                    connectorSearchSummary.direct.key;
                                  setTasViewScope('all');
                                  setSelectedTasChordKey(directChordKey);
                                  setSelectedConnectorGapChordKey(selectedConnectorGap.nextRow.chordKey);
                                  setSelectedChainChordKeys(
                                    getPreviewChordKeys(
                                      selectedConnectorGap.previousRow.chordKey,
                                      selectedConnectorGap.nextRow.chordKey,
                                    ),
                                  );
                                  setSelectedConnectorChordKeys(
                                    getPreviewChordKeys(
                                      directChordKey,
                                    ),
                                  );
                                }}
                              >
                                <span>1 string</span>
                                <span>
                                  {connectorSearchSummary.direct.legs[0]?.chordKey ??
                                    connectorSearchSummary.direct.key}
                                </span>
                                <span>
                                  {connectorSearchSummary.direct.nailPath.join('-')} ·{' '}
                                  {connectorSearchSummary.direct.regionPath.map((regionIndex) => `D${regionIndex}`).join('-')}
                                </span>
                                <span className="tas-connector-metrics">
                                  err {Number.isFinite(connectorSearchSummary.direct.totalError)
                                    ? Math.round(connectorSearchSummary.direct.totalError).toLocaleString()
                                    : '-'}
                                  {' '}| len {Number.isFinite(connectorSearchSummary.direct.totalLength)
                                    ? Math.round(connectorSearchSummary.direct.totalLength).toLocaleString()
                                    : '-'}
                                  {' '}| dmg {Number.isFinite(connectorSearchSummary.direct.totalDamage)
                                    ? Math.round(connectorSearchSummary.direct.totalDamage).toLocaleString()
                                    : '-'}
                                  {' '}| out +{connectorSearchSummary.direct.outerSpan}
                                </span>
                              </button>
                            ) : (
                              <p className="multicolor-mini-note">
                                No direct same-color connector found for this gap.
                              </p>
                            )}
                            {connectorSearchSummary?.pathCandidates.length > 0 && (
                              <div className="tas-connector-list">
                                {connectorSearchSummary.pathCandidates.map((candidate) => (
                                  <button
                                    key={candidate.key}
                                    className={[
                                      'tas-connector-row',
                                      candidate.isClosestOuterCandidate ? 'is-closest-outer' : '',
                                    ].filter(Boolean).join(' ')}
                                    type="button"
                                    onClick={() => {
                                      setTasViewScope('all');
                                      setSelectedTasChordKey(candidate.legs[0].chordKey);
                                      setSelectedConnectorGapChordKey(selectedConnectorGap.nextRow.chordKey);
                                      setSelectedChainChordKeys(
                                        getPreviewChordKeys(
                                          selectedConnectorGap.previousRow.chordKey,
                                          selectedConnectorGap.nextRow.chordKey,
                                        ),
                                      );
                                      setSelectedConnectorChordKeys(
                                        getPreviewChordKeys(
                                          candidate.legs.map((leg) => leg.chordKey),
                                        ),
                                      );
                                    }}
                                  >
                                    <span>{candidate.legs.length} strings</span>
                                    <span>
                                      {candidate.legs.map((leg, legIndex) => (
                                        <span key={leg.chordKey}>
                                          {legIndex > 0 ? ' + ' : ''}
                                          {leg.chordKey}
                                        </span>
                                      ))}
                                    </span>
                                    <span>
                                      {candidate.nailPath.join('-')} ·{' '}
                                      {candidate.regionPath.map((regionIndex) => `D${regionIndex}`).join('-')}
                                    </span>
                                    {/*
                                    <span>
                                      via {candidate.middleNailNumber} · D{candidate.legs[0].regionIndex}/D{candidate.legs[1].regionIndex}
                                    </span>
                                    */}
                                    <span className="tas-connector-metrics">
                                      err {Math.round(candidate.totalError).toLocaleString()}
                                      {' '}| len {Math.round(candidate.totalLength).toLocaleString()}
                                      {' '}| dmg {Math.round(candidate.totalDamage).toLocaleString()}
                                      {' '}| out +{candidate.outerSpan}
                                    </span>
                                  </button>
                                ))}
                              </div>
                            )}
                            {connectorSearchSummary &&
                              !connectorSearchSummary.direct &&
                              connectorSearchSummary.pathCandidates.length === 0 && (
                                <p className="multicolor-mini-note">
                                  No same-color outer connector path found.
                                </p>
                              )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                  {globalWindingPreview.totalStepCount > 0 && (
                    <div className="tas-global-order-panel">
                      <div className="tas-chain-head">
                        <span className="multicolor-lab-label">Global winding order</span>
                        <span className="tas-error-selected">
                          first {Math.min(24, globalWindingPreview.totalStepCount).toLocaleString()} /{' '}
                          {globalWindingPreview.totalStepCount.toLocaleString()} active chords
                        </span>
                      </div>
                      <div className="multicolor-inline-stats">
                        {globalWindingPreview.perColorCounts.slice(0, 6).map((color) => (
                          <span key={color.colorId} className="multicolor-inline-stat tas-global-order-stat">
                            <span
                              className="multicolor-palette-swatch"
                              style={{ backgroundColor: color.colorHex }}
                            />
                            {color.colorLabel} {color.count.toLocaleString()}
                          </span>
                        ))}
                      </div>
                      <div className="tas-global-order-list">
                        {globalWindingPreview.steps.slice(0, 24).map((step) => (
                          <button
                            key={`global-order-${step.stepNumber}-${step.chordKey}`}
                            className={[
                              'tas-global-order-row',
                              step.chordKey === selectedTasChordKey ? 'is-selected' : '',
                            ].filter(Boolean).join(' ')}
                            type="button"
                            onClick={() => {
                              setTasViewScope('all');
                              setActivePaletteColorId(step.colorId);
                              setSelectedTasChordKey(step.chordKey);
                              setSelectedChainChordKeys(getPreviewChordKeys(step.chordKey));
                              setSelectedConnectorGapChordKey(null);
                              setSelectedConnectorChordKeys([]);
                            }}
                          >
                            <span>#{step.stepNumber}</span>
                            <span className="tas-global-order-color">
                              <span
                                className="multicolor-palette-swatch"
                                style={{ backgroundColor: step.colorHex }}
                              />
                              {step.colorLabel}
                            </span>
                            <span>{step.startNailNumber}-{step.endNailNumber}</span>
                            <span>D{step.regionIndex}</span>
                            <span>
                              err {Number.isFinite(step.error)
                                ? Math.round(step.error).toLocaleString()
                                : '-'}
                            </span>
                            <span>left {step.remainingInColor.toLocaleString()}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="tas-error-table" role="table" aria-label="Selected region TAS error order">
                    <div className="tas-error-row is-header" role="row">
                      <span>Rank</span>
                      <span>Chord</span>
                      <span>Color</span>
                      <span>Pixels</span>
                      <span>Error</span>
                      <span>Use</span>
                    </div>
                    {highErrorTasRows.map((row) => {
                      const isActiveLimitRow = activeSelectedRegionTasChordKeys.has(row.chordKey);
                      return (
                        <button
                          key={`high-${row.chordKey}`}
                          className={[
                            'tas-error-row',
                            isActiveLimitRow ? 'is-limit-active' : 'is-limit-inactive',
                            row.chordKey === selectedTasChordKey ? 'is-selected' : '',
                          ].filter(Boolean).join(' ')}
                          type="button"
                          role="row"
                          onClick={() => {
                            setSelectedTasChordKey(row.chordKey);
                            setSelectedConnectorGapChordKey(null);
                            setSelectedChainChordKeys(getPreviewChordKeys(row.chordKey));
                            setSelectedConnectorChordKeys([]);
                          }}
                        >
                          <span>#{row.errorRank}</span>
                          <span>{row.startNailNumber}-{row.endNailNumber}</span>
                          <span className="tas-error-color-cell">
                            <span
                              className="multicolor-palette-swatch"
                              style={{ backgroundColor: row.assignedColorHex }}
                            />
                            {row.assignedColorLabel ?? 'average'}
                          </span>
                          <span>{row.pixelCount.toLocaleString()}</span>
                          <span>
                            {Number.isFinite(row.error) ? Math.round(row.error).toLocaleString() : '-'}
                          </span>
                          <span>{isActiveLimitRow ? 'yes' : 'no'}</span>
                        </button>
                      );
                    })}
                    {lowErrorTasRows.length > 0 && (
                      <div className="tas-error-divider">lowest error</div>
                    )}
                    {lowErrorTasRows.map((row) => {
                      const isActiveLimitRow = activeSelectedRegionTasChordKeys.has(row.chordKey);
                      return (
                        <button
                          key={`low-${row.chordKey}`}
                          className={[
                            'tas-error-row',
                            'is-low-error',
                            isActiveLimitRow ? 'is-limit-active' : 'is-limit-inactive',
                            row.chordKey === selectedTasChordKey ? 'is-selected' : '',
                          ].filter(Boolean).join(' ')}
                          type="button"
                          role="row"
                          onClick={() => {
                            setSelectedTasChordKey(row.chordKey);
                            setSelectedConnectorGapChordKey(null);
                            setSelectedChainChordKeys(getPreviewChordKeys(row.chordKey));
                            setSelectedConnectorChordKeys([]);
                          }}
                        >
                          <span>#{row.errorRank}</span>
                          <span>{row.startNailNumber}-{row.endNailNumber}</span>
                          <span className="tas-error-color-cell">
                            <span
                              className="multicolor-palette-swatch"
                              style={{ backgroundColor: row.assignedColorHex }}
                            />
                            {row.assignedColorLabel ?? 'average'}
                          </span>
                          <span>{row.pixelCount.toLocaleString()}</span>
                          <span>
                            {Number.isFinite(row.error) ? Math.round(row.error).toLocaleString() : '-'}
                          </span>
                          <span>{isActiveLimitRow ? 'yes' : 'no'}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <p className="multicolor-mini-note">
                Pixel ownership uses only pixels whose centers project onto a finite TAS side.
                The selected preview shows side-near pixels whose winning TAS belongs to the selected D.
                Min distance disables outer TAS regions whose nail distance is too small.
                Region chord limit A is a global percentage applied separately to each region.
                For a quick geometry check, set nails to 10: D0 should show 5 diameter TASs,
                and D1-D4 should show 10 TASs each.
              </p>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default MulticolorLab;
