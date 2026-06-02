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

  zoomInButton.onclick = () => {
    svg.transition().duration(200).call(zoomBehavior.scaleBy, 1.2);
  };

  zoomOutButton.onclick = () => {
    svg.transition().duration(200).call(zoomBehavior.scaleBy, 0.8);
  };

  resetZoomButton.onclick = () => {
    svg
      .transition()
      .duration(300)
      .call(zoomBehavior.transform, d3.zoomIdentity.translate(0, 0));
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
        .reverse()
        .map((item) => item.data.title)
        .filter(Boolean);
      return encodeURIComponent(ancestry.join(" "));
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
      .transition()
      .duration(250)
      .attr("transform", (d) => `translate(${d.y},${d.x})`);

    nodeUpdate
      .select("circle")
      .attr("fill", (d) =>
        d._children
          ? "#7c9fff"
          : d.depth === 0
            ? "#7c9fff"
            : "rgba(124, 159, 255, 0.92)",
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

  update(root);
}

(async function init() {
  const files = await loadFileList();
  populateFileSelect(files);
  if (files.length) {
    fileSelect.value = files[0];
  }
})();
