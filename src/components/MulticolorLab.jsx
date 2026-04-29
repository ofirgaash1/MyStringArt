import { useMemo, useState } from 'react';
import {
  COLOR_ERROR_SPACE_LABEL,
  clonePalettePreset,
  MULTICOLOR_PALETTE_PRESETS,
} from '../multicolor';
import { useRenderDiagnostics } from '../renderDiagnostics';
import {
  getAreaWeightedTasRegionLimitCounts,
  getTasRegionAreaWeight,
} from '../tasLimits';

const MAX_CONNECTOR_SEARCH_LEGS = 4;
const MAX_CONNECTOR_FRONTIER_STATES = 2000;
const MAX_CONNECTOR_CANDIDATES = 32;

function getRowOtherNailNumber(row, nailNumber) {
  if (row.startNailNumber === nailNumber) {
    return row.endNailNumber;
  }

  if (row.endNailNumber === nailNumber) {
    return row.startNailNumber;
  }

  return null;
}

function getRemainingEndpointDegree(rows, usedChordKeys, nailNumber, skippedChordKey = null) {
  let degree = 0;
  for (const row of rows) {
    if (usedChordKeys.has(row.chordKey) || row.chordKey === skippedChordKey) {
      continue;
    }

    if (row.startNailNumber === nailNumber || row.endNailNumber === nailNumber) {
      degree += 1;
    }
  }
  return degree;
}

function buildContinuityTrailFromNail(rows, startNailNumber) {
  const usedChordKeys = new Set();
  const steps = [];
  let currentNailNumber = startNailNumber;

  while (usedChordKeys.size < rows.length) {
    const candidates = rows
      .filter((row) => (
        !usedChordKeys.has(row.chordKey) &&
        (
          row.startNailNumber === currentNailNumber ||
          row.endNailNumber === currentNailNumber
        )
      ))
      .map((row) => {
        const nextNailNumber = getRowOtherNailNumber(row, currentNailNumber);
        return {
          row,
          nextNailNumber,
          nextDegree: getRemainingEndpointDegree(
            rows,
            usedChordKeys,
            nextNailNumber,
            row.chordKey,
          ),
        };
      })
      .sort((first, second) => {
        if (second.nextDegree !== first.nextDegree) {
          return second.nextDegree - first.nextDegree;
        }
        return first.row.originalRegionOrder - second.row.originalRegionOrder;
      });

    const selected = candidates[0];
    if (!selected) {
      break;
    }

    usedChordKeys.add(selected.row.chordKey);
    steps.push({
      row: selected.row,
      chainFromNailNumber: currentNailNumber,
      chainToNailNumber: selected.nextNailNumber,
    });
    currentNailNumber = selected.nextNailNumber;
  }

  return steps;
}

function buildBestContinuityTrail(rows) {
  const endpointDegrees = new Map();
  for (const row of rows) {
    endpointDegrees.set(row.startNailNumber, (endpointDegrees.get(row.startNailNumber) ?? 0) + 1);
    endpointDegrees.set(row.endNailNumber, (endpointDegrees.get(row.endNailNumber) ?? 0) + 1);
  }
  const oddEndpointNumbers = [...endpointDegrees.entries()]
    .filter(([, degree]) => degree % 2 === 1)
    .sort((first, second) => {
      if (first[1] !== second[1]) {
        return first[1] - second[1];
      }
      return first[0] - second[0];
    })
    .map(([nailNumber]) => nailNumber);
  const rowEndpointNumbers = rows
    .slice(0, 24)
    .flatMap((row) => [row.startNailNumber, row.endNailNumber]);
  const startNailNumbers = [...new Set([
    ...oddEndpointNumbers,
    ...rowEndpointNumbers,
  ])].slice(0, 48);

  return startNailNumbers
    .map((startNailNumber) => buildContinuityTrailFromNail(rows, startNailNumber))
    .sort((first, second) => {
      if (second.length !== first.length) {
        return second.length - first.length;
      }

      const firstOrder = first[0]?.row.originalRegionOrder ?? Number.MAX_SAFE_INTEGER;
      const secondOrder = second[0]?.row.originalRegionOrder ?? Number.MAX_SAFE_INTEGER;
      return firstOrder - secondOrder;
    })[0] ?? [];
}

function buildRegionContinuityTrails(regionRows) {
  const remainingRows = regionRows.map((row, originalRegionOrder) => ({
    ...row,
    originalRegionOrder,
  }));
  const trails = [];

  while (remainingRows.length > 0) {
    const trail = buildBestContinuityTrail(remainingRows);
    if (trail.length === 0) {
      const [fallbackRow] = remainingRows.splice(0, 1);
      trails.push([{
        row: fallbackRow,
        chainFromNailNumber: fallbackRow.startNailNumber,
        chainToNailNumber: fallbackRow.endNailNumber,
      }]);
      continue;
    }

    const usedChordKeys = new Set(trail.map((step) => step.row.chordKey));
    for (let index = remainingRows.length - 1; index >= 0; index -= 1) {
      if (usedChordKeys.has(remainingRows[index].chordKey)) {
        remainingRows.splice(index, 1);
      }
    }
    trails.push(trail);
  }

  return trails.sort((first, second) => {
    if (first.length !== second.length) {
      return first.length - second.length;
    }

    const firstOrder = first[0]?.row.originalRegionOrder ?? Number.MAX_SAFE_INTEGER;
    const secondOrder = second[0]?.row.originalRegionOrder ?? Number.MAX_SAFE_INTEGER;
    return firstOrder - secondOrder;
  });
}

function getConsecutiveRegionBlocks(rows) {
  const blocks = [];
  for (const row of rows) {
    const previousBlock = blocks[blocks.length - 1];
    if (previousBlock?.regionIndex === row.regionIndex) {
      previousBlock.rows.push(row);
      continue;
    }

    blocks.push({
      regionIndex: row.regionIndex,
      rows: [row],
    });
  }
  return blocks;
}

function planSameColorChain(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      orderedRows: [],
      continuousTransitions: 0,
      connectorTransitions: 0,
    };
  }

  const orderedRows = [];
  let currentNailNumber = null;
  let continuousTransitions = 0;
  let connectorTransitions = 0;
  let regionBlockCount = 0;

  for (const regionBlock of getConsecutiveRegionBlocks(rows)) {
    regionBlockCount += 1;
    for (const trail of buildRegionContinuityTrails(regionBlock.rows)) {
      for (const step of trail) {
        const needsConnector =
          orderedRows.length > 0 &&
          currentNailNumber !== step.chainFromNailNumber;
        const plannedRow = { ...step.row };
        delete plannedRow.originalRegionOrder;
        if (orderedRows.length > 0) {
          if (needsConnector) {
            connectorTransitions += 1;
          } else {
            continuousTransitions += 1;
          }
        }

        orderedRows.push({
          ...plannedRow,
          chainFromNailNumber: step.chainFromNailNumber,
          chainToNailNumber: step.chainToNailNumber,
          needsConnector,
        });
        currentNailNumber = step.chainToNailNumber;
      }
    }
  }

  return {
    orderedRows,
    continuousTransitions,
    connectorTransitions,
    regionBlockCount,
  };
}

function getChordEndpointKey(firstNailNumber, secondNailNumber) {
  return firstNailNumber < secondNailNumber
    ? `${firstNailNumber}-${secondNailNumber}`
    : `${secondNailNumber}-${firstNailNumber}`;
}

function getActiveChordKeysByRegionLimit(rows, regionLimitCounts) {
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

  for (const [regionIndex, regionRows] of rowsByRegion.entries()) {
    const regionLimit = Math.min(
      regionRows.length,
      regionLimitCounts.get(regionIndex) ?? 0,
    );
    if (regionLimit <= 0) {
      continue;
    }

    for (const row of regionRows.slice(-regionLimit)) {
      activeChordKeys.add(row.chordKey);
    }
  }

  return activeChordKeys;
}

function getActiveRowsByRegionOrder(rows, regionLimitCounts) {
  if (!Array.isArray(rows) || rows.length === 0) {
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
    .flatMap(([regionIndex, regionRows]) => {
      const regionLimit = Math.min(
        regionRows.length,
        regionLimitCounts.get(regionIndex) ?? 0,
      );
      if (regionLimit <= 0) {
        return [];
      }

      return regionRows.slice(-regionLimit);
    });
}

function getConnectorSearchSummary({
  allRows,
  activeChordKeys,
  colorId,
  excludedChordKeys = new Set(),
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
      activeChordKeys.has(row.chordKey) &&
      !excludedChordKeys.has(row.chordKey),
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

  let wasSearchTruncated = false;

  while (
    frontier.length > 0 &&
    pathCandidates.length === 0 &&
    frontier[0].legs.length < MAX_CONNECTOR_SEARCH_LEGS
  ) {
    const nextFrontier = [];
    for (const state of frontier) {
      const nextRows = (rowsByNailNumber.get(state.currentNailNumber) ?? [])
        .filter((row) => !state.usedChordKeys.has(row.chordKey))
        .sort((firstRow, secondRow) => {
          const firstDamage = getConnectorLegDamage(firstRow);
          const secondDamage = getConnectorLegDamage(secondRow);
          if (firstDamage !== secondDamage) {
            return firstDamage - secondDamage;
          }

          if (firstRow.regionIndex !== secondRow.regionIndex) {
            return firstRow.regionIndex - secondRow.regionIndex;
          }

          return firstRow.chordKey.localeCompare(secondRow.chordKey);
        });
      for (const row of nextRows) {
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
          if (pathCandidates.length >= MAX_CONNECTOR_CANDIDATES) {
            break;
          }
        } else {
          nextFrontier.push({
            currentNailNumber: nextNailNumber,
            nailPath: nextNailPath,
            legs: nextLegs,
            usedChordKeys: nextUsedChordKeys,
          });
        }
      }
      if (pathCandidates.length >= MAX_CONNECTOR_CANDIDATES) {
        break;
      }
    }

    if (nextFrontier.length > MAX_CONNECTOR_FRONTIER_STATES) {
      wasSearchTruncated = true;
    }
    frontier = nextFrontier
      .sort((firstState, secondState) => {
        const firstDamage = firstState.legs.reduce(
          (sum, leg) => sum + getConnectorLegDamage(leg),
          0,
        );
        const secondDamage = secondState.legs.reduce(
          (sum, leg) => sum + getConnectorLegDamage(leg),
          0,
        );
        return firstDamage - secondDamage;
      })
      .slice(0, MAX_CONNECTOR_FRONTIER_STATES);
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
    isSearchTruncated:
      wasSearchTruncated ||
      (frontier.length > 0 && pathCandidates.length === 0),
    maxConnectorSearchLegs: MAX_CONNECTOR_SEARCH_LEGS,
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

function CollapsiblePanel({
  children,
  isOpen,
  onToggle,
  summary = null,
  title,
}) {
  return (
    <div className={['lab-collapsible-panel', isOpen ? 'is-open' : ''].filter(Boolean).join(' ')}>
      <button
        className="lab-collapsible-trigger"
        type="button"
        aria-expanded={isOpen}
        onClick={onToggle}
      >
        <span className="lab-collapsible-title">
          <span className="lab-collapsible-arrow">{isOpen ? 'v' : '>'}</span>
          {title}
        </span>
        {summary && <span className="lab-collapsible-summary">{summary}</span>}
      </button>
      {isOpen && (
        <div className="lab-collapsible-body">
          {children}
        </div>
      )}
    </div>
  );
}

function StatsPanel({
  children,
  isOpen,
  onToggle,
  summary,
  title = 'Stats',
}) {
  return (
    <CollapsiblePanel
      title={title}
      summary={summary}
      isOpen={isOpen}
      onToggle={onToggle}
    >
      <div className="multicolor-inline-stats">
        {children}
      </div>
    </CollapsiblePanel>
  );
}

function getConnectorLegDamage(leg) {
  if (!leg) {
    return Infinity;
  }

  const error = Number.isFinite(leg.error) ? leg.error : Infinity;
  const chordLength = Number.isFinite(leg.chordLength) ? leg.chordLength : Infinity;
  return error * chordLength;
}

function getRowDamage(row) {
  return getConnectorLegDamage(row);
}

function getOrientedRow(row, fromNailNumber) {
  if (row.startNailNumber === fromNailNumber) {
    return {
      chainFromNailNumber: row.startNailNumber,
      chainToNailNumber: row.endNailNumber,
    };
  }

  if (row.endNailNumber === fromNailNumber) {
    return {
      chainFromNailNumber: row.endNailNumber,
      chainToNailNumber: row.startNailNumber,
    };
  }

  return {
    chainFromNailNumber: row.startNailNumber,
    chainToNailNumber: row.endNailNumber,
  };
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

function chooseConnectorCandidate(summary) {
  if (!summary) {
    return null;
  }

  return summary.direct ?? summary.pathCandidates[0] ?? null;
}

function getBestTwoStringConnectorRepair({
  activeChordKeys,
  allRows,
  colorId,
  excludedChordKeys,
  fromNailNumber,
  sourceRegionIndex,
  toNailNumber,
}) {
  const firstLegs = allRows.filter((row) => (
    row.assignedColorId === colorId &&
    row.regionIndex > sourceRegionIndex &&
    !excludedChordKeys.has(row.chordKey) &&
    (row.startNailNumber === fromNailNumber || row.endNailNumber === fromNailNumber)
  ));
  const secondLegsByNailNumber = new Map();

  for (const row of allRows) {
    if (
      row.assignedColorId !== colorId ||
      row.regionIndex <= sourceRegionIndex ||
      excludedChordKeys.has(row.chordKey) ||
      (row.startNailNumber !== toNailNumber && row.endNailNumber !== toNailNumber)
    ) {
      continue;
    }

    const middleNailNumber =
      row.startNailNumber === toNailNumber ? row.endNailNumber : row.startNailNumber;
    const middleRows = secondLegsByNailNumber.get(middleNailNumber) ?? [];
    middleRows.push(row);
    secondLegsByNailNumber.set(middleNailNumber, middleRows);
  }

  const candidates = [];
  for (const firstLeg of firstLegs) {
    const middleNailNumber =
      firstLeg.startNailNumber === fromNailNumber
        ? firstLeg.endNailNumber
        : firstLeg.startNailNumber;
    const secondLegs = secondLegsByNailNumber.get(middleNailNumber) ?? [];

    for (const secondLeg of secondLegs) {
      if (secondLeg.chordKey === firstLeg.chordKey) {
        continue;
      }

      const legs = [firstLeg, secondLeg];
      const totalDamage = legs.reduce((sum, leg) => sum + getConnectorLegDamage(leg), 0);
      const totalError = legs.reduce(
        (sum, leg) => sum + (Number.isFinite(leg.error) ? leg.error : Infinity),
        0,
      );
      const totalLength = legs.reduce(
        (sum, leg) => sum + (Number.isFinite(leg.chordLength) ? leg.chordLength : 0),
        0,
      );
      const maxRegionIndex = Math.max(firstLeg.regionIndex, secondLeg.regionIndex);
      candidates.push({
        key: legs.map((leg) => leg.chordKey).join('+'),
        legs,
        nailPath: [fromNailNumber, middleNailNumber, toNailNumber],
        regionPath: legs.map((leg) => leg.regionIndex),
        totalDamage,
        totalError,
        totalLength,
        maxRegionIndex,
        outerSpan: Math.max(0, maxRegionIndex - sourceRegionIndex),
        usesReserveChord: legs.some((leg) => !activeChordKeys.has(leg.chordKey)),
      });
    }
  }

  return candidates.sort((firstCandidate, secondCandidate) => {
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
  })[0] ?? null;
}

function getBestReserveReplacementRepair({
  activeChordKeys,
  allRows,
  colorId,
  deletedRow,
  excludedChordKeys,
  fromNailNumber,
}) {
  const reserveRows = allRows
    .filter((row) => (
      row.assignedColorId === colorId &&
      row.regionIndex === deletedRow.regionIndex &&
      !activeChordKeys.has(row.chordKey) &&
      !excludedChordKeys.has(row.chordKey) &&
      (row.startNailNumber === fromNailNumber || row.endNailNumber === fromNailNumber)
    ))
    .map((row) => {
      const oriented = getOrientedRow(row, fromNailNumber);
      const replacementDamage = getRowDamage(row);
      const deletionDamage = getRowDamage(deletedRow);
      return {
        deletedRow,
        replacementRow: row,
        ...oriented,
        totalDamage: deletionDamage + replacementDamage,
        deletionDamage,
        replacementDamage,
      };
    });

  return reserveRows.sort((firstRepair, secondRepair) => {
    if (firstRepair.totalDamage !== secondRepair.totalDamage) {
      return firstRepair.totalDamage - secondRepair.totalDamage;
    }
    if (firstRepair.replacementDamage !== secondRepair.replacementDamage) {
      return firstRepair.replacementDamage - secondRepair.replacementDamage;
    }
    return firstRepair.replacementRow.chordKey.localeCompare(secondRepair.replacementRow.chordKey);
  })[0] ?? null;
}

function buildConnectorAwareColorRows({
  allRows,
  activeChordKeys,
  colorId,
  colorRows,
}) {
  const chainPlan = planSameColorChain(sortRowsForGlobalWinding(colorRows));
  const consumedConnectorChordKeys = new Set();
  const drawnChordKeys = new Set();
  const finalRows = [];
  const connectorRows = [];
  const deletedRows = [];
  const replacementRows = [];
  const unresolvedGaps = [];

  for (let index = 0; index < chainPlan.orderedRows.length; index += 1) {
    const row = chainPlan.orderedRows[index];
    if (drawnChordKeys.has(row.chordKey)) {
      continue;
    }

    const previousFinalRow = finalRows[finalRows.length - 1] ?? null;

    if (row.needsConnector && previousFinalRow) {
      const excludedChordKeys = new Set([
        ...consumedConnectorChordKeys,
        ...drawnChordKeys,
        row.chordKey,
      ]);
      const summary = getConnectorSearchSummary({
        allRows,
        activeChordKeys,
        colorId,
        excludedChordKeys,
        fromNailNumber: previousFinalRow.chainToNailNumber ?? previousFinalRow.endNailNumber,
        toNailNumber: row.chainFromNailNumber,
        sourceRegionIndex: row.regionIndex,
      });
      const activeConnectorCandidate = chooseConnectorCandidate(summary);
      const reserveConnectorCandidate = activeConnectorCandidate
        ? null
        : getBestTwoStringConnectorRepair({
            activeChordKeys,
            allRows,
            colorId,
            excludedChordKeys,
            fromNailNumber: previousFinalRow.chainToNailNumber ?? previousFinalRow.endNailNumber,
            sourceRegionIndex: row.regionIndex,
            toNailNumber: row.chainFromNailNumber,
          });
      const replacementRepair = activeConnectorCandidate
        ? null
        : getBestReserveReplacementRepair({
            activeChordKeys,
            allRows,
            colorId,
            deletedRow: row,
            excludedChordKeys,
            fromNailNumber: previousFinalRow.chainToNailNumber ?? previousFinalRow.endNailNumber,
          });
      const shouldUseReplacement =
        replacementRepair &&
        (!reserveConnectorCandidate ||
          replacementRepair.totalDamage < reserveConnectorCandidate.totalDamage);
      const connectorCandidate = activeConnectorCandidate ??
        (shouldUseReplacement ? null : reserveConnectorCandidate);

      if (connectorCandidate) {
        for (let legIndex = 0; legIndex < connectorCandidate.legs.length; legIndex += 1) {
          const leg = connectorCandidate.legs[legIndex];
          const connectorRow = {
            ...leg,
            isGeneratedConnector: true,
            isReserveConnector: !activeChordKeys.has(leg.chordKey),
            connectorGapChordKey: row.chordKey,
            connectorLegIndex: legIndex + 1,
            connectorLegCount: connectorCandidate.legs.length,
            connectorRepairDamage: connectorCandidate.totalDamage,
            schedulingRegionIndex: row.regionIndex,
            chainFromNailNumber: connectorCandidate.nailPath[legIndex],
            chainToNailNumber: connectorCandidate.nailPath[legIndex + 1],
          };
          consumedConnectorChordKeys.add(leg.chordKey);
          drawnChordKeys.add(leg.chordKey);
          connectorRows.push(connectorRow);
          finalRows.push(connectorRow);
        }
      } else if (replacementRepair) {
        const replacementRow = {
          ...replacementRepair.replacementRow,
          isReserveReplacement: true,
          replacesChordKey: row.chordKey,
          replacementRepairDamage: replacementRepair.totalDamage,
          deletionDamage: replacementRepair.deletionDamage,
          replacementDamage: replacementRepair.replacementDamage,
          schedulingRegionIndex: row.regionIndex,
          chainFromNailNumber: replacementRepair.chainFromNailNumber,
          chainToNailNumber: replacementRepair.chainToNailNumber,
        };
        deletedRows.push(row);
        replacementRows.push(replacementRow);
        drawnChordKeys.add(replacementRow.chordKey);
        finalRows.push(replacementRow);
        continue;
      } else {
        unresolvedGaps.push({
          colorId,
          fromNailNumber: previousFinalRow.chainToNailNumber ?? previousFinalRow.endNailNumber,
          previousChordKey: previousFinalRow.chordKey,
          previousFromNailNumber:
            previousFinalRow.chainFromNailNumber ?? previousFinalRow.startNailNumber,
          previousToNailNumber:
            previousFinalRow.chainToNailNumber ?? previousFinalRow.endNailNumber,
          toNailNumber: row.chainFromNailNumber,
          nextChordKey: row.chordKey,
          nextFromNailNumber: row.chainFromNailNumber,
          nextToNailNumber: row.chainToNailNumber,
          regionIndex: row.regionIndex,
        });
      }
    }

    if (!drawnChordKeys.has(row.chordKey)) {
      drawnChordKeys.add(row.chordKey);
      finalRows.push(row);
    }
  }

  return {
    rows: finalRows,
    connectorRows,
    consumedConnectorChordKeys,
    deletedRows,
    replacementRows,
    unresolvedGaps,
  };
}

export function buildGlobalWindingPreview(rows, paletteColors, allRows = rows, activeChordKeys = new Set()) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return {
      steps: [],
      totalStepCount: 0,
      perColorCounts: [],
      perRegionCounts: [],
      connectorCount: 0,
      consumedConnectorCount: 0,
      deletedCount: 0,
      reserveConnectorCount: 0,
      reserveReplacementCount: 0,
      unresolvedGaps: [],
      unresolvedGapCount: 0,
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
    const connectorAwarePlan = buildConnectorAwareColorRows({
      allRows,
      activeChordKeys,
      colorId,
      colorRows,
    });
    return {
      colorId,
      colorLabel: paletteColor?.label ?? colorId,
      colorHex: paletteColor?.hex ?? colorRows[0]?.assignedColorHex ?? '#0f172a',
      rows: connectorAwarePlan.rows,
      deletedRows: connectorAwarePlan.deletedRows,
      connectorCount: connectorAwarePlan.connectorRows.length,
      consumedConnectorCount: [...connectorAwarePlan.consumedConnectorChordKeys]
        .filter((chordKey) => activeChordKeys.has(chordKey)).length,
      deletedCount: connectorAwarePlan.deletedRows.length,
      reserveConnectorCount: connectorAwarePlan.connectorRows
        .filter((row) => row.isReserveConnector).length,
      reserveReplacementCount: connectorAwarePlan.replacementRows.length,
      unresolvedGaps: connectorAwarePlan.unresolvedGaps.map((gap) => ({
        ...gap,
        colorId,
        colorLabel: paletteColor?.label ?? colorId,
        colorHex: paletteColor?.hex ?? colorRows[0]?.assignedColorHex ?? '#0f172a',
      })),
      unresolvedGapCount: connectorAwarePlan.unresolvedGaps.length,
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
  const connectorCount = queues.reduce((sum, queue) => sum + queue.connectorCount, 0);
  const consumedConnectorCount = queues.reduce(
    (sum, queue) => sum + queue.consumedConnectorCount,
    0,
  );
  const deletedCount = queues.reduce((sum, queue) => sum + queue.deletedCount, 0);
  const reserveConnectorCount = queues.reduce(
    (sum, queue) => sum + queue.reserveConnectorCount,
    0,
  );
  const reserveReplacementCount = queues.reduce(
    (sum, queue) => sum + queue.reserveReplacementCount,
    0,
  );
  const unresolvedGapCount = queues.reduce((sum, queue) => sum + queue.unresolvedGapCount, 0);
  const unresolvedGaps = queues
    .flatMap((queue) => queue.unresolvedGaps)
    .sort((firstGap, secondGap) => {
      if (firstGap.regionIndex !== secondGap.regionIndex) {
        return firstGap.regionIndex - secondGap.regionIndex;
      }
      if (firstGap.colorLabel !== secondGap.colorLabel) {
        return firstGap.colorLabel.localeCompare(secondGap.colorLabel);
      }
      return firstGap.nextChordKey.localeCompare(secondGap.nextChordKey);
    });
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
      (minRegion, candidate) =>
        Math.min(
          minRegion,
          candidate.row.schedulingRegionIndex ?? candidate.row.regionIndex,
        ),
      Infinity,
    );
    const chosenCandidate = candidates
      .filter(
        (candidate) =>
          (candidate.row.schedulingRegionIndex ?? candidate.row.regionIndex) === innermostRegion,
      )
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
      finalRowId: `final-${steps.length + 1}-${chosenCandidate.row.chordKey}`,
      rowType: chosenCandidate.row.isGeneratedConnector
        ? 'connector'
        : chosenCandidate.row.isReserveReplacement
          ? 'reserve-replacement'
          : 'active',
      colorId: chosenCandidate.queue.colorId,
      colorLabel: chosenCandidate.queue.colorLabel,
      colorHex: chosenCandidate.queue.colorHex,
      drawFromNailNumber:
        chosenCandidate.row.chainFromNailNumber ?? chosenCandidate.row.startNailNumber,
      drawToNailNumber:
        chosenCandidate.row.chainToNailNumber ?? chosenCandidate.row.endNailNumber,
      schedulingRegionIndex:
        chosenCandidate.row.schedulingRegionIndex ?? chosenCandidate.row.regionIndex,
      remainingInColor: chosenCandidate.queue.rows.length - chosenCandidate.queue.index - 1,
      ...chosenCandidate.row,
    });
    chosenCandidate.queue.index += 1;
  }

  const regionCountsByIndex = new Map();
  for (const row of rows) {
    const regionCounts = regionCountsByIndex.get(row.regionIndex) ?? {
      regionIndex: row.regionIndex,
      activeLimitCount: 0,
      activeNormalFinalCount: 0,
      normalFinalCount: 0,
      connectorCount: 0,
      reserveConnectorCount: 0,
      reserveReplacementCount: 0,
      deletedCount: 0,
      finalCount: 0,
      removedDuplicateCount: 0,
      unresolvedGapCount: 0,
    };
    regionCounts.activeLimitCount += 1;
    regionCountsByIndex.set(row.regionIndex, regionCounts);
  }

  for (const step of steps) {
    const regionCounts = regionCountsByIndex.get(step.regionIndex) ?? {
      regionIndex: step.regionIndex,
      activeLimitCount: 0,
      activeNormalFinalCount: 0,
      normalFinalCount: 0,
      connectorCount: 0,
      reserveConnectorCount: 0,
      reserveReplacementCount: 0,
      deletedCount: 0,
      finalCount: 0,
      removedDuplicateCount: 0,
      unresolvedGapCount: 0,
    };
    regionCounts.finalCount += 1;
    if (step.isGeneratedConnector) {
      regionCounts.connectorCount += 1;
      if (step.isReserveConnector) {
        regionCounts.reserveConnectorCount += 1;
      }
    } else {
      regionCounts.normalFinalCount += 1;
      if (step.isReserveReplacement) {
        regionCounts.reserveReplacementCount += 1;
      } else {
        regionCounts.activeNormalFinalCount += 1;
      }
    }
    regionCountsByIndex.set(step.regionIndex, regionCounts);
  }

  for (const deletedRow of queues.flatMap((queue) => queue.deletedRows)) {
    const regionCounts = regionCountsByIndex.get(deletedRow.regionIndex) ?? {
      regionIndex: deletedRow.regionIndex,
      activeLimitCount: 0,
      activeNormalFinalCount: 0,
      normalFinalCount: 0,
      connectorCount: 0,
      reserveConnectorCount: 0,
      reserveReplacementCount: 0,
      deletedCount: 0,
      finalCount: 0,
      removedDuplicateCount: 0,
      unresolvedGapCount: 0,
    };
    regionCounts.deletedCount += 1;
    regionCountsByIndex.set(deletedRow.regionIndex, regionCounts);
  }

  for (const gap of unresolvedGaps) {
    const regionCounts = regionCountsByIndex.get(gap.regionIndex) ?? {
      regionIndex: gap.regionIndex,
      activeLimitCount: 0,
      activeNormalFinalCount: 0,
      normalFinalCount: 0,
      connectorCount: 0,
      reserveConnectorCount: 0,
      reserveReplacementCount: 0,
      deletedCount: 0,
      finalCount: 0,
      removedDuplicateCount: 0,
      unresolvedGapCount: 0,
    };
    regionCounts.unresolvedGapCount += 1;
    regionCountsByIndex.set(gap.regionIndex, regionCounts);
  }

  const perRegionCounts = [...regionCountsByIndex.values()]
    .map((regionCounts) => ({
      ...regionCounts,
      removedDuplicateCount: Math.max(
        0,
        regionCounts.activeLimitCount -
          regionCounts.activeNormalFinalCount -
          regionCounts.deletedCount,
      ),
      reserveCount: regionCounts.reserveConnectorCount + regionCounts.reserveReplacementCount,
      finalDeltaFromActive:
        regionCounts.finalCount - regionCounts.activeLimitCount,
    }))
    .sort((firstRegion, secondRegion) => firstRegion.regionIndex - secondRegion.regionIndex);

  return {
    steps,
    totalStepCount,
    perColorCounts,
    perRegionCounts,
    connectorCount,
    consumedConnectorCount,
    deletedCount,
    reserveConnectorCount,
    reserveReplacementCount,
    unresolvedGaps,
    unresolvedGapCount,
  };
}

export function buildFinalDrawingPlanFromTasRows({
  maxRegionIndex,
  paletteColors,
  regionLimitPercent,
  regions,
  sortedRows,
}) {
  const regionLimitCounts = getAreaWeightedTasRegionLimitCounts({
    regions,
    limitPercent: regionLimitPercent,
    maxRegionIndex,
  });
  const activeChordKeys = getActiveChordKeysByRegionLimit(sortedRows, regionLimitCounts);
  const activeRows = getActiveRowsByRegionOrder(sortedRows, regionLimitCounts);

  return buildGlobalWindingPreview(
    activeRows,
    paletteColors,
    sortedRows,
    activeChordKeys,
  );
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
  onGenerateAutomaticPalette,
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
  const [openLabPanels, setOpenLabPanels] = useState({
    paletteComparison: false,
    coverage: false,
    coverageStats: false,
    sameColorLists: false,
    chain: false,
    chainStats: false,
    connectors: true,
    globalOrder: true,
    globalOrderStats: false,
    regionAccounting: false,
    unresolvedGaps: false,
    errorOrder: false,
    regionStats: false,
    tasNotes: false,
  });
  const [automaticPaletteColorCount, setAutomaticPaletteColorCount] = useState(4);
  const isLabPanelOpen = (panelId) => Boolean(openLabPanels[panelId]);
  const toggleLabPanel = (panelId) => {
    setOpenLabPanels((currentPanels) => ({
      ...currentPanels,
      [panelId]: !currentPanels[panelId],
    }));
  };
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
  const areaWeightedRegionLimitCounts = useMemo(
    () =>
      getAreaWeightedTasRegionLimitCounts({
        regions: tasNetwork.regions,
        limitPercent: normalizedTasRegionChordLimitPercent,
        maxRegionIndex: maxEnabledTasRegionIndex,
      }),
    [maxEnabledTasRegionIndex, normalizedTasRegionChordLimitPercent, tasNetwork],
  );
  const selectedRegionActiveChordCount = selectedRegionChordCount > 0
    ? Math.min(
        selectedRegionChordCount,
        areaWeightedRegionLimitCounts.get(normalizedSelectedTasRegionIndex) ?? 0,
      )
    : 0;
  const selectedRegionActiveFitRowCount = selectedRegionTasRows.length > 0
    ? Math.min(
        selectedRegionTasRows.length,
        areaWeightedRegionLimitCounts.get(normalizedSelectedTasRegionIndex) ?? 0,
      )
    : 0;
  const enabledTasRegionAreaWeight = useMemo(
    () =>
      tasNetwork.regions
        .filter((region) => region.index <= maxEnabledTasRegionIndex)
        .reduce((sum, region) => sum + getTasRegionAreaWeight(region), 0),
    [maxEnabledTasRegionIndex, tasNetwork],
  );
  const selectedTasRegionAreaSharePercent =
    selectedTasRegion && enabledTasRegionAreaWeight > 0
      ? (getTasRegionAreaWeight(selectedTasRegion) / enabledTasRegionAreaWeight) * 100
      : null;
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
        areaWeightedRegionLimitCounts,
      ),
    [allTasPaletteFit, areaWeightedRegionLimitCounts],
  );
  const activeGlobalTasRows = useMemo(
    () =>
      getActiveRowsByRegionOrder(
        allTasPaletteFit?.sortedRows ?? [],
        areaWeightedRegionLimitCounts,
      ),
    [allTasPaletteFit, areaWeightedRegionLimitCounts],
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
      buildFinalDrawingPlanFromTasRows({
        maxRegionIndex: maxEnabledTasRegionIndex,
        paletteColors: multicolorPaletteColors,
        regionLimitPercent: tasRegionChordLimitPercent,
        regions: tasNetwork.regions,
        sortedRows: allTasPaletteFit?.sortedRows ?? [],
      }),
    [
      allTasPaletteFit,
      maxEnabledTasRegionIndex,
      multicolorPaletteColors,
      tasNetwork,
      tasRegionChordLimitPercent,
    ],
  );
  const enabledPaletteColorCount = multicolorPaletteColors.filter((color) => color.enabled).length;
  const finalPlanStatus =
    !hasOriginalImage
      ? 'Load image'
      : !isPalettePreviewEnabled
        ? 'Palette off'
        : !isTasPaletteFitPreviewEnabled
          ? 'Fit off'
          : globalWindingPreview.totalStepCount <= 0
            ? 'No plan'
            : globalWindingPreview.unresolvedGapCount > 0
              ? 'Needs repair'
              : 'Ready';
  const finalPlanTone =
    finalPlanStatus === 'Ready'
      ? 'is-ready'
      : finalPlanStatus === 'Needs repair'
        ? 'needs-attention'
        : 'is-muted';
  const handleDownloadFinalPlan = () => {
    if (globalWindingPreview.totalStepCount <= 0) {
      return;
    }

    const planExport = {
      meta: {
        exportedAt: new Date().toISOString(),
        paletteSource: sourceLabel,
        colorErrorSpace: COLOR_ERROR_SPACE_LABEL,
        totalRows: globalWindingPreview.totalStepCount,
        connectorRows: globalWindingPreview.connectorCount,
        unresolvedGaps: globalWindingPreview.unresolvedGapCount,
      },
      palette: multicolorPaletteColors.map((color) => ({
        id: color.id,
        label: color.label,
        hex: color.hex,
        enabled: color.enabled,
      })),
      perColorCounts: globalWindingPreview.perColorCounts,
      perRegionCounts: globalWindingPreview.perRegionCounts,
      unresolvedGaps: globalWindingPreview.unresolvedGaps,
      rows: globalWindingPreview.steps.map((step) => ({
        stepNumber: step.stepNumber,
        rowType: step.rowType,
        colorId: step.colorId,
        colorLabel: step.colorLabel,
        colorHex: step.colorHex,
        chordKey: step.chordKey,
        regionIndex: step.regionIndex,
        fromNailNumber: step.drawFromNailNumber,
        toNailNumber: step.drawToNailNumber,
        error: step.error,
        chordLength: step.chordLength,
        connectorGapChordKey: step.connectorGapChordKey ?? null,
        connectorLegIndex: step.connectorLegIndex ?? null,
        connectorLegCount: step.connectorLegCount ?? null,
        replacesChordKey: step.replacesChordKey ?? null,
        remainingInColor: step.remainingInColor,
      })),
    };

    const exportUrl = URL.createObjectURL(
      new Blob([JSON.stringify(planExport, null, 2)], { type: 'application/json' }),
    );
    const downloadLink = document.createElement('a');
    downloadLink.href = exportUrl;
    downloadLink.download = 'multicolor-final-drawing-plan.json';
    downloadLink.click();
    URL.revokeObjectURL(exportUrl);
  };
  const openOnlyLabPanel = (panelId) => {
    setOpenLabPanels((currentPanels) => ({
      ...currentPanels,
      coverage: false,
      sameColorLists: false,
      chain: false,
      globalOrder: false,
      regionAccounting: false,
      unresolvedGaps: false,
      errorOrder: false,
      [panelId]: true,
    }));
  };

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
        <h2>Multicolor planner</h2>
        <p>Choose colors, fit strings, and inspect the final drawing order.</p>
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
            <span className="multicolor-status-chip">Error: {COLOR_ERROR_SPACE_LABEL}</span>
            <span className={['multicolor-status-chip', finalPlanTone].filter(Boolean).join(' ')}>
              Plan: {finalPlanStatus}
            </span>
            <span className="multicolor-status-chip">
              Regions: {tasNetwork.regionCount.toLocaleString()}
            </span>
          </div>
          <div className="lab-overview-grid">
            <button
              className="lab-overview-card"
              type="button"
              onClick={() => openOnlyLabPanel('coverage')}
            >
              <span className="lab-overview-label">Palette</span>
              <span className="lab-overview-value">
                {enabledPaletteColorCount.toLocaleString()} colors
              </span>
              <span className="lab-overview-detail">
                {sourceLabel}, coverage {(totalPaletteCoverageTenths / 10).toFixed(1)}%
              </span>
            </button>
            <button
              className="lab-overview-card"
              type="button"
              onClick={() => openOnlyLabPanel('regionStats')}
            >
              <span className="lab-overview-label">Region</span>
              <span className="lab-overview-value">
                D{normalizedSelectedTasRegionIndex}
              </span>
              <span className="lab-overview-detail">
                {selectedRegionActiveChordCount.toLocaleString()} / {selectedRegionChordCount.toLocaleString()} active
              </span>
            </button>
            <button
              className={['lab-overview-card', finalPlanTone].filter(Boolean).join(' ')}
              type="button"
              onClick={() => openOnlyLabPanel('globalOrder')}
            >
              <span className="lab-overview-label">Drawing order</span>
              <span className="lab-overview-value">
                {globalWindingPreview.totalStepCount.toLocaleString()} rows
              </span>
              <span className="lab-overview-detail">
                {globalWindingPreview.connectorCount.toLocaleString()} conn /{' '}
                {globalWindingPreview.unresolvedGapCount.toLocaleString()} gaps
              </span>
            </button>
          </div>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>Colors</h3>
              <p>Pick the colors used for fitting and planning.</p>
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
                <span>Show palette preview</span>
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
              <div className="automatic-palette-panel">
                <label className="slider-control automatic-palette-count">
                  <span>Automatic colors: {automaticPaletteColorCount}</span>
                  <input
                    type="range"
                    min="2"
                    max="12"
                    step="1"
                    value={automaticPaletteColorCount}
                    onChange={(event) =>
                      setAutomaticPaletteColorCount(Number.parseInt(event.target.value, 10))
                    }
                  />
                </label>
                <button
                  className="action-button action-button-secondary automatic-palette-button"
                  type="button"
                  disabled={!hasOriginalImage}
                  onClick={() => onGenerateAutomaticPalette?.(automaticPaletteColorCount)}
                >
                  find palette
                </button>
                <p className="multicolor-mini-note">
                  Finds colors from the image inside the circle using OKLab clustering.
                </p>
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
                  Used by the preview, coverage, and string color fit.
                </p>
              </div>
            </div>
          </section>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>Coverage</h3>
              <p>Review the color split and line allocation.</p>
            </div>
            <div className="multicolor-lab-section-card">
              {shouldShowPaletteComparison && (
                <CollapsiblePanel
                  title="Preview comparison"
                  summary={isPaletteDitheringEnabled ? 'original, nearest, dithered' : 'original and nearest'}
                  isOpen={isLabPanelOpen('paletteComparison')}
                  onToggle={() => toggleLabPanel('paletteComparison')}
                >
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
                </CollapsiblePanel>
              )}

              <CollapsiblePanel
                title="Line allocation"
                summary={`${multicolorPaletteCoverage.length.toLocaleString()} colors`}
                isOpen={isLabPanelOpen('coverage')}
                onToggle={() => toggleLabPanel('coverage')}
              >
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
                    <StatsPanel
                      title="Coverage stats"
                      summary={`${(totalPaletteCoverageTenths / 10).toFixed(1)}% total`}
                      isOpen={isLabPanelOpen('coverageStats')}
                      onToggle={() => toggleLabPanel('coverageStats')}
                    >
                      <span className="multicolor-inline-stat">
                        Total {(totalPaletteCoverageTenths / 10).toFixed(1)}%
                      </span>
                      {hasSuggestedLineTarget && (
                        <span className="multicolor-inline-stat">
                          Split {totalAllocatedSuggestedLines.toLocaleString()} /{' '}
                          {multicolorTargetTotalLines.toLocaleString()}
                        </span>
                      )}
                    </StatsPanel>
                  </div>
                ) : (
                  <p className="multicolor-mini-note">
                    Load an image and enable a color to see coverage.
                  </p>
                )}
              </CollapsiblePanel>
            </div>
          </section>

          <section className="multicolor-lab-section">
            <div className="multicolor-lab-section-head">
              <h3>String fit</h3>
              <p>Choose which regions and fitted strings are visible.</p>
            </div>
            <div className="multicolor-lab-section-card">
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isTasPreviewEnabled}
                  onChange={(event) => setIsTasPreviewEnabled(event.target.checked)}
                  disabled={tasNetwork.regionCount === 0}
                />
                <span>Show geometry</span>
              </label>
              <div
                className="multicolor-debug-toggle-group"
                role="radiogroup"
                aria-label="Region view scope"
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
                  selected D
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
                  all enabled D
                </button>
              </div>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isTasOwnershipPreviewEnabled}
                  onChange={(event) => setIsTasOwnershipPreviewEnabled(event.target.checked)}
                  disabled={tasNetwork.regionCount === 0 || !hasOriginalImage}
                />
                <span>Show pixel ownership</span>
              </label>
              <label className="checkbox-row">
                <input
                  type="checkbox"
                  checked={isTasPaletteFitPreviewEnabled}
                  onChange={(event) => setIsTasPaletteFitPreviewEnabled(event.target.checked)}
                  disabled={tasNetwork.regionCount === 0 || !hasOriginalImage}
                />
                <span>Show color fit</span>
              </label>
              <div
                className="multicolor-debug-toggle-group"
                role="radiogroup"
                aria-label="String color fit mode"
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
                  palette colors
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
                  average color
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
                  A limit: {normalizedTasRegionChordLimitPercent.toFixed(0)}% area-weighted ={' '}
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
              <StatsPanel
                title="Region stats"
                summary={`${tasNetwork.regionCount.toLocaleString()} regions, ${tasNetwork.totalChords.toLocaleString()} chords`}
                isOpen={isLabPanelOpen('regionStats')}
                onToggle={() => toggleLabPanel('regionStats')}
              >
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
                    {selectedTasRegionAreaSharePercent !== null && (
                      <span className="multicolor-inline-stat">
                        Area share {selectedTasRegionAreaSharePercent.toFixed(1)}%
                      </span>
                    )}
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
              </StatsPanel>
              {tasPaletteFit && (
                <div className="tas-error-list">
                  <div className="tas-error-list-head">
                    <span className="multicolor-lab-label">Fitted strings</span>
                    {selectedTasRow && (
                      <span className="tas-error-selected">
                        selected {selectedTasRow.startNailNumber}-{selectedTasRow.endNailNumber}
                      </span>
                    )}
                  </div>
                  <CollapsiblePanel
                    title="Color lists"
                    summary={`${activeSameColorChordLists.length.toLocaleString()} colors`}
                    isOpen={isLabPanelOpen('sameColorLists')}
                    onToggle={() => toggleLabPanel('sameColorLists')}
                  >
                    <div className="tas-sccl-panel">
                    <div
                      className="multicolor-debug-toggle-group tas-sccl-scope-toggle"
                      role="group"
                      aria-label="Color-list scope"
                    >
                      {[
                        ['global', 'All regions'],
                        ['selected-region', `D${normalizedSelectedTasRegionIndex}`],
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
                      <span>Focus selected color</span>
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
                                {color.chordCount.toLocaleString()} strings
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
                        No active strings for this limit.
                      </p>
                    )}
                    {activeColorSameColorList && (
                      <CollapsiblePanel
                        title="Thread path"
                        summary={`${activeColorSameColorList.label}, ${activeColorChainPlan.connectorTransitions.toLocaleString()} gaps`}
                        isOpen={isLabPanelOpen('chain')}
                        onToggle={() => toggleLabPanel('chain')}
                      >
                      <div className="tas-chain-panel">
                        <div className="tas-chain-head">
                          <span className="multicolor-lab-label">
                            {effectiveScclScope === 'selected-region'
                              ? `D${normalizedSelectedTasRegionIndex} path`
                              : 'Selected color path'}
                          </span>
                          <span className="tas-error-selected">
                            {activeColorSameColorList.label}: {activeColorSameColorList.chordCount.toLocaleString()} strings
                          </span>
                        </div>
                        <StatsPanel
                          title="Path stats"
                          summary={`${activeColorChainPlan.connectorTransitions.toLocaleString()} connector gaps`}
                          isOpen={isLabPanelOpen('chainStats')}
                          onToggle={() => toggleLabPanel('chainStats')}
                        >
                          <span className="multicolor-inline-stat">
                            Region blocks {activeColorChainPlan.regionBlockCount.toLocaleString()}
                          </span>
                          <span className="multicolor-inline-stat">
                            Natural {activeColorChainPlan.continuousTransitions.toLocaleString()}
                          </span>
                          <span className="multicolor-inline-stat">
                            Gaps {activeColorChainPlan.connectorTransitions.toLocaleString()}
                          </span>
                        </StatsPanel>
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
                              <span>{row.needsConnector ? 'gap' : 'continuous'}</span>
                            </button>
                          ))}
                        </div>
                        {selectedConnectorGap && (
                          <div className="tas-connector-panel">
                            <div className="tas-chain-head">
                              <span className="multicolor-lab-label">Connector options</span>
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
                              Lower damage is preferred. Damage = length x error.
                            </p>
                            {connectorSearchSummary?.direct ? (
                              <button
                                className={[
                                  'tas-connector-row',
                                  connectorSearchSummary.direct.isClosestOuterCandidate ? 'is-closest-outer' : '',
                                ].filter(Boolean).join(' ')}
                                type="button"
                                title={`Connector chord: ${
                                  connectorSearchSummary.direct.legs[0]?.chordKey ??
                                  connectorSearchSummary.direct.key
                                }`}
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
                                  {connectorSearchSummary.direct.nailPath.join('-')}
                                </span>
                                <span>
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
                                No direct connector found.
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
                                    title={`Connector chords: ${candidate.legs.map((leg) => leg.chordKey).join(' + ')}`}
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
                                      {candidate.nailPath.join('-')}
                                    </span>
                                    <span>
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
                                  No outer connector path found.
                                </p>
                              )}
                          </div>
                        )}
                      </div>
                      </CollapsiblePanel>
                    )}
                  </div>
                  </CollapsiblePanel>
                  {globalWindingPreview.totalStepCount > 0 && (
                    <CollapsiblePanel
                      title="Drawing order"
                      summary={`${globalWindingPreview.totalStepCount.toLocaleString()} rows, ${globalWindingPreview.connectorCount.toLocaleString()} connectors`}
                      isOpen={isLabPanelOpen('globalOrder')}
                      onToggle={() => toggleLabPanel('globalOrder')}
                    >
                    <div className="tas-global-order-panel">
                      <div className="tas-chain-head">
                        <span className="multicolor-lab-label">Drawing order</span>
                        <span className="tas-chain-head-actions">
                          <button
                            className="final-plan-export-button"
                            type="button"
                            onClick={handleDownloadFinalPlan}
                          >
                            Export JSON
                          </button>
                          <span className="tas-error-selected">
                            first {Math.min(24, globalWindingPreview.totalStepCount).toLocaleString()} /{' '}
                            {globalWindingPreview.totalStepCount.toLocaleString()} rows
                          </span>
                        </span>
                      </div>
                      <StatsPanel
                        title="Plan totals"
                        summary={`${globalWindingPreview.perColorCounts.length.toLocaleString()} colors, ${globalWindingPreview.unresolvedGapCount.toLocaleString()} unresolved`}
                        isOpen={isLabPanelOpen('globalOrderStats')}
                        onToggle={() => toggleLabPanel('globalOrderStats')}
                      >
                        <span className="multicolor-inline-stat">
                          Connectors {globalWindingPreview.connectorCount.toLocaleString()}
                        </span>
                        <span className="multicolor-inline-stat">
                          Reused active {globalWindingPreview.consumedConnectorCount.toLocaleString()}
                        </span>
                        <span className="multicolor-inline-stat">
                          Deleted {globalWindingPreview.deletedCount.toLocaleString()}
                        </span>
                        <span className="multicolor-inline-stat">
                          Reserve conn {globalWindingPreview.reserveConnectorCount.toLocaleString()}
                        </span>
                        <span className="multicolor-inline-stat">
                          Reserve repl {globalWindingPreview.reserveReplacementCount.toLocaleString()}
                        </span>
                        <span className="multicolor-inline-stat">
                          Gaps {globalWindingPreview.unresolvedGapCount.toLocaleString()}
                        </span>
                        {globalWindingPreview.perColorCounts.slice(0, 6).map((color) => (
                          <span key={color.colorId} className="multicolor-inline-stat tas-global-order-stat">
                            <span
                              className="multicolor-palette-swatch"
                              style={{ backgroundColor: color.colorHex }}
                            />
                            {color.colorLabel} {color.count.toLocaleString()}
                          </span>
                        ))}
                      </StatsPanel>
                      <CollapsiblePanel
                        title="Per-D counts"
                        summary={`${globalWindingPreview.perRegionCounts.length.toLocaleString()} regions`}
                        isOpen={isLabPanelOpen('regionAccounting')}
                        onToggle={() => toggleLabPanel('regionAccounting')}
                      >
                        <div className="tas-region-accounting-table" role="table" aria-label="Per-D final drawing accounting">
                          <div className="tas-region-accounting-row is-header" role="row">
                            <span>D</span>
                            <span>Active</span>
                            <span>Normal</span>
                            <span>Connect</span>
                            <span>Reserve</span>
                            <span>Delete</span>
                            <span>Reuse</span>
                            <span>Final</span>
                            <span>Delta</span>
                            <span>Gaps</span>
                          </div>
                          {globalWindingPreview.perRegionCounts.slice(0, 32).map((regionCounts) => (
                            <div
                              key={`region-accounting-${regionCounts.regionIndex}`}
                              className={[
                                'tas-region-accounting-row',
                                regionCounts.finalDeltaFromActive !== 0 ? 'has-delta' : '',
                                regionCounts.unresolvedGapCount > 0 ? 'has-gap' : '',
                              ].filter(Boolean).join(' ')}
                              role="row"
                            >
                              <span>D{regionCounts.regionIndex}</span>
                              <span>{regionCounts.activeLimitCount.toLocaleString()}</span>
                              <span>{regionCounts.normalFinalCount.toLocaleString()}</span>
                              <span>{regionCounts.connectorCount.toLocaleString()}</span>
                              <span>{regionCounts.reserveCount.toLocaleString()}</span>
                              <span>{regionCounts.deletedCount.toLocaleString()}</span>
                              <span>{regionCounts.removedDuplicateCount.toLocaleString()}</span>
                              <span>{regionCounts.finalCount.toLocaleString()}</span>
                              <span>
                                {regionCounts.finalDeltaFromActive > 0 ? '+' : ''}
                                {regionCounts.finalDeltaFromActive.toLocaleString()}
                              </span>
                              <span>{regionCounts.unresolvedGapCount.toLocaleString()}</span>
                            </div>
                          ))}
                        </div>
                      </CollapsiblePanel>
                      {globalWindingPreview.unresolvedGaps.length > 0 && (
                        <CollapsiblePanel
                          title="Remaining gaps"
                          summary={`${globalWindingPreview.unresolvedGaps.length.toLocaleString()} gaps`}
                          isOpen={isLabPanelOpen('unresolvedGaps')}
                          onToggle={() => toggleLabPanel('unresolvedGaps')}
                        >
                          <div className="tas-unresolved-gap-list">
                            {globalWindingPreview.unresolvedGaps.slice(0, 24).map((gap, index) => (
                              <button
                                key={`unresolved-${gap.colorId}-${gap.nextChordKey}-${index}`}
                                className="tas-unresolved-gap-row"
                                type="button"
                                onClick={() => {
                                  setTasViewScope('all');
                                  setActivePaletteColorId(gap.colorId);
                                  setSelectedTasChordKey(gap.nextChordKey);
                                  setSelectedChainChordKeys(
                                    getPreviewChordKeys(gap.previousChordKey, gap.nextChordKey),
                                  );
                                  setSelectedConnectorGapChordKey(gap.nextChordKey);
                                  setSelectedConnectorChordKeys([]);
                                }}
                              >
                                <span>#{index + 1}</span>
                                <span className="tas-global-order-color">
                                  <span
                                    className="multicolor-palette-swatch"
                                    style={{ backgroundColor: gap.colorHex }}
                                  />
                                  {gap.colorLabel}
                                </span>
                                <span>
                                  {gap.previousFromNailNumber}-{gap.previousToNailNumber}
                                  {' -> '}
                                  {gap.nextFromNailNumber}-{gap.nextToNailNumber}
                                </span>
                                <span>D{gap.regionIndex}</span>
                                <span>{gap.fromNailNumber}-{gap.toNailNumber}</span>
                              </button>
                            ))}
                          </div>
                        </CollapsiblePanel>
                      )}
                      <div className="tas-global-order-list">
                        {globalWindingPreview.steps.slice(0, 24).map((step) => (
                          <button
                            key={`global-order-${step.stepNumber}-${step.chordKey}`}
                            className={[
                              'tas-global-order-row',
                              step.isGeneratedConnector ? 'is-connector' : '',
                              step.isReserveReplacement ? 'is-reserve-replacement' : '',
                              step.chordKey === selectedTasChordKey ? 'is-selected' : '',
                            ].filter(Boolean).join(' ')}
                            type="button"
                            onClick={() => {
                              setTasViewScope('all');
                              setActivePaletteColorId(step.colorId);
                              setSelectedTasChordKey(step.chordKey);
                              setSelectedChainChordKeys(
                                step.isGeneratedConnector ? [] : getPreviewChordKeys(step.chordKey),
                              );
                              setSelectedConnectorGapChordKey(null);
                              setSelectedConnectorChordKeys(
                                step.isGeneratedConnector ? getPreviewChordKeys(step.chordKey) : [],
                              );
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
                            <span>
                              {step.isGeneratedConnector ? 'conn ' : ''}
                              {step.isReserveReplacement ? 'reserve ' : ''}
                              {step.drawFromNailNumber}-{step.drawToNailNumber}
                            </span>
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
                    </CollapsiblePanel>
                  )}
                  <CollapsiblePanel
                    title={`D${normalizedSelectedTasRegionIndex} error table`}
                    summary={`${selectedRegionTasRows.length.toLocaleString()} strings`}
                    isOpen={isLabPanelOpen('errorOrder')}
                    onToggle={() => toggleLabPanel('errorOrder')}
                  >
                  <div className="tas-error-table" role="table" aria-label="Selected region string error order">
                    <div className="tas-error-row is-header" role="row">
                      <span>Rank</span>
                      <span>Chord</span>
                      <span>Color</span>
                      <span>Pixels</span>
                      <span>Error</span>
                      <span>Active</span>
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
                      <div className="tas-error-divider">best fit</div>
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
                  </CollapsiblePanel>
                </div>
              )}
              <CollapsiblePanel
                title="Geometry notes"
                summary="geometry and limit rules"
                isOpen={isLabPanelOpen('tasNotes')}
                onToggle={() => toggleLabPanel('tasNotes')}
              >
                <p className="multicolor-mini-note">
                  Pixel ownership assigns each image pixel to one nearby string segment.
                  The D slider selects a ring, and min distance disables outer rings whose nail span is too short.
                  The A limit is a global chord budget distributed by ring area.
                  For a quick geometry check, set nails to 10: D0 should show 5 diameter strings,
                  and D1-D4 should show 10 strings each.
                </p>
              </CollapsiblePanel>
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

export default MulticolorLab;
