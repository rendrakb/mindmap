/**
 * app.js — Mind Map Viewer
 *
 * Responsibilities (in order):
 *   1. DOM references & application state
 *   2. Utility helpers (text, geometry, layout)
 *   3. Data / file I/O
 *   4. D3 rendering & interaction
 *   5. SVG export
 *   6. Initialisation (IIFE at the bottom)
 */

"use strict";

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_FILES = ["02.json"];

/** Layout constants for the tree diagram. */
const LAYOUT = Object.freeze({
  margin: { top: 12, right: 80, bottom: 48, left: 160 },
  columnGap: 52,
  minColumnWidth: 96,
  lineHeight: 26,
  minVerticalGap: 52,
  maxLabelChars: 34,
  labelOffsetX: 44,
  labelPadX: 24,
  searchIconX: 24,
});

/** Visual tokens for node colours. */
const COLORS = Object.freeze({
  rootFill: "#7c9fff",
  collapsedFill: "#7c9fff",
  leafFill: "rgba(124, 159, 255, 0.92)",
  matchFill: "#8cffc7",
  defaultStroke: "rgba(255,255,255,0.24)",
  matchStroke: "#ffffff",
  labelDefault: "#eef3ff",
  labelMatch: "#05070d",
  linkStroke: "rgba(255,255,255,0.2)",
  nodeBgDefault: "rgba(8, 12, 22, 0.72)",
  nodeBgMatch: "rgba(140, 255, 199, 0.18)",
  nodeBgBorderDefault: "rgba(255, 255, 255, 0.08)",
  nodeBgBorderMatch: "rgba(140, 255, 199, 0.55)",
  gradientStart: "#8cffc7",
  gradientEnd: "#7c9fff",
  watermark: "rgba(255,255,255,0.18)",
});

const ZOOM_EXTENT = [0.15, 10];
const EXPORT_PADDING = 60;
const WATERMARK_TEXT = "rendrakb.github.io/mindmap";

// ─── DOM References ───────────────────────────────────────────────────────────

const DOM = {
  fileSelect: document.getElementById("fileSelect"),
  loadButton: document.getElementById("loadButton"),
  downloadJsonButton: document.getElementById("downloadJsonButton"),
  uploadJsonButton: document.getElementById("uploadJsonButton"),
  uploadInput: document.getElementById("uploadInput"),
  backButton: document.getElementById("backButton"),
  landing: document.getElementById("landing"),
  viewer: document.getElementById("viewer"),
  chartTitle: document.getElementById("chartTitle"),
  chartSubtitle: document.getElementById("chartSubtitle"),
  nodeInfo: document.getElementById("nodeInfo"),
  zoomInButton: document.getElementById("zoomInButton"),
  zoomOutButton: document.getElementById("zoomOutButton"),
  resetZoomButton: document.getElementById("resetZoomButton"),
  chartContainer: document.getElementById("chart"),
  openSvgButton: document.getElementById("openSvgButton"),
  saveSvgButton: document.getElementById("saveSvgButton"),
  expandAllButton: document.getElementById("expandAllButton"),
  collapseAllButton: document.getElementById("collapseAllButton"),
  searchInput: document.getElementById("searchInput"),
};

// ─── Application State ────────────────────────────────────────────────────────

/**
 * Chart-scoped callbacks, replaced whenever a new tree is rendered.
 * Using an object avoids scattered mutable globals.
 */
const chartCallbacks = {
  /** @type {((duration?: number) => Promise<void>) | null} */
  resetZoom: null,
  /** @type {(() => void) | null} */
  collapseAll: null,
  /** @type {(() => void) | null} */
  expandAll: null,
  /** @type {((fn: () => void) => Promise<void>) | null} */
  export: null,
  /** @type {((query: string) => void) | null} */
  highlightMatches: null,
};

/** @type {d3.HierarchyNode | null} */
let currentRoot = null;
let searchQuery = "";

// ─── Utility ──────────────────────────────────────────────────────────────────

/**
 * Normalise a value to a trimmed, lower-cased string for search comparisons.
 * @param {unknown} value
 * @returns {string}
 */
function normalizeText(value) {
  return (value ?? "").toString().trim().toLowerCase();
}

/**
 * Return a Promise that resolves after two animation frames, long enough for
 * the browser to finish a layout pass.
 * @returns {Promise<void>}
 */
function waitForLayout() {
  return new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );
}

/**
 * Wrap a title string into multiple lines, each no longer than `maxChars`.
 * @param {string} title
 * @param {number} [maxChars]
 * @returns {{ lines: string[], lineCount: number }}
 */
function wrapLabel(title, maxChars = LAYOUT.maxLabelChars) {
  const words = (title ?? "").toString().split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [""], lineCount: 1 };

  const lines = [];
  let current = [];

  for (const word of words) {
    const candidate = current.length ? `${current.join(" ")} ${word}` : word;
    if (candidate.length > maxChars && current.length) {
      lines.push(current.join(" "));
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length) lines.push(current.join(" "));

  return { lines, lineCount: lines.length };
}

// ─── Tree-state Helpers ───────────────────────────────────────────────────────

/**
 * Snapshot the expand/collapse state of every node in a hierarchy so it can
 * be restored after a temporary full-expand (e.g. for SVG export).
 * @param {d3.HierarchyNode} root
 * @returns {Map<number, { children: d3.HierarchyNode[] | null, _children: d3.HierarchyNode[] | null }>}
 */
function snapshotTreeState(root) {
  const snapshot = new Map();
  root.each((d) => {
    snapshot.set(d.id, { children: d.children, _children: d._children });
  });
  return snapshot;
}

/**
 * Restore a previously captured tree-state snapshot.
 * @param {d3.HierarchyNode} root
 * @param {ReturnType<typeof snapshotTreeState>} snapshot
 */
function restoreTreeState(root, snapshot) {
  root.each((d) => {
    const saved = snapshot.get(d.id);
    if (saved) {
      d.children = saved.children;
      d._children = saved._children;
    }
  });
}

// ─── Layout Calculations ──────────────────────────────────────────────────────

/**
 * Font size (px) for node labels, decreasing slightly with depth.
 * @param {number} depth
 * @returns {number}
 */
function labelFontSize(depth) {
  return Math.max(13, 16.5 - depth * 0.45);
}

/**
 * Estimate the pixel width a node label will occupy.
 * @param {d3.HierarchyNode} d
 * @returns {number}
 */
function estimateLabelWidth(d) {
  const lines = d.data._labelLines ?? [""];
  const charWidth = labelFontSize(d.depth) * 0.58;
  const textWidth = d3.max(lines, (line) => line.length * charWidth) ?? 0;
  return LAYOUT.labelOffsetX + textWidth + LAYOUT.labelPadX;
}

/**
 * Pre-compute and cache label metrics on every node in the hierarchy.
 * Mutates `d.data` — call once per render cycle.
 * @param {d3.HierarchyNode} root
 */
function prepareNodeLabels(root) {
  root.each((d) => {
    const wrapped = wrapLabel(d.data?.title);
    d.data._labelLines = wrapped.lines;
    d.data._lineCount = wrapped.lineCount;
    d.data._labelWidth = estimateLabelWidth(d);
  });
}

/**
 * Assign horizontal (y) positions to each depth column so that label text
 * never overlaps the next column.
 * @param {d3.HierarchyNode} root
 */
function assignColumnPositions(root) {
  const nodes = root.descendants();
  const maxDepth = d3.max(nodes, (d) => d.depth) ?? 0;
  const byDepth = d3.group(nodes, (d) => d.depth);
  let columnStart = 0;

  for (let depth = 0; depth <= maxDepth; depth++) {
    const columnNodes = byDepth.get(depth) ?? [];
    columnNodes.forEach((d) => {
      d.y = columnStart;
    });

    if (depth < maxDepth) {
      const maxLabelWidth =
        d3.max(
          columnNodes,
          (d) => d.data._labelWidth ?? estimateLabelWidth(d),
        ) ?? LAYOUT.minColumnWidth;
      columnStart +=
        Math.max(LAYOUT.minColumnWidth, maxLabelWidth) + LAYOUT.columnGap;
    }
  }
}

/**
 * Separation function passed to `d3.tree().separation()`.
 * Increases space between nodes that don't share a parent, and for multi-line
 * labels.
 * @param {d3.HierarchyNode} a
 * @param {d3.HierarchyNode} b
 * @returns {number}
 */
function nodeSeparation(a, b) {
  const siblingFactor = a.parent === b.parent ? 1.15 : 1.75;
  const lineFactor = Math.max(
    1,
    ((a.data._lineCount ?? 1) + (b.data._lineCount ?? 1)) / 2,
  );
  return siblingFactor * lineFactor;
}

/**
 * Compute overall SVG dimensions from the current tree layout.
 * @param {d3.HierarchyNode} root
 * @param {{ top: number, right: number, bottom: number, left: number }} [margin]
 * @returns {{ width: number, height: number, xMin: number, xMax: number, nodes: d3.HierarchyNode[] }}
 */
function computeChartDimensions(root, margin = LAYOUT.margin) {
  const nodes = root.descendants();
  const xMin = d3.min(nodes, (d) => d.x) ?? 0;
  const xMax = d3.max(nodes, (d) => d.x) ?? 0;
  const yMax = d3.max(nodes, (d) => d.y) ?? 0;
  const maxDepth = d3.max(nodes, (d) => d.depth) ?? 0;
  const maxLineCount = d3.max(nodes, (d) => d.data._lineCount ?? 1) ?? 1;
  const lastColumnNodes = nodes.filter((d) => d.depth === maxDepth);
  const trailingLabel =
    d3.max(
      lastColumnNodes,
      (d) => d.data._labelWidth ?? estimateLabelWidth(d),
    ) ?? LAYOUT.minColumnWidth;

  const verticalSpan = Math.max(LAYOUT.minVerticalGap, xMax - xMin);
  const height =
    verticalSpan + margin.top + margin.bottom + maxLineCount * 6 + 24;
  const width = margin.left + margin.right + yMax + trailingLabel + 32;

  return { width, height, xMin, xMax, nodes };
}

/**
 * Compute a `d3.ZoomTransform` that fits the entire content group inside the
 * SVG viewport with optional padding.
 * @param {SVGSVGElement} svgElement
 * @param {d3.ZoomBehavior} zoomBehavior
 * @param {d3.Selection} contentGroup
 * @param {number} [padding]
 * @returns {d3.ZoomTransform}
 */
function computeFitZoomTransform(
  svgElement,
  zoomBehavior,
  contentGroup,
  padding = 48,
) {
  const viewBox = svgElement.viewBox.baseVal;
  const vbWidth = viewBox.width || svgElement.clientWidth || 1;
  const vbHeight = viewBox.height || svgElement.clientHeight || 1;
  const bounds = contentGroup.node().getBBox();
  const matrix = contentGroup.node().transform.baseVal.consolidate();
  const tx = matrix?.matrix?.e ?? 0;
  const ty = matrix?.matrix?.f ?? 0;
  const x0 = bounds.x + tx;
  const y0 = bounds.y + ty;
  const dx = bounds.width;
  const dy = bounds.height;

  if (dx <= 0 || dy <= 0) return d3.zoomIdentity;

  const [minScale, maxScale] = zoomBehavior.scaleExtent();
  const scale = Math.min(
    maxScale,
    Math.max(
      minScale,
      Math.min((vbWidth - padding * 2) / dx, (vbHeight - padding * 2) / dy),
    ),
  );

  const cx = x0 + dx / 2;
  const cy = y0 + dy / 2;
  return d3.zoomIdentity
    .translate(vbWidth / 2, vbHeight / 2)
    .scale(scale)
    .translate(-cx, -cy);
}

// ─── D3 Rendering ─────────────────────────────────────────────────────────────

/**
 * Apply multi-line tspan elements to a text selection based on cached
 * `_labelLines` data.
 * @param {d3.Selection} selection
 */
function applyLabelText(selection) {
  selection.each(function (d) {
    const el = d3.select(this);
    const lines = d.data._labelLines ?? [d.data?.title ?? ""];
    el.selectAll("tspan").remove();
    el.text(null);
    lines.forEach((line, index) => {
      el.append("tspan")
        .text(line)
        .attr("x", LAYOUT.labelOffsetX)
        .attr("dy", index ? "1.35em" : 0);
    });
  });
}

/**
 * Insert (or update) a background `<rect>` behind each node's label text so
 * it remains legible against dense edges.
 * @param {d3.Selection} selection — a selection of `<g.node>` elements
 */
function syncLabelBackgrounds(selection) {
  const PAD_X = 10;
  const PAD_Y = 6;
  selection.each(function () {
    const group = d3.select(this);
    const labelNode = group.select("text.node-label").node();
    if (!labelNode) return;
    const bbox = labelNode.getBBox();
    const existing = group.select("rect.node-bg");
    (existing.empty() ? group.insert("rect", "circle") : existing)
      .attr("class", "node-bg")
      .attr("x", bbox.x - PAD_X)
      .attr("y", bbox.y - PAD_Y)
      .attr("width", Math.max(0, bbox.width + PAD_X * 2))
      .attr("height", Math.max(0, bbox.height + PAD_Y * 2))
      .attr("rx", 8);
  });
}

/**
 * Determine the fill colour for a node circle based on its state.
 * @param {d3.HierarchyNode} d
 * @returns {string}
 */
function nodeCircleFill(d) {
  if (d.match) return COLORS.matchFill;
  if (d._children || d.depth === 0) return COLORS.rootFill;
  return COLORS.leafFill;
}

/**
 * Render (or re-render) the full mind-map tree into `DOM.chartContainer`.
 * Sets up zoom, search highlighting, and all chart-scoped callbacks.
 * @param {object} data — hierarchy-compatible JSON (must have `title` and optionally `children`)
 */
function renderMindMap(data) {
  DOM.chartContainer.innerHTML = "";

  const margin = LAYOUT.margin;
  const root = d3.hierarchy(data);

  // Cache collapsed children on every node at startup
  root.each((d) => {
    if (d.children) d._children = d.children;
  });

  prepareNodeLabels(root);

  const treeLayout = d3
    .tree()
    .nodeSize([LAYOUT.lineHeight, 1])
    .separation(nodeSeparation);
  treeLayout(root);
  assignColumnPositions(root);

  let { width, height, xMin } = computeChartDimensions(root, margin);

  // ── Container sizing ──

  function setChartContainerHeight(rawHeight) {
    const maxPx = (window.innerHeight * 90) / 100;
    DOM.chartContainer.style.height = `${Math.max(380, Math.min(rawHeight, maxPx))}px`;
  }
  setChartContainerHeight(height);

  // ── SVG scaffold ──

  const svg = d3
    .select(DOM.chartContainer)
    .append("svg")
    .attr("viewBox", [0, 0, width, height])
    .style("font", "15px Inter, sans-serif")
    .style("touch-action", "none")
    .style("cursor", "grab")
    .style("user-select", "none");

  // Transparent hit-target for pan/zoom gestures
  svg
    .append("rect")
    .attr("width", width)
    .attr("height", height)
    .attr("fill", "transparent")
    .attr("pointer-events", "all")
    .style("touch-action", "none");

  const zoomGroup = svg.append("g");
  const g = zoomGroup
    .append("g")
    .attr("transform", `translate(${margin.left},${margin.top - xMin})`);

  // Stable node IDs for D3's key function
  let nodeId = 0;
  root.each((d) => {
    d.id = d.id ?? ++nodeId;
  });

  const linkGroup = g.append("g").attr("class", "links");
  const nodeGroup = g.append("g").attr("class", "nodes");

  // ── Zoom behaviour ──

  const zoomBehavior = d3
    .zoom()
    .scaleExtent(ZOOM_EXTENT)
    .on("zoom", (event) => zoomGroup.attr("transform", event.transform));

  svg.call(zoomBehavior);

  // ── Defs: gradient + glow filter ──

  const defs = svg.append("defs");

  defs
    .append("linearGradient")
    .attr("id", "match-gradient")
    .attr("x1", "0%")
    .attr("y1", "0%")
    .attr("x2", "100%")
    .attr("y2", "0%")
    .selectAll("stop")
    .data([
      { offset: "0%", color: COLORS.gradientStart },
      { offset: "100%", color: COLORS.gradientEnd },
    ])
    .join("stop")
    .attr("offset", (d) => d.offset)
    .attr("stop-color", (d) => d.color);

  const glowFilter = defs.append("filter").attr("id", "match-glow");
  glowFilter
    .append("feGaussianBlur")
    .attr("in", "SourceGraphic")
    .attr("stdDeviation", 1.2)
    .attr("result", "blur");
  glowFilter
    .append("feMerge")
    .selectAll("feMergeNode")
    .data(["blur", "SourceGraphic"])
    .join("feMergeNode")
    .attr("in", (d) => d);

  // ── Tree traversal helpers ──

  function collapse(d) {
    if (d.children) {
      d._children = d.children;
      d._children.forEach(collapse);
      d.children = null;
    }
  }

  function expand(d) {
    if (d._children) {
      d.children = d._children;
      d._children = null;
    }
    d.children?.forEach(expand);
  }

  function expandToDepth(d, maxDepth) {
    if (d._children && d.depth < maxDepth) {
      d.children = d._children;
      d._children = null;
    }
    d.children?.forEach((child) => expandToDepth(child, maxDepth));
  }

  function toggle(d) {
    if (d.children) {
      d._children = d.children;
      d.children = null;
    } else {
      d.children = d._children;
      d._children = null;
    }
  }

  // ── Resize helper (called on every update) ──

  function resizeChart() {
    const dims = computeChartDimensions(root, margin);
    width = dims.width;
    height = dims.height;
    xMin = dims.xMin;
    setChartContainerHeight(height);
    svg.attr("viewBox", [0, 0, width, height]);
    svg.select("rect").attr("width", width).attr("height", height);
    g.attr("transform", `translate(${margin.left},${margin.top - xMin})`);
  }

  // ── Search-icon Google query builder ──

  function buildSearchQuery(node) {
    const ancestry = node
      .ancestors()
      .map((item) => item.data.title)
      .filter(Boolean);
    return encodeURIComponent(ancestry.join(", "));
  }

  // ── Core update function ──

  /**
   * Re-render nodes and links based on the current tree state.
   * @param {d3.HierarchyNode} source — the node that triggered the update (used as animation origin)
   * @param {{ animate?: boolean }} [options]
   */
  function update(source, options = {}) {
    const animate = options.animate !== false;
    treeLayout(root);
    assignColumnPositions(root);
    resizeChart();

    const nodes = root.descendants();
    const links = root.links();
    const linkPath = d3
      .linkHorizontal()
      .x((d) => d.y)
      .y((d) => d.x);

    // ── Links ──
    const link = linkGroup
      .selectAll("path.link")
      .data(links, (d) => d.target.id);

    const linkUpdate = link
      .enter()
      .append("path")
      .attr("class", "link")
      .attr("fill", "none")
      .attr("stroke", COLORS.linkStroke)
      .attr("stroke-width", 1.6)
      .attr("d", () => {
        const o = { x: source.x0, y: source.y0 };
        return linkPath({ source: o, target: o });
      })
      .merge(link);

    (animate ? linkUpdate.transition().duration(250) : linkUpdate).attr(
      "d",
      linkPath,
    );
    link.exit().remove();

    // ── Nodes ──
    const node = nodeGroup.selectAll("g.node").data(nodes, (d) => d.id);

    const nodeEnter = node
      .enter()
      .append("g")
      .attr("class", "node")
      .attr("transform", () => `translate(${source.y0},${source.x0})`)
      .style("cursor", "pointer")
      .on("click", (event, d) => {
        if (event.defaultPrevented) return;
        toggle(d);
        update(d);
      });

    nodeEnter
      .append("circle")
      .attr("r", (d) => (d.depth === 0 ? 14 : 8))
      .attr("fill", nodeCircleFill)
      .attr("stroke", COLORS.defaultStroke)
      .attr("stroke-width", 1.5);

    nodeEnter
      .append("text")
      .attr("class", "node-search")
      .attr("x", LAYOUT.searchIconX)
      .attr("dy", "0.32em")
      .text("🔍")
      .attr("pointer-events", "all")
      .on("click", (event, d) => {
        event.stopPropagation();
        window.open(
          `https://www.google.com/search?q=${buildSearchQuery(d)}`,
          "_blank",
        );
      });

    nodeEnter
      .append("text")
      .attr("class", "node-label")
      .attr("x", LAYOUT.labelOffsetX)
      .attr("dy", "0.35em")
      .attr("text-anchor", "start")
      .attr("fill", COLORS.labelDefault)
      .style("font-size", (d) => `${labelFontSize(d.depth)}px`)
      .call(applyLabelText);

    const nodeUpdate = nodeEnter.merge(node);

    nodeUpdate.select("text.node-label").call(applyLabelText);
    nodeUpdate.call(syncLabelBackgrounds);

    nodeUpdate.classed("match", (d) => Boolean(d.match));

    const positionNodes = (sel) =>
      sel.attr("transform", (d) => `translate(${d.y},${d.x})`);
    (animate ? nodeUpdate.transition().duration(250) : nodeUpdate).call(
      positionNodes,
    );

    nodeUpdate
      .select("circle")
      .attr("fill", nodeCircleFill)
      .attr("stroke", (d) =>
        d.match ? COLORS.matchStroke : COLORS.defaultStroke,
      )
      .attr("stroke-width", (d) => (d.match ? 2.5 : 1.5));

    nodeUpdate
      .select("text.node-label")
      .attr("fill", (d) => (d.match ? COLORS.labelMatch : COLORS.labelDefault));

    nodeUpdate
      .select("rect.node-bg")
      .attr("fill", (d) =>
        d.match ? COLORS.nodeBgMatch : COLORS.nodeBgDefault,
      )
      .attr("stroke", (d) =>
        d.match ? COLORS.nodeBgBorderMatch : COLORS.nodeBgBorderDefault,
      );

    node.exit().remove();

    // Store current positions for the next animation's starting point
    nodes.forEach((d) => {
      d.x0 = d.x;
      d.y0 = d.y;
    });

    const totalNodes = nodes.length;
    const maxDepth = d3.max(nodes, (d) => d.depth);
    DOM.nodeInfo.textContent = `${totalNodes} nodes · ${maxDepth} levels`;
  }

  // ── Fit-zoom helper ──

  const fitZoom = (duration = 300) =>
    new Promise((resolve) => {
      const transform = computeFitZoomTransform(svg.node(), zoomBehavior, g);
      const runner = duration ? svg.transition().duration(duration) : svg;
      runner.call(zoomBehavior.transform, transform).on("end", resolve);
    });

  // ── Zoom button wiring ──

  DOM.zoomInButton.onclick = () =>
    svg.transition().duration(200).call(zoomBehavior.scaleBy, 1.2);
  DOM.zoomOutButton.onclick = () =>
    svg.transition().duration(200).call(zoomBehavior.scaleBy, 0.8);
  DOM.resetZoomButton.onclick = () => fitZoom();

  // ── Expose chart-scoped callbacks ──

  currentRoot = root;

  chartCallbacks.resetZoom = fitZoom;

  chartCallbacks.collapseAll = () => {
    collapse(root);
    update(root);
  };

  chartCallbacks.expandAll = () => {
    expand(root);
    update(root);
  };

  chartCallbacks.highlightMatches = (query) => {
    const terms = normalizeText(query).split(/\s+/).filter(Boolean);
    currentRoot.each((d) => {
      d.match = terms.length
        ? terms.every((t) => normalizeText(d.data?.title).includes(t))
        : false;
    });

    if (terms.length) {
      // Expand ancestors of matching nodes so they are visible
      currentRoot.each((d) => {
        if (d.match) {
          d.ancestors().forEach((ancestor) => {
            if (ancestor._children) {
              ancestor.children = ancestor._children;
              ancestor._children = null;
            }
          });
        }
      });
    }

    update(currentRoot);
  };

  chartCallbacks.export = async (exportFn) => {
    const treeSnap = snapshotTreeState(root);
    const zoomSnap = d3.zoomTransform(svg.node());

    expand(root);
    update(root, { animate: false });
    await waitForLayout();
    svg.call(zoomBehavior.transform, d3.zoomIdentity);

    try {
      await exportFn();
    } finally {
      restoreTreeState(root, treeSnap);
      update(root, { animate: false });
      await waitForLayout();
      await new Promise((resolve) => {
        svg
          .transition()
          .duration(300)
          .call(zoomBehavior.transform, zoomSnap)
          .on("end", resolve);
      });
    }
  };

  // ── Initial render ──

  collapse(root);
  expandToDepth(root, 2);

  if (searchQuery && typeof chartCallbacks.highlightMatches === "function") {
    chartCallbacks.highlightMatches(searchQuery);
  } else {
    update(root, { animate: false });
  }

  fitZoom(0);
}

// ─── Data / File I/O ──────────────────────────────────────────────────────────

/**
 * Fetch the list of available JSON files from `files.json`, falling back to
 * `DEFAULT_FILES` on any error.
 * @returns {Promise<string[]>}
 */
async function loadFileList() {
  try {
    const response = await fetch("files.json");
    if (!response.ok) throw new Error("Manifest not found");
    const files = await response.json();
    return Array.isArray(files) && files.length ? files : DEFAULT_FILES;
  } catch {
    return DEFAULT_FILES;
  }
}

/**
 * Populate the file `<select>` element with the provided list.
 * @param {string[]} files
 */
function populateFileSelect(files) {
  DOM.fileSelect.innerHTML = "";
  for (const file of files) {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = file.replace(/\.json$/i, "");
    DOM.fileSelect.appendChild(option);
  }
}

/**
 * Fetch a remote JSON file, show the viewer panel, and render the mind map.
 * @param {string} fileName
 */
async function loadTreeFile(fileName) {
  try {
    const response = await fetch(fileName);
    if (!response.ok) throw new Error(`Unable to load ${fileName}`);
    const data = await response.json();
    showViewer(
      data,
      fileName,
      `Visualizing ${fileName} as a left-to-right tree diagram.`,
    );
  } catch (error) {
    alert(error.message || "Unable to render the JSON file.");
  }
}

/**
 * Read a `File` object as JSON and render it, catching parse errors gracefully.
 * @param {File} file
 */
function loadLocalJsonFile(file) {
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const data = JSON.parse(event.target.result);
      const fileName = file.name || "Uploaded JSON";
      showViewer(
        data,
        data.title || fileName,
        `Rendering uploaded file ${fileName}.`,
      );
    } catch {
      alert("Invalid JSON file. Please upload a valid mindmap JSON.");
    }
  };
  reader.onerror = () => alert("Unable to read the selected file.");
  reader.readAsText(file, "UTF-8");
}

/**
 * Trigger a browser download for the currently selected JSON file.
 * @param {string} fileName
 */
function downloadJsonFile(fileName) {
  if (!fileName) {
    alert("Please select a JSON file to download.");
    return;
  }
  fetch(fileName)
    .then((response) => {
      if (!response.ok) throw new Error(`Unable to download ${fileName}`);
      return response.blob();
    })
    .then((blob) => downloadBlob(blob, fileName.replace(/^.*[\\/]/, "")))
    .catch((error) =>
      alert(error.message || "Unable to download the JSON file."),
    );
}

/**
 * Transition from the landing panel to the viewer panel and kick off rendering.
 * @param {object} data
 * @param {string} title
 * @param {string} subtitle
 */
function showViewer(data, title, subtitle) {
  DOM.chartTitle.textContent = title;
  DOM.chartSubtitle.textContent = subtitle;
  DOM.landing.classList.add("hidden");
  DOM.viewer.classList.remove("hidden");
  renderMindMap(data);
}

// ─── SVG Export ───────────────────────────────────────────────────────────────

/**
 * Programmatically click an ephemeral `<a>` to trigger a browser download.
 * Revokes the object URL after a short delay to avoid memory leaks.
 * @param {Blob} blob
 * @param {string} fileName
 */
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), {
    href: url,
    download: fileName,
  });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/**
 * Derive a safe base name for exported files from the chart title.
 * @returns {string}
 */
function exportFileBaseName() {
  return (DOM.chartTitle.textContent || "mindmap").replace(
    /[^a-z0-9_-]+/gi,
    "_",
  );
}

/**
 * Clone the SVG, infer its bounding box, embed all CSS, and add watermarks.
 * Throws if the SVG element is missing or has zero area.
 * @param {SVGSVGElement} svgNode
 * @param {string | null} [omitSelector] — CSS selector for elements to strip before export
 * @returns {{ svgString: string, vbW: number, vbH: number }}
 */
function buildExportableSvgString(svgNode, omitSelector = null) {
  if (!svgNode) throw new Error("No chart to export");

  const { vbX, vbY, vbW, vbH } = resolveExportViewBox(svgNode);

  const exportSvg = svgNode.cloneNode(true);
  if (omitSelector) {
    exportSvg.querySelectorAll(omitSelector).forEach((el) => el.remove());
  }

  appendWatermarks(exportSvg, svgNode, vbX, vbY, vbW, vbH);

  exportSvg.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
  exportSvg.setAttribute("width", vbW);
  exportSvg.setAttribute("height", vbH);

  let svgString = new XMLSerializer().serializeToString(exportSvg);
  svgString = ensureSvgNamespaces(svgString);
  svgString = injectComputedStyles(svgString);

  return { svgString, vbW, vbH };
}

/**
 * Determine the viewBox for the exported SVG, derived from the rendered graph
 * group's bounding box when available.
 * @param {SVGSVGElement} svgNode
 * @returns {{ vbX: number, vbY: number, vbW: number, vbH: number }}
 */
function resolveExportViewBox(svgNode) {
  const graphGroup =
    svgNode.querySelector("g.nodes")?.parentElement ??
    svgNode.querySelector("g > g");

  if (graphGroup) {
    const bbox = graphGroup.getBBox();
    const t = graphGroup.transform.baseVal.consolidate();
    const dx = t?.matrix?.e ?? 0;
    const dy = t?.matrix?.f ?? 0;
    const vbX = bbox.x + dx - EXPORT_PADDING;
    const vbY = bbox.y + dy - EXPORT_PADDING;
    const vbW = bbox.width + EXPORT_PADDING * 2;
    const vbH = bbox.height + EXPORT_PADDING * 2;
    if (vbW > 0 && vbH > 0) return { vbX, vbY, vbW, vbH };
  }

  // Fallback: use the SVG's own viewBox or client dimensions
  let vbX = 0,
    vbY = 0;
  let vbW = svgNode.clientWidth || 1200;
  let vbH = svgNode.clientHeight || 800;
  const parts = (svgNode.getAttribute("viewBox") ?? "")
    .split(/\s+|,/)
    .map(Number);
  if (parts.length === 4 && parts.every((n) => !Number.isNaN(n))) {
    [vbX, vbY, vbW, vbH] = parts;
  }
  if (vbW <= 0 || vbH <= 0)
    throw new Error("Unable to determine chart bounds for export");
  return { vbX, vbY, vbW, vbH };
}

/**
 * Append repeated watermark text elements along both vertical edges of the SVG.
 * @param {SVGSVGElement} exportSvg
 * @param {SVGSVGElement} sourceSvg — used for computed style
 * @param {number} vbX
 * @param {number} vbY
 * @param {number} vbW
 * @param {number} vbH
 */
function appendWatermarks(exportSvg, sourceSvg, vbX, vbY, vbW, vbH) {
  const computedStyle = window.getComputedStyle(sourceSvg);
  const fontSize = computedStyle.fontSize || "15px";
  const fontFamily = computedStyle.fontFamily || "Inter, sans-serif";
  const fontSizePx = parseFloat(fontSize) || 15;
  const OFFSET = 12;
  const textLengthEstimate = WATERMARK_TEXT.length * fontSizePx * 0.55;
  const spacing = Math.max(textLengthEstimate + 28, fontSizePx * 6, 140);
  const availableHeight = vbH - OFFSET * 2;
  const repeatCount = Math.max(1, Math.floor(availableHeight / spacing));
  const firstY =
    vbY + OFFSET + (availableHeight - (repeatCount - 1) * spacing) / 2;

  const appendColumn = (xPos) => {
    for (let i = 0; i < repeatCount; i++) {
      const yPos = firstY + i * spacing;
      const el = document.createElementNS("http://www.w3.org/2000/svg", "text");
      el.setAttribute("x", String(xPos));
      el.setAttribute("y", String(yPos));
      el.setAttribute("fill", COLORS.watermark);
      el.setAttribute("font-size", fontSize);
      el.setAttribute("font-family", fontFamily);
      el.setAttribute("text-anchor", "middle");
      el.setAttribute("dominant-baseline", "middle");
      el.setAttribute("transform", `rotate(-90 ${xPos} ${yPos})`);
      el.textContent = WATERMARK_TEXT;
      exportSvg.appendChild(el);
    }
  };

  [vbX + OFFSET, vbX + vbW - OFFSET].forEach(appendColumn);
}

/**
 * Ensure the required SVG XML namespaces are present on the root `<svg>` tag.
 * @param {string} svgString
 * @returns {string}
 */
function ensureSvgNamespaces(svgString) {
  if (!svgString.match(/^<svg[^>]+xmlns="http:\/\/www.w3.org\/2000\/svg"/)) {
    svgString = svgString.replace(
      /^<svg/,
      '<svg xmlns="http://www.w3.org/2000/svg"',
    );
  }
  if (!svgString.includes("xmlns:xlink")) {
    svgString = svgString.replace(
      /^<svg/,
      '<svg xmlns:xlink="http://www.w3.org/1999/xlink"',
    );
  }
  return svgString;
}

/**
 * Collect all CSS rules from the page and inject them as a `<style>` block
 * immediately after the opening `<svg>` tag so the exported file is self-contained.
 * @param {string} svgString
 * @returns {string}
 */
function injectComputedStyles(svgString) {
  let cssText = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (!sheet.cssRules) continue;
      for (const rule of sheet.cssRules) cssText += rule.cssText;
    } catch {
      // CORS-restricted sheets; skip silently.
    }
  }
  if (!cssText) return svgString;
  const insertAt = svgString.indexOf(">") + 1;
  return (
    svgString.slice(0, insertAt) +
    `<style>${cssText}</style>` +
    svgString.slice(insertAt)
  );
}

/**
 * Save the current chart as a standalone SVG file.
 */
function saveChartAsSvg() {
  const svgNode = DOM.chartContainer.querySelector("svg");
  const { svgString } = buildExportableSvgString(svgNode, ".node-search");
  downloadBlob(
    new Blob([svgString], { type: "image/svg+xml;charset=utf-8" }),
    `${exportFileBaseName()}.svg`,
  );
}

/**
 * Open the current chart SVG in a new browser tab.
 */
function openChartSvgInNewTab() {
  const svgNode = DOM.chartContainer.querySelector("svg");
  const { svgString } = buildExportableSvgString(svgNode, ".node-search");
  const url = URL.createObjectURL(
    new Blob([svgString], { type: "image/svg+xml;charset=utf-8" }),
  );
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

// ─── Initialisation ───────────────────────────────────────────────────────────

/**
 * Wire up all static event listeners and load the initial file list.
 * Runs immediately; async so we can await `loadFileList`.
 */
(async function init() {
  const files = await loadFileList();
  populateFileSelect(files);
  if (files.length) DOM.fileSelect.value = files[0];

  // ── Navigation ──
  DOM.loadButton.addEventListener("click", () => {
    if (DOM.fileSelect.value) loadTreeFile(DOM.fileSelect.value);
  });

  DOM.backButton.addEventListener("click", () => {
    DOM.viewer.classList.add("hidden");
    DOM.landing.classList.remove("hidden");
  });

  // ── Search ──
  DOM.searchInput?.addEventListener("input", (event) => {
    searchQuery = normalizeText(event.target.value);
    chartCallbacks.highlightMatches?.(searchQuery);
  });

  // ── File I/O ──
  DOM.downloadJsonButton?.addEventListener("click", () =>
    downloadJsonFile(DOM.fileSelect.value),
  );

  DOM.uploadJsonButton?.addEventListener("click", () => {
    DOM.uploadInput.value = "";
    DOM.uploadInput.click();
  });

  DOM.uploadInput?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    if (file) loadLocalJsonFile(file);
  });

  // ── SVG export ──
  DOM.openSvgButton?.addEventListener("click", async () => {
    try {
      await (chartCallbacks.export
        ? chartCallbacks.export(openChartSvgInNewTab)
        : openChartSvgInNewTab());
    } catch (err) {
      alert(err.message || "Unable to open SVG");
    }
  });

  DOM.saveSvgButton?.addEventListener("click", async () => {
    try {
      await (chartCallbacks.export
        ? chartCallbacks.export(saveChartAsSvg)
        : saveChartAsSvg());
    } catch (err) {
      alert(err.message || "Unable to save SVG");
    }
  });

  // ── Collapse / expand ──
  DOM.collapseAllButton?.addEventListener("click", () =>
    chartCallbacks.collapseAll?.(),
  );

  DOM.expandAllButton?.addEventListener("click", () =>
    chartCallbacks.expandAll?.(),
  );

  // ── Responsive resize ──
  window.addEventListener("resize", () => chartCallbacks.resetZoom?.(0));
})();
