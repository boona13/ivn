const TYPES = ["decision", "pattern", "gotcha", "debug", "context", "dependency", "todo"];
const DASHBOARD_TOKEN = document.querySelector('meta[name="ivn-dashboard-token"]')?.content || "";
const FOCUS_MODES = [
  { id: "attention", label: "Needs attention" },
  { id: "recent", label: "Recently changed" },
  { id: "all", label: "All knowledge" },
];
const DEFAULT_STALE_DAYS = 90;
const RECENT_DAYS = 14;
const TYPE_COLOR = {
  decision: "#60a5fa",
  pattern: "#4ade80",
  gotcha: "#fbbf24",
  debug: "#f87171",
  context: "#22d3ee",
  dependency: "#c084fc",
  todo: "#94a5b8",
};

const state = {
  entries: [],
  edges: [],
  stats: null,
  activeType: null,
  currentView: "cards",
  focusMode: "all",
  pendingActionId: null,
  actionStatus: "",
};

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value;
  return div.innerHTML;
}

function fetchDashboard(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (DASHBOARD_TOKEN) {
    headers.set("X-Ivn-Token", DASHBOARD_TOKEN);
  }
  return fetch(path, { ...options, headers });
}

function timeAgo(iso) {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return "just now";
  if (seconds < 3600) return Math.floor(seconds / 60) + "m ago";
  if (seconds < 86400) return Math.floor(seconds / 3600) + "h ago";
  if (seconds < 604800) return Math.floor(seconds / 86400) + "d ago";
  return Math.floor(seconds / 2592000) + "mo ago";
}

function daysSince(iso) {
  const ageMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
  return ageMs / (1000 * 60 * 60 * 24);
}

function getFreshnessTimestamp(entry) {
  return entry.reviewed_at || entry.updated_at || entry.valid_from || entry.created_at;
}

function isBrowsableEntry(entry) {
  return !entry.archived && entry.review_status !== "rejected";
}

function getBrowsableEntries() {
  return state.entries.filter(isBrowsableEntry);
}

function isStale(entry) {
  if (entry.archived || entry.review_status !== "active" || entry.valid_to !== null) return false;
  return daysSince(getFreshnessTimestamp(entry)) >= DEFAULT_STALE_DAYS;
}

function isRecent(entry) {
  return daysSince(entry.updated_at || entry.created_at) <= RECENT_DAYS;
}

function needsAttention(entry) {
  return entry.review_status === "pending" || isStale(entry) || entry.type === "todo";
}

function matchesFocusMode(entry) {
  if (state.focusMode === "attention") return needsAttention(entry);
  if (state.focusMode === "recent") return isRecent(entry);
  return true;
}

function prioritizeEntries(entries) {
  return [...entries].sort((left, right) => {
    const score = (entry) =>
      (entry.review_status === "pending" ? 100 : 0) +
      (isStale(entry) ? 70 : 0) +
      (entry.type === "todo" ? 35 : 0) +
      (isRecent(entry) ? 20 : 0);
    const scoreDiff = score(right) - score(left);
    if (scoreDiff !== 0) return scoreDiff;
    return Date.parse(getFreshnessTimestamp(right)) - Date.parse(getFreshnessTimestamp(left));
  });
}

function getFocusedEntries() {
  return prioritizeEntries(getBrowsableEntries().filter(matchesFocusMode));
}

function getVisibleEntries() {
  const query = getSearchQuery();
  return getFocusedEntries().filter((entry) => {
    if (state.activeType && entry.type !== state.activeType) return false;
    if (!query) return true;
    return (
      entry.content.toLowerCase().includes(query) ||
      entry.summary.toLowerCase().includes(query) ||
      entry.tags.some((tag) => tag.toLowerCase().includes(query))
    );
  });
}

function getSearchQuery() {
  return document.getElementById("search").value.trim().toLowerCase();
}

function getReadableQuery() {
  return document.getElementById("search").value.trim();
}

function getFocusCounts() {
  const entries = getBrowsableEntries();
  return {
    attention: entries.filter(needsAttention).length,
    recent: entries.filter(isRecent).length,
    all: entries.length,
    pending: entries.filter((entry) => entry.review_status === "pending").length,
    stale: entries.filter(isStale).length,
  };
}

function initializeFocusMode() {
  const counts = getFocusCounts();
  state.focusMode = counts.attention > 0 ? "attention" : counts.recent > 0 ? "recent" : "all";
}

function renderFocusModes() {
  const counts = getFocusCounts();
  const element = document.getElementById("focus-modes");
  element.innerHTML = FOCUS_MODES.map((mode) => {
    const isActive = mode.id === state.focusMode;
    return (
      '<button type="button" class="focus-btn' + (isActive ? ' active' : '') + '" data-focus="' + mode.id + '" aria-pressed="' + (isActive ? "true" : "false") + '">' +
        '<span>' + mode.label + "</span>" +
        '<span class="focus-count">' + counts[mode.id] + "</span>" +
      "</button>"
    );
  }).join("");

  element.querySelectorAll(".focus-btn").forEach((button) => {
    button.addEventListener("click", () => setFocusMode(button.dataset.focus));
  });
}

function getActionConfig(entry) {
  if (entry.review_status === "pending") {
    return [
      { action: "accept", label: "Accept", className: "card-action card-action-primary" },
      { action: "reject", label: "Reject", className: "card-action card-action-danger" },
    ];
  }
  if (isStale(entry)) {
    return [
      { action: "refresh", label: "Refresh", className: "card-action card-action-warn" },
    ];
  }
  return [];
}

function getActionFeedback(entry) {
  if (entry.review_status === "pending") {
    return "Pending capture stays out of active project truth until you accept or reject it.";
  }
  if (isStale(entry)) {
    return "Refresh this entry after checking it is still true in the current codebase.";
  }
  return "";
}

async function reloadDashboardData() {
  const [entries, edges, stats] = await Promise.all([
    fetchDashboard("/api/knowledge").then((response) => response.json()),
    fetchDashboard("/api/edges").then((response) => response.json()),
    fetchDashboard("/api/stats").then((response) => response.json()),
  ]);

  state.entries = entries;
  state.edges = edges;
  state.stats = stats;
}

async function runReviewAction(id, action) {
  state.pendingActionId = id + ":" + action;
  state.actionStatus = "";
  render();

  try {
    const response = await fetchDashboard("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, action }),
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Dashboard review action failed.");
    }

    await reloadDashboardData();
    const labels = {
      accept: "Accepted review item into active knowledge.",
      reject: "Rejected review item so it no longer appears as active truth.",
      refresh: "Refreshed the stale entry.",
    };
    state.actionStatus = labels[action] || "Updated knowledge.";
    const counts = getFocusCounts();
    if (state.focusMode === "attention" && counts.attention === 0) {
      state.focusMode = counts.recent > 0 ? "recent" : "all";
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.actionStatus = "Could not update review state: " + message;
  } finally {
    state.pendingActionId = null;
    renderStats();
    renderChips();
    render();
  }
}

function renderResultsSummary(visibleEntries) {
  const element = document.getElementById("results-summary");
  const total = getBrowsableEntries().length;
  const focusEntries = getFocusedEntries();
  const query = getReadableQuery();
  const filters = [];
  const focusLabel = FOCUS_MODES.find((mode) => mode.id === state.focusMode)?.label.toLowerCase() || "all knowledge";
  if (state.activeType) filters.push("type " + state.activeType);
  if (query) filters.push('search "' + query + '"');

  if (total === 0) {
    element.textContent = "No project memory yet. Capture something with ivn remember, then refresh this dashboard.";
    return;
  }

  if (filters.length === 0 && state.focusMode === "all") {
    element.textContent = "Showing all " + visibleEntries.length + " entries.";
    return;
  }

  if (filters.length === 0) {
    element.textContent = "Showing " + visibleEntries.length + " items in " + focusLabel + ".";
    return;
  }

  element.textContent =
    "Showing " + visibleEntries.length + " of " + focusEntries.length + " " + focusLabel + " items for " + filters.join(" and ") + ".";
}

function renderEmptyState(title, copy, detail) {
  return (
    '<div class="empty">' +
      '<div class="empty-title">' + title + "</div>" +
      '<div class="empty-copy">' + copy + "</div>" +
      (detail ? '<div class="empty-detail">' + detail + "</div>" : "") +
    "</div>"
  );
}

function renderActionStatus() {
  const element = document.getElementById("focus-status");
  if (!state.actionStatus) {
    element.textContent = "";
    element.dataset.state = "";
    return;
  }
  element.textContent = state.actionStatus;
  element.dataset.state = state.actionStatus.startsWith("Could not") ? "error" : "success";
}

function renderStats() {
  const entries = getBrowsableEntries();
  const element = document.getElementById("stats");
  if (entries.length === 0) {
    element.innerHTML = "";
    return;
  }

  const counts = getFocusCounts();
  const summary = [
    '<div class="stat"><div class="stat-value">' + counts.all + '</div><div class="stat-label">Total</div></div>',
    '<div class="stat"><div class="stat-value" style="color:' + TYPE_COLOR.gotcha + '">' + counts.attention + '</div><div class="stat-label">Attention</div></div>',
    '<div class="stat"><div class="stat-value" style="color:' + TYPE_COLOR.todo + '">' + counts.pending + '</div><div class="stat-label">Pending</div></div>',
    '<div class="stat"><div class="stat-value" style="color:' + TYPE_COLOR.decision + '">' + counts.recent + '</div><div class="stat-label">Recent</div></div>',
  ];

  element.innerHTML = summary.join("");
}

function renderChips() {
  const element = document.getElementById("chips");
  const entries = getBrowsableEntries();
  if (entries.length === 0) {
    element.innerHTML = "";
    return;
  }

  const counts = {};
  entries.forEach((entry) => {
    counts[entry.type] = (counts[entry.type] || 0) + 1;
  });

  element.innerHTML = TYPES
    .filter((type) => counts[type])
    .map((type) => '<button type="button" class="chip" data-type="' + type + '" aria-pressed="false">' + type + " (" + counts[type] + ")" + "</button>")
    .join("");

  element.querySelectorAll(".chip").forEach((button) => {
    button.addEventListener("click", () => toggleType(button.dataset.type));
  });

  syncChipState();
}

function syncChipState() {
  document.querySelectorAll(".chip").forEach((button) => {
    const isActive = button.dataset.type === state.activeType;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
}

function toggleType(type) {
  state.activeType = state.activeType === type ? null : type;
  syncChipState();
  render();
}

function setFocusMode(mode) {
  state.focusMode = mode || "all";
  render();
}

function setView(view) {
  state.currentView = view;
  document.querySelectorAll(".view-btn").forEach((button) => {
    const isActive = button.dataset.view === view;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  });
  document.getElementById("card-view").style.display = view === "cards" ? "block" : "none";
  document.getElementById("graph-view").style.display = view === "graph" ? "block" : "none";
  if (view === "graph") {
    requestAnimationFrame(renderGraph);
  }
}

function renderCards(entries) {
  const element = document.getElementById("card-view");
  if (entries.length === 0) {
    const totalEntries = getBrowsableEntries().length;
    const hasScopedFilter = Boolean(state.activeType || getReadableQuery());
    if (totalEntries === 0) {
      element.innerHTML = renderEmptyState(
        "No project memory yet",
        'Start by capturing a durable note with <span class="inline-code">ivn remember "..."</span>, then reopen this dashboard.',
        "Once memory exists, this view becomes the fastest way to browse it locally.",
      );
    } else if (!hasScopedFilter && state.focusMode === "attention") {
      element.innerHTML = renderEmptyState(
        "Nothing needs attention right now",
        "Pending review, stale knowledge, and open todos will surface here automatically when they exist.",
        'Switch to <span class="inline-code">All knowledge</span> to browse the full memory set.',
      );
    } else if (!hasScopedFilter && state.focusMode === "recent") {
      element.innerHTML = renderEmptyState(
        "No recently changed knowledge",
        "This lens highlights entries touched recently so you can review what is new before widening back to the full ledger.",
        'Switch to <span class="inline-code">All knowledge</span> if you want the full project memory set.',
      );
    } else {
      element.innerHTML = renderEmptyState(
        "No entries match this view",
        "Clear the search, remove the active type filter, or switch views to widen the memory you are browsing.",
        "The dashboard only shows entries that match your current query and type filter.",
      );
    }
    return;
  }

  element.innerHTML =
    '<div class="cards">' +
    entries.map((entry) => {
      const badges = [];
      if (entry.review_status === "pending") badges.push('<span class="badge badge-pending">pending review</span>');
      if (isStale(entry)) badges.push('<span class="badge badge-stale">stale</span>');
      if (entry.type === "todo") badges.push('<span class="badge badge-todo">todo</span>');
      if (entry.visibility === "private") badges.push('<span class="badge badge-private">private</span>');
      const actions = getActionConfig(entry);
      const feedback = getActionFeedback(entry);
      const tags = entry.tags.map((tag) => '<span class="tag">#' + escapeHtml(tag) + "</span>").join("");
      const summary = escapeHtml(entry.summary || entry.content);
      const showDetail = entry.summary && entry.summary !== entry.content;
      return (
        '<div class="card">' +
          '<div class="card-head">' +
            '<span class="card-type" data-t="' + entry.type + '">' + entry.type + "</span>" +
            '<span class="card-id">#' + entry.id + "</span>" +
            '<span class="card-time">' + timeAgo(getFreshnessTimestamp(entry)) + "</span>" +
          "</div>" +
          '<div class="card-summary">' + summary + "</div>" +
          (showDetail ? '<div class="card-detail">' + escapeHtml(entry.content) + "</div>" : "") +
          (badges.length ? '<div class="card-badges">' + badges.join("") + "</div>" : "") +
          (feedback ? '<div class="card-detail">' + feedback + "</div>" : "") +
          (actions.length ? '<div class="card-actions">' +
            actions.map((config) => {
              const pending = state.pendingActionId === entry.id + ":" + config.action;
              return '<button type="button" class="' + config.className + '" data-review-id="' + entry.id + '" data-review-action="' + config.action + '"' +
                (pending ? ' disabled aria-busy="true"' : "") + ">" + (pending ? "Working..." : config.label) + "</button>";
            }).join("") +
          "</div>" : "") +
          (tags ? '<div class="card-tags">' + tags + "</div>" : "") +
        "</div>"
      );
    }).join("") +
    "</div>";

  element.querySelectorAll("[data-review-action]").forEach((button) => {
    button.addEventListener("click", () => runReviewAction(button.dataset.reviewId, button.dataset.reviewAction));
  });
}

function computeGraphLayout(entries, width, height) {
  const positions = new Map();
  const typeBuckets = TYPES
    .map((type) => [type, entries.filter((entry) => entry.type === type)])
    .filter(([, bucket]) => bucket.length > 0);

  const centerX = width / 2;
  const centerY = height / 2;
  const anchorRadius = Math.max(90, Math.min(width, height) * 0.28);
  const typeCount = Math.max(typeBuckets.length, 1);

  typeBuckets.forEach(([type, bucket], typeIndex) => {
    const anchorAngle = (Math.PI * 2 * typeIndex) / typeCount - Math.PI / 2;
    const anchorX = centerX + Math.cos(anchorAngle) * anchorRadius;
    const anchorY = centerY + Math.sin(anchorAngle) * anchorRadius;
    const orbitRadius = Math.max(24, Math.min(120, 18 * bucket.length));

    bucket.forEach((entry, entryIndex) => {
      const angle = bucket.length === 1 ? 0 : (Math.PI * 2 * entryIndex) / bucket.length;
      positions.set(entry.id, {
        type,
        x: anchorX + Math.cos(angle) * orbitRadius,
        y: anchorY + Math.sin(angle) * orbitRadius,
      });
    });
  });

  return positions;
}

function renderGraph() {
  const visibleEntries = getVisibleEntries();
  const container = document.getElementById("graph-view");
  const rect = container.getBoundingClientRect();
  const width = rect.width || window.innerWidth;
  const height = rect.height || (window.innerHeight - 140);
  let svg = document.getElementById("graph-svg");
  if (!svg) {
    container.innerHTML = '<svg id="graph-svg" role="img" aria-labelledby="graph-title"><title id="graph-title">Knowledge graph</title></svg>';
    svg = document.getElementById("graph-svg");
  }

  svg.setAttribute("viewBox", "0 0 " + width + " " + height);
  svg.innerHTML = "";
  svg.insertAdjacentHTML("afterbegin", '<title id="graph-title">Knowledge graph for ' + visibleEntries.length + " entries</title>");

  if (visibleEntries.length === 0) {
    const totalEntries = getBrowsableEntries().length;
    const hasScopedFilter = Boolean(state.activeType || getReadableQuery());
    if (totalEntries === 0) {
      container.innerHTML = renderEmptyState(
        "No graph yet",
        'The graph appears after you capture project memory with <span class="inline-code">ivn remember "..."</span> or import reviewed knowledge.',
        "Cards are usually the best first view. Switch back once you want relationship context.",
      );
    } else if (!hasScopedFilter && state.focusMode === "attention") {
      container.innerHTML = renderEmptyState(
        "Nothing needs attention in graph view",
        "There are no pending, stale, or todo entries to draw right now.",
        'Switch to <span class="inline-code">All knowledge</span> or <span class="inline-code">Recently changed</span> to widen the graph.',
      );
    } else if (!hasScopedFilter && state.focusMode === "recent") {
      container.innerHTML = renderEmptyState(
        "No recent graph slice",
        "This focus mode only draws recently changed memory, so older stable knowledge stays out of the way.",
        'Switch to <span class="inline-code">All knowledge</span> for the full relationship map.',
      );
    } else {
      container.innerHTML = renderEmptyState(
        "No graph results for this filter",
        "Clear the search or type filter to bring more of the knowledge graph back into view.",
        "Only entries that match the current filters are drawn in graph mode.",
      );
    }
    return;
  }

  const visibleIds = new Set(visibleEntries.map((entry) => entry.id));
  const visibleEdges = state.edges.filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target));
  const positions = computeGraphLayout(visibleEntries, width, height);

  const xmlns = "http://www.w3.org/2000/svg";
  const background = document.createElementNS(xmlns, "rect");
  background.setAttribute("width", String(width));
  background.setAttribute("height", String(height));
  background.setAttribute("fill", "transparent");
  svg.appendChild(background);

  visibleEdges.forEach((edge) => {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) return;
    const line = document.createElementNS(xmlns, "line");
    line.setAttribute("class", "graph-edge");
    line.setAttribute("x1", String(source.x));
    line.setAttribute("y1", String(source.y));
    line.setAttribute("x2", String(target.x));
    line.setAttribute("y2", String(target.y));
    svg.appendChild(line);
  });

  visibleEntries.forEach((entry) => {
    const point = positions.get(entry.id);
    if (!point) return;

    const circle = document.createElementNS(xmlns, "circle");
    circle.setAttribute("class", "graph-node");
    circle.setAttribute("cx", String(point.x));
    circle.setAttribute("cy", String(point.y));
    circle.setAttribute("r", "12");
    circle.setAttribute("fill", TYPE_COLOR[entry.type] || "#666");
    svg.appendChild(circle);

    const text = document.createElementNS(xmlns, "text");
    text.setAttribute("class", "graph-label");
    text.setAttribute("x", String(point.x + 18));
    text.setAttribute("y", String(point.y));
    text.textContent = (entry.summary || entry.content).slice(0, 44);
    svg.appendChild(text);

    const title = document.createElementNS(xmlns, "title");
    title.textContent = entry.type.toUpperCase() + ": " + (entry.summary || entry.content);
    circle.appendChild(title);
  });
}

function render() {
  const visibleEntries = getVisibleEntries();
  renderActionStatus();
  renderFocusModes();
  renderResultsSummary(visibleEntries);
  renderCards(visibleEntries);
  if (state.currentView === "graph") {
    renderGraph();
  }
}

async function load() {
  await reloadDashboardData();

  initializeFocusMode();
  renderStats();
  renderChips();
  render();
}

document.getElementById("search").addEventListener("input", render);
document.querySelectorAll(".view-btn").forEach((button) => {
  button.addEventListener("click", () => setView(button.dataset.view));
});
window.addEventListener("resize", () => {
  if (state.currentView === "graph") {
    renderGraph();
  }
});

load().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  document.getElementById("card-view").innerHTML =
    renderEmptyState(
      "Dashboard failed to load",
      "IVN could not read local project memory. Re-run ivn web after checking that this repo is initialized with .ivn.",
      escapeHtml(message),
    );
  renderResultsSummary([]);
});
