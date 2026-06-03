const defaultFiles = ["02.json"];
const fileSelect = document.getElementById("fileSelect");
const loadButton = document.getElementById("loadButton");
const backButton = document.getElementById("backButton");
const landing = document.getElementById("landing");
const viewer = document.getElementById("viewer");
const chartTitle = document.getElementById("chartTitle");
const chartSubtitle = document.getElementById("chartSubtitle");
const nodeInfo = document.getElementById("nodeInfo");
const zoomInButton = document.getElementById("zoomInButton");
const zoomOutButton = document.getElementById("zoomOutButton");
const resetZoomButton = document.getElementById("resetZoomButton");
const chartContainer = document.getElementById("chart");
const openSvgButton = document.getElementById("openSvgButton");
const saveSvgButton = document.getElementById("saveSvgButton");
const expandAllButton = document.getElementById("expandAllButton");
const collapseAllButton = document.getElementById("collapseAllButton");
const searchInput = document.getElementById("searchInput");
let requestResetZoom = null;
let requestCollapseAll = null;
let requestExpandAll = null;
let performChartExport = null;
let currentRoot = null;
let searchQuery = "";
let highlightMatches = null;

function normalizeText(value) {
  return (value || "").toString().trim().toLowerCase();
}

function snapshotTreeState(root) {
  const snapshot = new Map();
  root.each((d) => {
    snapshot.set(d.id, {
      children: d.children,
      _children: d._children,
    });
  });
  return snapshot;
}

function restoreTreeState(root, snapshot) {
  root.each((d) => {
    const saved = snapshot.get(d.id);
    if (saved) {
      d.children = saved.children;
      d._children = saved._children;
    }
  });
}

function waitForLayout() {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

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
  const x1 = x0 + bounds.width;
  const y1 = y0 + bounds.height;
  const dx = x1 - x0;
  const dy = y1 - y0;
  if (dx <= 0 || dy <= 0) return d3.zoomIdentity;

  const [minScale, maxScale] = zoomBehavior.scaleExtent();
  const scale = Math.min(
    maxScale,
    Math.max(
      minScale,
      Math.min((vbWidth - padding * 2) / dx, (vbHeight - padding * 2) / dy),
    ),
  );
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  return d3.zoomIdentity
    .translate(vbWidth / 2, vbHeight / 2)
    .scale(scale)
    .translate(-cx, -cy);
}

const LAYOUT = {
  margin: { top: 12, right: 80, bottom: 48, left: 160 },
  columnGap: 52,
  minColumnWidth: 96,
  lineHeight: 26,
  minVerticalGap: 52,
  maxLabelChars: 34,
  labelOffsetX: 44,
  labelPadX: 24,
  searchIconX: 24,
};

function wrapLabel(title, maxChars = LAYOUT.maxLabelChars) {
  const words = (title || "").toString().split(/\s+/).filter(Boolean);
  if (!words.length) return { lines: [""], lineCount: 1 };

  const lines = [];
  let line = [];

  words.forEach((word) => {
    const candidate = line.length ? `${line.join(" ")} ${word}` : word;
    if (candidate.length > maxChars && line.length) {
      lines.push(line.join(" "));
      line = [word];
    } else {
      line.push(word);
    }
  });

  if (line.length) lines.push(line.join(" "));
  return { lines, lineCount: lines.length };
}

function labelFontSize(depth) {
  return Math.max(13, 16.5 - depth * 0.45);
}

function estimateLabelWidth(d) {
  const lines = d.data._labelLines || [""];
  const charWidth = labelFontSize(d.depth) * 0.58;
  const textWidth = d3.max(lines, (line) => line.length * charWidth) || 0;
  return LAYOUT.labelOffsetX + textWidth + LAYOUT.labelPadX;
}

function prepareNodeLabels(root) {
  root.each((d) => {
    const wrapped = wrapLabel(d.data?.title);
    d.data._labelLines = wrapped.lines;
    d.data._lineCount = wrapped.lineCount;
    d.data._labelWidth = estimateLabelWidth(d);
  });
}

function assignColumnPositions(root) {
  const nodes = root.descendants();
  const maxDepth = d3.max(nodes, (d) => d.depth) ?? 0;
  const byDepth = d3.group(nodes, (d) => d.depth);
  let columnStart = 0;

  for (let depth = 0; depth <= maxDepth; depth += 1) {
    const columnNodes = byDepth.get(depth) || [];
    columnNodes.forEach((d) => {
      d.y = columnStart;
    });

    if (depth < maxDepth) {
      const columnLabelExtent =
        d3.max(
          columnNodes,
          (d) => d.data._labelWidth || estimateLabelWidth(d),
        ) ?? LAYOUT.minColumnWidth;
      columnStart +=
        Math.max(LAYOUT.minColumnWidth, columnLabelExtent) + LAYOUT.columnGap;
    }
  }
}

function nodeSeparation(a, b) {
  const siblingFactor = a.parent === b.parent ? 1.15 : 1.75;
  const aLines = a.data._lineCount || 1;
  const bLines = b.data._lineCount || 1;
  const lineFactor = Math.max(1, (aLines + bLines) / 2);
  return siblingFactor * lineFactor;
}

function computeChartDimensions(root, margin = LAYOUT.margin) {
  const nodes = root.descendants();
  const xMin = d3.min(nodes, (d) => d.x) ?? 0;
  const xMax = d3.max(nodes, (d) => d.x) ?? 0;
  const yMax = d3.max(nodes, (d) => d.y) ?? 0;
  const maxDepth = d3.max(nodes, (d) => d.depth) ?? 0;
  const maxLineCount = d3.max(nodes, (d) => d.data._lineCount || 1) || 1;
  const lastColumnNodes = nodes.filter((d) => d.depth === maxDepth);
  const trailingLabel =
    d3.max(
      lastColumnNodes,
      (d) => d.data._labelWidth || estimateLabelWidth(d),
    ) || LAYOUT.minColumnWidth;
  const verticalSpan = Math.max(LAYOUT.minVerticalGap, xMax - xMin);
  const height =
    verticalSpan + margin.top + margin.bottom + maxLineCount * 6 + 24;
  const width = margin.left + margin.right + yMax + trailingLabel + 32;

  return { width, height, xMin, xMax, nodes };
}

function applyLabelText(selection) {
  selection.each(function (d) {
    const self = d3.select(this);
    const lines = d.data._labelLines || [d.data?.title || ""];
    self.selectAll("tspan").remove();
    self.text(null);
    lines.forEach((line, index) => {
      self
        .append("tspan")
        .text(line)
        .attr("x", LAYOUT.labelOffsetX)
        .attr("dy", index ? "1.35em" : 0);
    });
  });
}

function syncLabelBackgrounds(selection) {
  selection.each(function () {
    const group = d3.select(this);
    const label = group.select("text.node-label");
    const labelNode = label.node();
    if (!labelNode) return;

    const bbox = labelNode.getBBox();
    const padX = 10;
    const padY = 6;
    const bg = group.select("rect.node-bg");

    (bg.empty() ? group.insert("rect", "circle") : bg)
      .attr("class", "node-bg")
      .attr("x", bbox.x - padX)
      .attr("y", bbox.y - padY)
      .attr("width", Math.max(0, bbox.width + padX * 2))
      .attr("height", Math.max(0, bbox.height + padY * 2))
      .attr("rx", 8);
  });
}

loadButton.addEventListener("click", () => {
  const fileName = fileSelect.value;
  if (fileName) {
    loadTreeFile(fileName);
  }
});

backButton.addEventListener("click", () => {
  viewer.classList.add("hidden");
  landing.classList.remove("hidden");
});

async function loadFileList() {
  try {
    const response = await fetch("files.json");
    if (!response.ok) throw new Error("Manifest not found");
    const files = await response.json();
    return Array.isArray(files) && files.length ? files : defaultFiles;
  } catch (error) {
    return defaultFiles;
  }
}

function populateFileSelect(files) {
  fileSelect.innerHTML = "";
  files.forEach((file) => {
    const option = document.createElement("option");
    option.value = file;
    option.textContent = file.replace(/\.json$/i, "");
    fileSelect.appendChild(option);
  });
}

async function loadTreeFile(fileName) {
  try {
    const raw = await fetch(fileName);
    if (!raw.ok) throw new Error(`Unable to load ${fileName}`);
    const data = await raw.json();
    chartTitle.textContent = data.title || fileName;
    chartSubtitle.textContent = `Visualizing ${fileName} as a left-to-right tree diagram.`;
    landing.classList.add("hidden");
    viewer.classList.remove("hidden");
    renderMindMap(data);
  } catch (error) {
    alert(error.message || "Unable to render the JSON file.");
  }
}

function renderMindMap(data) {
  chartContainer.innerHTML = "";

  const margin = LAYOUT.margin;
  const root = d3.hierarchy(data);
  root.each((d) => {
    if (d.children) {
      d._children = d.children;
    }
  });

  prepareNodeLabels(root);

  const treeLayout = d3
    .tree()
    .nodeSize([LAYOUT.lineHeight, 1])
    .separation(nodeSeparation);
  treeLayout(root);
  assignColumnPositions(root);

  let { width, height, xMin } = computeChartDimensions(root, margin);

  function setChartContainerHeight(rawHeight) {
    const chartHeight = Math.max(380, rawHeight);
    chartContainer.style.height = `${chartHeight}px`;
  }

  setChartContainerHeight(height);

  const svg = d3
    .select(chartContainer)
    .append("svg")
    .attr("viewBox", [0, 0, width, height])
    .style("font", "15px Inter, sans-serif")
    .style("touch-action", "none")
    .style("cursor", "grab")
    .style("user-select", "none");

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

  let nodeId = 0;
  root.each((d) => {
    d.id = d.id || ++nodeId;
  });

  const linkGroup = g.append("g").attr("class", "links");
  const nodeGroup = g.append("g").attr("class", "nodes");

  const zoomBehavior = d3
    .zoom()
    .scaleExtent([0.15, 10])
    .on("zoom", (event) => {
      zoomGroup.attr("transform", event.transform);
    });

  svg.call(zoomBehavior);

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
      { offset: "0%", color: "#8cffc7" },
      { offset: "100%", color: "#7c9fff" },
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

  currentRoot = root;
  highlightMatches = (query) => {
    const normalizedQuery = normalizeText(query);
    const terms = normalizedQuery.split(/\s+/).filter(Boolean);

    currentRoot.each((d) => {
      const title = normalizeText(d.data?.title);
      d.match = terms.length
        ? terms.every((term) => title.includes(term))
        : false;
    });

    if (terms.length) {
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

  zoomInButton.onclick = () => {
    svg.transition().duration(200).call(zoomBehavior.scaleBy, 1.2);
  };

  zoomOutButton.onclick = () => {
    svg.transition().duration(200).call(zoomBehavior.scaleBy, 0.8);
  };

  const fitZoom = (duration = 300) =>
    new Promise((resolve) => {
      const transform = computeFitZoomTransform(svg.node(), zoomBehavior, g);
      const runner = duration ? svg.transition().duration(duration) : svg;
      runner.call(zoomBehavior.transform, transform).on("end", resolve);
    });

  resetZoomButton.onclick = () => fitZoom();
  requestResetZoom = fitZoom;

  performChartExport = async (exportFn) => {
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
    if (d.children) {
      d.children.forEach(expand);
    }
  }

  requestCollapseAll = () => {
    collapse(root);
    update(root);
  };

  requestExpandAll = () => {
    expand(root);
    update(root);
  };

  function toggle(d) {
    if (d.children) {
      d._children = d.children;
      d.children = null;
    } else {
      d.children = d._children;
      d._children = null;
    }
  }

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

    const link = linkGroup
      .selectAll("path.link")
      .data(links, (d) => d.target.id);

    const linkUpdate = link
      .enter()
      .append("path")
      .attr("class", "link")
      .attr("fill", "none")
      .attr("stroke", "rgba(255,255,255,0.2)")
      .attr("stroke-width", 1.6)
      .attr("d", (d) => {
        const o = { x: source.x0, y: source.y0 };
        return linkPath({ source: o, target: o });
      })
      .merge(link);

    if (animate) {
      linkUpdate.transition().duration(250).attr("d", linkPath);
    } else {
      linkUpdate.attr("d", linkPath);
    }

    link.exit().remove();

    const node = nodeGroup.selectAll("g.node").data(nodes, (d) => d.id);

    const nodeEnter = node
      .enter()
      .append("g")
      .attr("class", "node")
      .attr("transform", (d) => `translate(${source.y0},${source.x0})`)
      .style("cursor", "pointer")
      .on("click", (event, d) => {
        if (event.defaultPrevented) return;
        toggle(d);
        update(d);
      });

    nodeEnter
      .append("circle")
      .attr("r", (d) => (d.depth === 0 ? 14 : 8))
      .attr("fill", (d) =>
        d._children
          ? "#7c9fff"
          : d.depth === 0
            ? "#7c9fff"
            : "rgba(124, 159, 255, 0.92)",
      )
      .attr("stroke", "rgba(255,255,255,0.24)")
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
        const query = buildSearchQuery(d);
        window.open(`https://www.google.com/search?q=${query}`, "_blank");
      });

    function buildSearchQuery(node) {
      const ancestry = node
        .ancestors()
        .map((item) => item.data.title)
        .filter(Boolean);
      return encodeURIComponent(ancestry.join(", "));
    }

    const label = nodeEnter
      .append("text")
      .attr("class", "node-label")
      .attr("x", LAYOUT.labelOffsetX)
      .attr("dy", "0.35em")
      .attr("text-anchor", "start")
      .attr("fill", "#eef3ff")
      .style("font-size", (d) => `${labelFontSize(d.depth)}px`);

    applyLabelText(label);

    const nodeUpdate = nodeEnter.merge(node);

    nodeUpdate.select("text.node-label").call(applyLabelText);
    nodeUpdate.call(syncLabelBackgrounds);

    const positionNodes = (selection) =>
      selection.attr("transform", (d) => `translate(${d.y},${d.x})`);

    nodeUpdate.classed("match", (d) => Boolean(d.match));
    if (animate) {
      nodeUpdate.transition().duration(250).call(positionNodes);
    } else {
      nodeUpdate.call(positionNodes);
    }

    nodeUpdate
      .select("circle")
      .attr("fill", (d) =>
        d.match
          ? "#8cffc7"
          : d._children
            ? "#7c9fff"
            : d.depth === 0
              ? "#7c9fff"
              : "rgba(124, 159, 255, 0.92)",
      )
      .attr("stroke", (d) => (d.match ? "#ffffff" : "rgba(255,255,255,0.24)"))
      .attr("stroke-width", (d) => (d.match ? 2.5 : 1.5));

    nodeUpdate
      .select("text.node-label")
      .attr("fill", (d) => (d.match ? "#05070d" : "#eef3ff"));

    nodeUpdate
      .select("rect.node-bg")
      .attr("fill", (d) =>
        d.match ? "rgba(140, 255, 199, 0.18)" : "rgba(8, 12, 22, 0.72)",
      )
      .attr("stroke", (d) =>
        d.match ? "rgba(140, 255, 199, 0.55)" : "rgba(255, 255, 255, 0.08)",
      );

    node.exit().remove();

    nodes.forEach((d) => {
      d.x0 = d.x;
      d.y0 = d.y;
    });

    const totalNodes = nodes.length;
    const maxDepth = d3.max(nodes, (d) => d.depth);
    nodeInfo.textContent = `${totalNodes} nodes · ${maxDepth} levels`;
  }

  collapse(root);
  if (searchQuery && typeof highlightMatches === "function") {
    highlightMatches(searchQuery);
  } else {
    update(root, { animate: false });
  }
  fitZoom(0);
}

(async function init() {
  const files = await loadFileList();
  populateFileSelect(files);
  if (files.length) {
    fileSelect.value = files[0];
  }
  if (searchInput) {
    searchInput.addEventListener("input", (event) => {
      searchQuery = normalizeText(event.target.value);
      if (typeof highlightMatches === "function") {
        highlightMatches(searchQuery);
      }
    });
  }
  if (openSvgButton) {
    openSvgButton.addEventListener("click", async () => {
      try {
        if (typeof performChartExport === "function") {
          await performChartExport(() => openChartSvgInNewTab());
        } else {
          openChartSvgInNewTab();
        }
      } catch (err) {
        alert(err.message || "Unable to open SVG");
      }
    });
  }
  if (saveSvgButton) {
    saveSvgButton.addEventListener("click", async () => {
      try {
        if (typeof performChartExport === "function") {
          await performChartExport(() => saveChartAsSvg());
        } else {
          saveChartAsSvg();
        }
      } catch (err) {
        alert(err.message || "Unable to save SVG");
      }
    });
  }
  if (collapseAllButton) {
    collapseAllButton.addEventListener("click", () => {
      if (typeof requestCollapseAll === "function") requestCollapseAll();
    });
  }
  if (expandAllButton) {
    expandAllButton.addEventListener("click", () => {
      if (typeof requestExpandAll === "function") requestExpandAll();
    });
  }

  window.addEventListener("resize", () => {
    if (typeof requestResetZoom === "function") requestResetZoom(0);
  });
})();

function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportFileBaseName() {
  return (chartTitle.textContent || "mindmap").replace(/[^a-z0-9_-]+/gi, "_");
}

function buildExportableSvgString(svgNode, omitSelector = null) {
  if (!svgNode) throw new Error("No chart to export");

  const padding = 60;
  const graphGroup =
    svgNode.querySelector("g.nodes")?.parentElement ||
    svgNode.querySelector("g > g");
  let vbX = 0;
  let vbY = 0;
  let vbW = 0;
  let vbH = 0;

  if (graphGroup) {
    const graphBBox = graphGroup.getBBox();
    const transform = graphGroup.transform.baseVal.consolidate();
    const dx = transform?.matrix?.e || 0;
    const dy = transform?.matrix?.f || 0;

    vbX = graphBBox.x + dx - padding;
    vbY = graphBBox.y + dy - padding;
    vbW = graphBBox.width + padding * 2;
    vbH = graphBBox.height + padding * 2;
  } else {
    vbX = 0;
    vbY = 0;
    vbW = svgNode.clientWidth || 1200;
    vbH = svgNode.clientHeight || 800;
    const viewBox = svgNode.getAttribute("viewBox");
    if (viewBox) {
      const parts = viewBox.split(/\s+|,/).map(Number);
      if (parts.length === 4 && parts.every((n) => !Number.isNaN(n))) {
        [vbX, vbY, vbW, vbH] = parts;
      }
    }
  }

  if (vbW <= 0 || vbH <= 0) {
    throw new Error("Unable to determine chart bounds for export");
  }

  const exportSvg = svgNode.cloneNode(true);
  if (omitSelector) {
    exportSvg.querySelectorAll(omitSelector).forEach((node) => node.remove());
  }

  exportSvg.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
  exportSvg.setAttribute("width", vbW);
  exportSvg.setAttribute("height", vbH);

  const serializer = new XMLSerializer();
  let svgString = serializer.serializeToString(exportSvg);

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

  let cssText = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (!sheet.cssRules) continue;
      for (const rule of sheet.cssRules) cssText += rule.cssText;
    } catch (e) {
      /* ignore CORS/readonly */
    }
  }

  const openTagEnd = svgString.indexOf(">");
  const withStyles =
    svgString.slice(0, openTagEnd + 1) +
    (cssText ? `<style>${cssText}</style>` : "") +
    svgString.slice(openTagEnd + 1);

  return { svgString: withStyles, vbW, vbH };
}

function saveChartAsSvg() {
  const svgNode = chartContainer.querySelector("svg");
  const { svgString } = buildExportableSvgString(svgNode, ".node-search");
  const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  downloadBlob(blob, `${exportFileBaseName()}.svg`);
}

function openChartSvgInNewTab() {
  const svgNode = chartContainer.querySelector("svg");
  const { svgString } = buildExportableSvgString(svgNode, ".node-search");
  const blob = new Blob([svgString], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
