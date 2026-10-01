// ============================================================
// SHARED HELPERS
// ============================================================

// Computes a per-cell baseline (mean across a given year range) from
// a {years: [...], values: [[...], ...]} object like your exported JSON.
function computeBaseline(data, baselineStart, baselineEnd) {
    const baselineIndices = data.years
        .map((year, i) => ({ year, i }))
        .filter(d => d.year >= baselineStart && d.year <= baselineEnd)
        .map(d => d.i);

    const numCells = data.values[0].length;
    const baseline = new Array(numCells).fill(0);

    for (let cell = 0; cell < numCells; cell++) {
        let sum = 0;
        let count = 0;
        for (const yearIndex of baselineIndices) {
            const v = data.values[yearIndex][cell];
            if (v !== null && !Number.isNaN(v)) {
                sum += v;
                count++;
            }
        }
        baseline[cell] = count > 0 ? sum / count : null;
    }

    return baseline;
}

// Subtracts a precomputed baseline from every year in a data object,
// returning a new {years, values} object of anomalies.
function computeAnomalies(data, baseline) {
    const anomalyValues = data.values.map(yearArray =>
        yearArray.map((v, cell) => {
            if (v === null || Number.isNaN(v) || baseline[cell] === null) return null;
            return v - baseline[cell];
        })
    );

    return { years: data.years, values: anomalyValues };
}

// Compute cell width/height + projected coords for any projection/coords pair.
function computeGridGeometry(coords, projection) {
    const lats = [...new Set(coords.map(d => d.lat))].sort((a, b) => a - b);
    const latResDeg = lats[1] - lats[0];
    const lons = [...new Set(coords.map(d => d.lon))].sort((a, b) => a - b);
    const gridResDeg = lons[1] - lons[0];

    const refLat = lats[Math.floor(lats.length / 2)];
    const refLon = lons[Math.floor(lons.length / 2)];

    const pCenter = projection([refLon, refLat]);
    const pRight = projection([refLon + gridResDeg, refLat]);
    const pUp = projection([refLon, refLat + latResDeg]);

    const cellWidth = Math.abs(pRight[0] - pCenter[0]);
    const cellHeight = Math.abs(pUp[1] - pCenter[1]);
    const projected = coords.map(d => projection([d.lon, d.lat]));

    return { cellWidth, cellHeight, projected };
}

function buildDivergingColorScale(values, interpolator, reverseDomain = true) {
    const clean = values.filter(v => v !== null);
    const maxAbs = d3.max(clean, v => Math.abs(v));
    const domain = reverseDomain ? [maxAbs, -maxAbs] : [-maxAbs, maxAbs];
    const scale = d3.scaleSequential(interpolator).domain(domain);
    return { scale, maxAbs };
}

async function loadVariableTimeline(variable, interpolator, reverseDomain = true) {
    const historical = await d3.json(`./website_data/${variable}_historical.json`);
    const ssp245 = await d3.json(`./website_data/${variable}_ssp245.json`);
    const ssp585 = await d3.json(`./website_data/${variable}_ssp585.json`);

    const baseline = computeBaseline(historical, 1951, 1980);
    const ssp245Anomalies = computeAnomalies(ssp245, baseline);
    const ssp585Anomalies = computeAnomalies(ssp585, baseline);

    const combined = [...ssp245Anomalies.values.flat(), ...ssp585Anomalies.values.flat()];
    const { scale, maxAbs } = buildDivergingColorScale(combined, interpolator, reverseDomain);

    return { ssp245Anomalies, ssp585Anomalies, colorScale: scale, maxAbs };
}

function createMapOverlay(containerSelector) {
    const container = d3.select(containerSelector);
    const overlay = container.append("div").attr("class", "map-overlay");
    const yearLabel = overlay.append("div").attr("class", "year-label");
    const legendContainer = overlay.append("div").attr("class", "legend");
    return { yearLabel, legendContainer };
}

function createLegend(legendContainer, colorScale, maxAbs, unitLabel, decimals = 0) {
    const legendWidth = 500;   // was 180 — legend has the full width available, so use it
    const legendHeight = 16;   // slightly taller to match the wider bar

    legendContainer.selectAll("*").remove();

    legendContainer.append("div")
        .attr("class", "legend-title")
        .text(`Δ ${unitLabel} vs 1951–1980 avg`);

    const legendSvg = legendContainer.append("svg")
        .attr("width", legendWidth)
        .attr("height", legendHeight + 24); // a bit more room for 9 tick labels

    const gradientId = "legend-gradient-" + Math.random().toString(36).slice(2);
    const defs = legendSvg.append("defs");
    const gradient = defs.append("linearGradient")
        .attr("id", gradientId)
        .attr("x1", "0%").attr("x2", "100%")
        .attr("y1", "0%").attr("y2", "0%");

    const numStops = 20; // more stops = smoother gradient over the wider bar
    d3.range(numStops + 1).forEach(i => {
        const value = -maxAbs + (i / numStops) * (2 * maxAbs);
        gradient.append("stop")
            .attr("offset", `${(i / numStops) * 100}%`)
            .attr("stop-color", colorScale(value));
    });

    legendSvg.append("rect")
        .attr("width", legendWidth)
        .attr("height", legendHeight)
        .attr("fill", `url(#${gradientId})`);

    const legendScale = d3.scaleLinear().domain([-maxAbs, maxAbs]).range([0, legendWidth]);
    const legendAxis = d3.axisBottom(legendScale).ticks(9).tickFormat(d3.format(`+.${decimals}f`));

    legendSvg.append("g")
        .attr("transform", `translate(0, ${legendHeight})`)
        .call(legendAxis)
        .call(g => g.selectAll("text").attr("fill", "#e8e6e1"))
        .call(g => g.selectAll("line, path").attr("stroke", "#e8e6e1"));
}

const variableUnits = { tasmax: "°F", pr: "inches", sfcWind: "mph" };
const variableDecimals = { tasmax: 0, pr: 1, sfcWind: 2 };

// ============================================================
// FUTURE SECTION — dual maps (SSP245 / SSP585), 2015–2100
// ============================================================

const scrollySegments = [
    { variable: "tasmax", label: "Maximum Temperature", startYear: 2015, endYear: 2035, interpolator: d3.interpolateRdBu, reverseDomain: true },
    { variable: "pr",     label: "Precipitation",       startYear: 2035, endYear: 2055, interpolator: d3.interpolateBrBG, reverseDomain: true },
    { variable: "sfcWind",label: "Wind Speed",          startYear: 2055, endYear: 2075, interpolator: d3.interpolatePuOr, reverseDomain: false },
    { variable: "tasmax", label: "Maximum Temperature", startYear: 2075, endYear: 2100, interpolator: d3.interpolateRdBu, reverseDomain: true }
];

const futureMargin = { top: 30, right: 20, bottom: 30, left: 20 };

const futureContainer = d3.select(".future-map");
const { width: futureWidth, height: futureHeight } = futureContainer.node().getBoundingClientRect();
const halfWidth = futureWidth / 2;
const innerHalfWidth = halfWidth - futureMargin.left - futureMargin.right;
const innerFutureHeight = futureHeight - futureMargin.top - futureMargin.bottom;

const futureProjection = d3.geoAlbersUsa();

const svgLeft = d3.select(".map-left").append("svg").attr("width", halfWidth).attr("height", futureHeight);
const svgRight = d3.select(".map-right").append("svg").attr("width", halfWidth).attr("height", futureHeight);

// Each side: grid layer first, outline layer second (drawn on top), so outlines stay visible
const gLeftGrid = svgLeft.append("g").attr("transform", `translate(${futureMargin.left},${futureMargin.top})`);
const gLeftOutline = svgLeft.append("g").attr("transform", `translate(${futureMargin.left},${futureMargin.top})`);
const gRightGrid = svgRight.append("g").attr("transform", `translate(${futureMargin.left},${futureMargin.top})`);
const gRightOutline = svgRight.append("g").attr("transform", `translate(${futureMargin.left},${futureMargin.top})`);

const { yearLabel: futureYearLabel, legendContainer: futureLegendContainer } =
    createMapOverlay(".future-map");

let futureGridCells = { left: null, right: null };
let futureGridGeometry = null;
let variableCache = {};
let lastDrawnSegmentVariable = null;
let lastDrawnFutureYear = null;

const setupFutureMap = async function () {
    const stateOutlines = await d3.json("./website_data/midwest_states.geojson");
    const coords = await d3.json("./website_data/lat_long.json");

    futureProjection.fitSize([innerHalfWidth, innerFutureHeight], stateOutlines);
    futureGridGeometry = computeGridGeometry(coords, futureProjection);

    const futurePath = d3.geoPath(futureProjection);

    [gLeftOutline, gRightOutline].forEach(g => {
        g.selectAll("path.state")
            .data(stateOutlines.features)
            .join("path")
            .attr("class", "state")
            .attr("d", futurePath)
            .attr("fill", "none")
            .attr("stroke", "black")
            .attr("stroke-width", 0.5);
    });

    futureGridCells.left = gLeftGrid.selectAll("rect.grid-cell")
        .data(futureGridGeometry.projected)
        .join("rect")
        .attr("class", "grid-cell")
        .attr("x", d => d[0] - futureGridGeometry.cellWidth / 2)
        .attr("y", d => d[1] - futureGridGeometry.cellHeight / 2)
        .attr("width", futureGridGeometry.cellWidth * 1.08)
        .attr("height", futureGridGeometry.cellHeight * 1.08)
        .attr("fill", "none");

    futureGridCells.right = gRightGrid.selectAll("rect.grid-cell")
        .data(futureGridGeometry.projected)
        .join("rect")
        .attr("class", "grid-cell")
        .attr("x", d => d[0] - futureGridGeometry.cellWidth / 2)
        .attr("y", d => d[1] - futureGridGeometry.cellHeight / 2)
        .attr("width", futureGridGeometry.cellWidth * 1.08)
        .attr("height", futureGridGeometry.cellHeight * 1.08)
        .attr("fill", "none");

    // Preload all three unique variables up front, so segment switches never trigger a fetch mid-scroll
    const uniqueVariables = [...new Map(scrollySegments.map(s => [s.variable, s])).values()];
    await Promise.all(uniqueVariables.map(async seg => {
        variableCache[seg.variable] = await loadVariableTimeline(seg.variable, seg.interpolator, seg.reverseDomain);
    }));
};
setupFutureMap();

function updateFutureMaps(variable, year) {
    const data = variableCache[variable];
    if (!data || !futureGridCells.left) return;
    if (variable === lastDrawnSegmentVariable && year === lastDrawnFutureYear) return;

    const leftIndex = data.ssp245Anomalies.years.indexOf(year);
    const rightIndex = data.ssp585Anomalies.years.indexOf(year);
    if (leftIndex === -1 || rightIndex === -1) {
        console.error("Year not found for", variable, year);
        return;
    }

    const leftValues = data.ssp245Anomalies.values[leftIndex];
    const rightValues = data.ssp585Anomalies.values[rightIndex];

    futureGridCells.left.attr("fill", (d, i) => leftValues[i] === null ? "none" : data.colorScale(leftValues[i]));
    futureGridCells.right.attr("fill", (d, i) => rightValues[i] === null ? "none" : data.colorScale(rightValues[i]));

    // Legend only needs to redraw when the variable actually changes, not every scroll tick
    if (variable !== lastDrawnSegmentVariable) {
        createLegend(futureLegendContainer, data.colorScale, data.maxAbs, variableUnits[variable] || "", variableDecimals[variable] ?? 0);
    }
    futureYearLabel.text(year);

    lastDrawnSegmentVariable = variable;
    lastDrawnFutureYear = year;
}

function yearForSegment(segment, progress) {
    return Math.round(segment.startYear + (segment.endYear - segment.startYear) * progress);
}

const futureScroller = scrollama();
futureScroller
    .setup({
        step: ".future-step",
        offset: 0.5,
        progress: true
    })
    .onStepProgress((response) => {
        const segmentIndex = +response.element.dataset.segment;
        const segment = scrollySegments[segmentIndex];
        const year = yearForSegment(segment, response.progress);
        updateFutureMaps(segment.variable, year);
    });