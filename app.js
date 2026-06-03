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
const saveImageButton = document.getElementById("saveImageButton");
const searchInput = document.getElementById("searchInput");
let requestResetZoom = null;
let currentRoot = null;
let searchQuery = "";
let highlightMatches = null;

function normalizeText(value) {
  return (value || "").toString().trim().toLowerCase();
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

  const margin = { top: 40, right: 60, bottom: 40, left: 140 };
  const baseWidth = chartContainer.clientWidth;
  const baseHeight = Math.max(chartContainer.clientHeight, 700);

  const root = d3.hierarchy(data);
  root.each((d) => {
    if (d.children) {
      d._children = d.children;
    }
  });

  const treeLayout = d3
    .tree()
    .nodeSize([72, 260])
    .separation((a, b) => (a.parent === b.parent ? 1.6 : 2.6) / a.depth);
  treeLayout(root);

  const nodes = root.descendants();
  const xMin = d3.min(nodes, (d) => d.x);
  const xMax = d3.max(nodes, (d) => d.x);

  const height = xMax - xMin + margin.top + margin.bottom + 10;
  const width = margin.left + margin.right + (root.height + 1) * 100 + 10;
  const innerHeight = height - margin.top - margin.bottom;

  chartContainer.style.height = `${height}px`;

  const svg = d3
    .select(chartContainer)
    .append("svg")
    .attr("viewBox", [0, 0, width, height])
    .style("font", "14px Inter, sans-serif")
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
    .scaleExtent([0.5, 4])
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

  const glowFilter = defs
    .append("filter")
    .attr("id", "match-glow");

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
      d.match = terms.length ? terms.every((term) => title.includes(term)) : false;
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

  const resetZoom = () =>
    new Promise((resolve) => {
      svg
        .transition()
        .duration(300)
        .call(zoomBehavior.transform, d3.zoomIdentity.translate(0, 0))
        .on("end", resolve);
    });

  resetZoomButton.onclick = () => resetZoom();
  requestResetZoom = resetZoom;

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
      d.children.forEach(expand);
      d._children = null;
    }
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

  function update(source) {
    treeLayout(root);

    const nodes = root.descendants();
    const links = root.links();

    const link = linkGroup
      .selectAll("path.link")
      .data(links, (d) => d.target.id);

    link
      .enter()
      .append("path")
      .attr("class", "link")
      .attr("fill", "none")
      .attr("stroke", "rgba(255,255,255,0.24)")
      .attr("stroke-width", 1.8)
      .attr("d", (d) => {
        const o = { x: source.x0, y: source.y0 };
        return d3
          .linkHorizontal()
          .x((p) => p.y)
          .y((p) => p.x)({ source: o, target: o });
      })
      .merge(link)
      .transition()
      .duration(250)
      .attr(
        "d",
        d3
          .linkHorizontal()
          .x((d) => d.y)
          .y((d) => d.x),
      );

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
      .attr("x", 22)
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
      .attr("x", 42)
      .attr("dy", "0.32em")
      .attr("text-anchor", "start")
      .text((d) => d.data.title)
      .attr("fill", "#eef3ff")
      .style("font-size", (d) => `${Math.max(12, 18 - d.depth)}px`);

    label.each(function (d) {
      const self = d3.select(this);
      const words = self.text().split(" ");
      if (words.length > 6) {
        self.text("");
        let line = [];
        let lineNumber = 0;
        words.forEach((word) => {
          line.push(word);
          const testLine = line.join(" ");
          if (testLine.length > 22) {
            line.pop();
            self
              .append("tspan")
              .text(line.join(" "))
              .attr("x", 42)
              .attr("dy", lineNumber ? "1.2em" : 0);
            line = [word];
            lineNumber += 1;
          }
        });
        if (line.length) {
          self
            .append("tspan")
            .text(line.join(" "))
            .attr("x", 42)
            .attr("dy", lineNumber ? "1.2em" : 0);
        }
      }
    });

    const nodeUpdate = nodeEnter.merge(node);

    nodeUpdate
      .classed("match", (d) => Boolean(d.match))
      .transition()
      .duration(250)
      .attr("transform", (d) => `translate(${d.y},${d.x})`);

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

    node.exit().remove();

    nodes.forEach((d) => {
      d.x0 = d.x;
      d.y0 = d.y;
    });

    const totalNodes = nodes.length;
    const maxDepth = d3.max(nodes, (d) => d.depth);
    nodeInfo.textContent = `${totalNodes} nodes · ${maxDepth} levels`;
  }

  update(root);
  if (searchQuery && typeof highlightMatches === "function") {
    highlightMatches(searchQuery);
  }
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
  if (saveImageButton) {
    saveImageButton.addEventListener("click", async () => {
      try {
        if (typeof requestResetZoom === "function") await requestResetZoom();
        await saveChartAsJpeg();
      } catch (err) {
        alert(err.message || "Unable to save image");
      }
    });
  }
})();

async function saveChartAsJpeg() {
  const svgNode = chartContainer.querySelector("svg");
  if (!svgNode) throw new Error("No chart to export");

  const padding = 60;
  const graphGroup = svgNode.querySelector("g > g");
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

  // Temporarily override the SVG viewBox so the serialized string covers the full tree
  const originalViewBox = svgNode.getAttribute("viewBox");
  const originalWidth   = svgNode.getAttribute("width");
  const originalHeight  = svgNode.getAttribute("height");
  svgNode.setAttribute("viewBox", `${vbX} ${vbY} ${vbW} ${vbH}`);
  svgNode.setAttribute("width",  vbW);
  svgNode.setAttribute("height", vbH);

  const serializer = new XMLSerializer();
  let svgString = serializer.serializeToString(svgNode);

  // Restore original attributes right away (before any async work)
  if (originalViewBox !== null) svgNode.setAttribute("viewBox", originalViewBox); else svgNode.removeAttribute("viewBox");
  if (originalWidth   !== null) svgNode.setAttribute("width",   originalWidth);   else svgNode.removeAttribute("width");
  if (originalHeight  !== null) svgNode.setAttribute("height",  originalHeight);  else svgNode.removeAttribute("height");

  if (!svgString.match(/^<svg[^>]+xmlns="http:\/\/www.w3.org\/2000\/svg"/)) {
    svgString = svgString.replace(/^<svg/, '<svg xmlns="http://www.w3.org/2000/svg"');
  }
  if (!svgString.includes("xmlns:xlink")) {
    svgString = svgString.replace(/^<svg/, '<svg xmlns:xlink="http://www.w3.org/1999/xlink"');
  }

  // Inline same-origin stylesheets so text/colors render correctly off-DOM
  let cssText = "";
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      if (!sheet.cssRules) continue;
      for (const rule of sheet.cssRules) cssText += rule.cssText;
    } catch (e) { /* ignore CORS/readonly */ }
  }

  const openTagEnd = svgString.indexOf(">");
  const withStyles =
    svgString.slice(0, openTagEnd + 1) +
    (cssText ? `<style>${cssText}</style>` : "") +
    svgString.slice(openTagEnd + 1);

  // Scale for readability — cap at 3840px wide, max 3×
  const maxWidth = 3840;
  const scale = Math.min(maxWidth / Math.max(1, vbW), 3);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement("canvas");
        canvas.width  = Math.round(vbW * scale);
        canvas.height = Math.round(vbH * scale);
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = getComputedStyle(document.body).backgroundColor || "#0b1220";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        canvas.toBlob(
          (blob) => {
            if (!blob) return reject(new Error("Export failed"));
            const a = document.createElement("a");
            const fileName =
              (chartTitle.textContent || "mindmap").replace(/[^a-z0-9_-]+/gi, "_") + ".jpg";
            const url = URL.createObjectURL(blob);
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 5000);
            resolve();
          },
          "image/jpeg",
          0.92,
        );
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = () => reject(new Error("Failed to load SVG for export"));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(withStyles);
  });
}