/**
 * Network Connection Map — Live monitor with traceroute path tracing
 * Polls connections, shows new/dropped in real-time, traces paths on click.
 */

const NetworkMap = {

    canvas: null,
    ctx: null,
    nodes: [],
    edges: [],
    width: 0,
    height: 0,
    animationId: null,
    dragNode: null,
    hoveredNode: null,
    tooltip: null,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    isPanning: false,
    panStart: { x: 0, y: 0 },

    // Live monitoring
    monitoring: false,
    pollInterval: null,
    pollRate: 5000,
    previousIPs: new Set(),
    eventLog: [],
    maxLogEntries: 200,

    // Traceroute state
    tracePaths: {},           // ip -> hops array
    traceTimestamps: {},      // ip -> Date.now() of last completed trace
    traceCooldown: 300000,    // 5 min — match server cache TTL
    traceInProgress: new Set(),
    maxConcurrentTraces: 2,
    selectedNode: null,

    // Node position cache (survives refreshes)
    positionCache: {},

    colors: {
        local: "#58a6ff",
        public: "#f85149",
        private: "#3fb950",
        process: "#bc8cff",
        "link-local": "#d29922",
        loopback: "#8b949e",
        multicast: "#db6d28",
        unknown: "#8b949e",
        hop: "#d29922",
        newConn: "#3fb950",
    },

    async init(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = `
            <h2>Live Network Monitor</h2>
            <p class="map-subtitle">Real-time TCP connections — double-click a node to trace the route</p>
            <div class="map-controls">
                <button id="map-monitor" class="map-btn map-btn-primary">Start Monitoring</button>
                <button id="map-refresh" class="map-btn">Scan Now</button>
                <button id="map-clear-traces" class="map-btn">Clear Traces</button>
                <span id="map-status" class="map-status">Ready</span>
                <div class="map-legend" id="map-legend"></div>
            </div>
            <div class="map-wrapper" id="map-wrapper">
                <canvas id="network-canvas"></canvas>
                <div id="map-tooltip" class="map-tooltip" style="display:none;"></div>
            </div>
            <div class="map-panels">
                <div id="event-log-section" class="map-panel">
                    <h3>Connection Events</h3>
                    <div id="event-log" class="event-log"></div>
                </div>
                <div id="connection-table-section" class="map-panel"></div>
            </div>
        `;

        this.canvas = document.getElementById("network-canvas");
        this.ctx = this.canvas.getContext("2d");
        this.tooltip = document.getElementById("map-tooltip");

        this._setupCanvas();
        this._bindEvents();
        this._renderLegend();
        await this.loadData();
    },

    _setupCanvas() {
        const wrapper = document.getElementById("map-wrapper");
        if (!wrapper) return;
        this.width = wrapper.clientWidth || 800;
        this.height = Math.max(550, Math.min(750, window.innerHeight * 0.6));
        const dpr = window.devicePixelRatio || 1;
        this.canvas.width = this.width * dpr;
        this.canvas.height = this.height * dpr;
        this.canvas.style.width = this.width + "px";
        this.canvas.style.height = this.height + "px";
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    },

    _bindEvents() {
        this.canvas.addEventListener("mousedown", (e) => this._onMouseDown(e));
        this.canvas.addEventListener("mousemove", (e) => this._onMouseMove(e));
        this.canvas.addEventListener("mouseup", () => this._onMouseUp());
        this.canvas.addEventListener("mouseleave", () => { this._onMouseUp(); this.tooltip.style.display = "none"; });
        this.canvas.addEventListener("wheel", (e) => this._onWheel(e), { passive: false });
        this.canvas.addEventListener("dblclick", (e) => this._onDblClick(e));

        document.getElementById("map-monitor").addEventListener("click", () => this._toggleMonitor());
        document.getElementById("map-refresh").addEventListener("click", () => this.loadData());
        document.getElementById("map-clear-traces").addEventListener("click", () => {
            this.tracePaths = {};
            this.selectedNode = null;
            this.nodes = this.nodes.filter(n => n.type !== "hop");
            this.edges = this.edges.filter(e => !e.isTrace);
        });

        window.addEventListener("resize", () => { this._setupCanvas(); });
    },

    _toggleMonitor() {
        const btn = document.getElementById("map-monitor");
        if (this.monitoring) {
            this.monitoring = false;
            clearInterval(this.pollInterval);
            this.pollInterval = null;
            btn.textContent = "Start Monitoring";
            btn.classList.remove("map-btn-active");
            this._setStatus("Monitoring stopped");
        } else {
            this.monitoring = true;
            btn.textContent = "Stop Monitoring";
            btn.classList.add("map-btn-active");
            this._setStatus("Monitoring...");
            this.pollInterval = setInterval(() => this.loadData(), this.pollRate);
        }
    },

    _setStatus(msg) {
        const el = document.getElementById("map-status");
        if (el) el.textContent = msg;
    },

    _logEvent(type, text) {
        const now = new Date().toLocaleTimeString();
        this.eventLog.unshift({ time: now, type, text });
        if (this.eventLog.length > this.maxLogEntries) this.eventLog.pop();
        this._renderEventLog();
    },

    _renderEventLog() {
        const el = document.getElementById("event-log");
        if (!el) return;
        const icons = { "new": "\u{1F7E2}", dropped: "\u{1F534}", trace: "\u{1F535}", info: "\u26AA" };
        el.innerHTML = this.eventLog.slice(0, 50).map(e =>
            `<div class="event-entry event-${e.type}"><span class="event-icon">${icons[e.type] || "\u26AA"}</span><span class="event-time">${e.time}</span> ${e.text}</div>`
        ).join("");
    },

    async loadData() {
        this._setStatus("Scanning...");
        try {
            const resp = await fetch("/api/network-connections");
            const data = await resp.json();

            const currentIPs = new Set();
            const newRemotes = [];

            for (const n of data.nodes) {
                currentIPs.add(n.ip || n.id);
                const existing = this.nodes.find(ex => ex.id === n.id);
                if (existing) {
                    existing.connection_count = n.connection_count;
                    existing.hostname = existing.hostname || n.hostname;
                    existing.label = existing.hostname || n.label;
                    existing.isNew = false;
                    existing.isFading = false;
                    existing.opacity = 1;
                } else {
                    const cached = this.positionCache[n.id];
                    const cx = this.width / 2;
                    const cy = this.height / 2;
                    const newNode = {
                        ...n,
                        x: cached ? cached.x : cx + (Math.random() - 0.5) * this.width * 0.7,
                        y: cached ? cached.y : cy + (Math.random() - 0.5) * this.height * 0.5,
                        vx: 0, vy: 0,
                        radius: this._nodeRadius(n),
                        isNew: true,
                        isFading: false,
                        opacity: 1,
                        firstSeen: Date.now(),
                    };
                    if (n.type === "local") {
                        newNode.x = cx;
                        newNode.y = cy;
                        newNode.fx = cx;
                        newNode.fy = cy;
                    }
                    this.nodes.push(newNode);
                    if (n.type === "remote") newRemotes.push(n);
                }
            }

            // Detect dropped connections
            for (const node of this.nodes) {
                if (node.type === "hop" || node.type === "local") continue;
                const key = node.ip || node.id;
                if (!currentIPs.has(key) && !node.isFading) {
                    node.isFading = true;
                    node.fadeStart = Date.now();
                    if (node.type === "remote") {
                        this._logEvent("dropped", `Disconnected: ${node.hostname || node.ip}`);
                    }
                }
            }

            // Remove fully faded nodes after 8s
            this.nodes = this.nodes.filter(n => {
                if (n.isFading && Date.now() - n.fadeStart > 8000) return false;
                return true;
            });

            // Update edges (keep trace edges)
            this.edges = this.edges.filter(e => e.isTrace);
            for (const edge of data.edges) {
                this.edges.push({ ...edge, isTrace: false });
            }

            // Log new connections (skip first load)
            for (const n of newRemotes) {
                if (this.previousIPs.size > 0) {
                    this._logEvent("new", `New connection: ${n.ip} (${n.group})`);
                }
            }
            this.previousIPs = currentIPs;

            for (const n of this.nodes) {
                this.positionCache[n.id] = { x: n.x, y: n.y };
            }

            this._applyForces(60);
            this._renderTable();
            this._setStatus(
                `${data.connection_count} connections, ${this.nodes.filter(n => n.type === "remote").length} hosts` +
                (this.monitoring ? " \u2014 monitoring" : "")
            );

            this._resolveHostnames();
        } catch (err) {
            this._setStatus(`Error: ${err.message}`);
        }

        if (!this.animationId) this._startAnimation();
    },

    async _resolveHostnames() {
        const unresolved = this.nodes.filter(n => n.type === "remote" && !n.hostname);
        for (const node of unresolved) {
            try {
                const resp = await fetch(`/api/resolve-host?ip=${encodeURIComponent(node.ip)}`);
                const data = await resp.json();
                if (data.hostname) {
                    node.hostname = data.hostname;
                    node.label = data.hostname.length > 35 ? data.hostname.substring(0, 32) + "..." : data.hostname;
                }
            } catch { /* skip */ }
        }
        this._renderTable();
    },

    async _traceRoute(node) {
        if (!node || node.type !== "remote" || this.traceInProgress.has(node.ip)) return;

        // Skip if already traced recently (cooldown)
        const lastTrace = this.traceTimestamps[node.ip];
        if (lastTrace && (Date.now() - lastTrace) < this.traceCooldown && this.tracePaths[node.ip]) {
            this._logEvent("info", `Route to ${node.hostname || node.ip} cached (${Math.round((this.traceCooldown - (Date.now() - lastTrace)) / 1000)}s remaining)`);
            return;
        }

        // Limit concurrent traces
        if (this.traceInProgress.size >= this.maxConcurrentTraces) {
            this._logEvent("info", `Max ${this.maxConcurrentTraces} concurrent traces — wait for one to finish`);
            return;
        }

        this.selectedNode = node;
        this.traceInProgress.add(node.ip);
        this._logEvent("trace", `Tracing route to ${node.hostname || node.ip}...`);
        this._setStatus(`Tracing ${node.ip}...`);

        try {
            const resp = await fetch(`/api/traceroute?ip=${encodeURIComponent(node.ip)}`);
            const data = await resp.json();

            if (data.error) {
                this._logEvent("info", data.busy ? `Server busy — try again shortly` : data.error);
            } else if (data.hops && data.hops.length > 0) {
                this.tracePaths[node.ip] = data.hops;
                this.traceTimestamps[node.ip] = Date.now();
                this._addTraceToGraph(node, data.hops);
                const suffix = data.cached ? " (cached)" : "";
                this._logEvent("trace", `Trace complete: ${data.hops.length} hops to ${node.hostname || node.ip}${suffix}`);
            } else {
                this._logEvent("info", `No hops returned for ${node.ip}`);
            }
        } catch (err) {
            this._logEvent("info", `Trace failed: ${err.message}`);
        } finally {
            this.traceInProgress.delete(node.ip);
            this._renderTable();
            this._setStatus(this.monitoring ? "Monitoring..." : "Ready");
        }
    },

    _addTraceToGraph(targetNode, hops) {
        const localNode = this.nodes.find(n => n.type === "local");
        if (!localNode) return;

        // Remove old trace for this target
        this.nodes = this.nodes.filter(n => !(n.type === "hop" && n.traceTarget === targetNode.ip));
        this.edges = this.edges.filter(e => !(e.isTrace && e.traceTarget === targetNode.ip));

        let prevNodeId = "local";
        const validHops = hops.filter(h => h.ip && !h.timeout);

        for (let i = 0; i < validHops.length; i++) {
            const hop = validHops[i];
            if (hop.ip === targetNode.ip) {
                this.edges.push({
                    source: prevNodeId, target: targetNode.id,
                    isTrace: true, traceTarget: targetNode.ip,
                    rtt: hop.rtt_ms, hopNum: hop.hop,
                    count: 1, processes: [], remote_ports: [], states: [],
                });
                break;
            }

            const hopId = `hop_${targetNode.ip}_${hop.hop}`;
            const t = (i + 1) / (validHops.length + 1);
            this.nodes.push({
                id: hopId, label: hop.ip, type: "hop",
                ip: hop.ip, group: hop.group,
                traceTarget: targetNode.ip,
                connection_count: 0, rtt_ms: hop.rtt_ms, hopNum: hop.hop,
                x: localNode.x + (targetNode.x - localNode.x) * t + (Math.random() - 0.5) * 30,
                y: localNode.y + (targetNode.y - localNode.y) * t + (Math.random() - 0.5) * 30,
                vx: 0, vy: 0, radius: 8,
                opacity: 0.85, isNew: false, isFading: false,
            });

            this.edges.push({
                source: prevNodeId, target: hopId,
                isTrace: true, traceTarget: targetNode.ip,
                rtt: hop.rtt_ms, hopNum: hop.hop,
                count: 1, processes: [], remote_ports: [], states: [],
            });
            prevNodeId = hopId;
        }

        // Ensure last hop connects to target
        if (prevNodeId !== "local" && prevNodeId !== targetNode.id) {
            if (!this.edges.find(e => e.isTrace && e.target === targetNode.id && e.traceTarget === targetNode.ip)) {
                this.edges.push({
                    source: prevNodeId, target: targetNode.id,
                    isTrace: true, traceTarget: targetNode.ip,
                    count: 1, processes: [], remote_ports: [], states: [],
                });
            }
        }
    },

    _nodeRadius(node) {
        if (node.type === "local") return 30;
        if (node.type === "process") return 14 + Math.min((node.connection_count || 1) * 2, 12);
        if (node.type === "hop") return 8;
        return 10 + Math.min((node.connection_count || 1) * 3, 14);
    },

    _applyForces(iterations) {
        for (let i = 0; i < iterations; i++) this._simulateForces();
    },

    _simulateForces() {
        const repulsion = 2500;
        const attraction = 0.004;
        const damping = 0.8;
        const cx = this.width / 2;
        const cy = this.height / 2;

        for (let i = 0; i < this.nodes.length; i++) {
            for (let j = i + 1; j < this.nodes.length; j++) {
                const a = this.nodes[i];
                const b = this.nodes[j];
                if (a.type === "hop" || b.type === "hop") continue;
                let dx = b.x - a.x;
                let dy = b.y - a.y;
                let dist = Math.sqrt(dx * dx + dy * dy) || 1;
                let force = repulsion / (dist * dist);
                let fx = (dx / dist) * force;
                let fy = (dy / dist) * force;
                if (!a.fx) { a.vx -= fx * 0.3; a.vy -= fy * 0.3; }
                if (!b.fx) { b.vx += fx * 0.3; b.vy += fy * 0.3; }
            }
        }

        for (const edge of this.edges) {
            if (edge.isTrace) continue;
            const source = this.nodes.find(n => n.id === edge.source);
            const target = this.nodes.find(n => n.id === edge.target);
            if (!source || !target) continue;
            let dx = target.x - source.x;
            let dy = target.y - source.y;
            let dist = Math.sqrt(dx * dx + dy * dy) || 1;
            let force = dist * attraction;
            let fx = (dx / dist) * force;
            let fy = (dy / dist) * force;
            if (!source.fx) { source.vx += fx; source.vy += fy; }
            if (!target.fx) { target.vx -= fx; target.vy -= fy; }
        }

        for (const n of this.nodes) {
            if (n.fx || n.type === "hop") continue;
            n.vx += (cx - n.x) * 0.008;
            n.vy += (cy - n.y) * 0.008;
            n.vx *= damping;
            n.vy *= damping;
            n.x += n.vx;
            n.y += n.vy;
            const pad = n.radius + 10;
            n.x = Math.max(pad, Math.min(this.width - pad, n.x));
            n.y = Math.max(pad, Math.min(this.height - pad, n.y));
        }
    },

    _startAnimation() {
        const step = () => {
            this._draw();
            this.animationId = requestAnimationFrame(step);
        };
        step();
    },

    _draw() {
        const ctx = this.ctx;
        ctx.save();
        ctx.clearRect(0, 0, this.width, this.height);
        ctx.translate(this.offsetX, this.offsetY);
        ctx.scale(this.scale, this.scale);

        const now = Date.now();

        // Regular edges
        for (const edge of this.edges) {
            if (edge.isTrace) continue;
            const source = this.nodes.find(n => n.id === edge.source);
            const target = this.nodes.find(n => n.id === edge.target);
            if (!source || !target) continue;

            const isHovered = this.hoveredNode &&
                (this.hoveredNode.id === source.id || this.hoveredNode.id === target.id);

            ctx.beginPath();
            ctx.moveTo(source.x, source.y);
            ctx.lineTo(target.x, target.y);
            ctx.strokeStyle = isHovered ? "#58a6ff88" : "rgba(48, 54, 61, 0.4)";
            ctx.lineWidth = isHovered ? 1.5 : Math.min(0.8 + edge.count * 0.3, 2.5);
            ctx.stroke();

            if (edge.count > 1 && this.scale > 0.6) {
                const mx = (source.x + target.x) / 2;
                const my = (source.y + target.y) / 2;
                ctx.fillStyle = "rgba(139, 148, 158, 0.5)";
                ctx.font = "9px -apple-system, sans-serif";
                ctx.textAlign = "center";
                ctx.fillText("\u00D7" + edge.count, mx, my - 3);
            }
        }

        // Trace edges (animated dashes)
        for (const edge of this.edges) {
            if (!edge.isTrace) continue;
            const source = this.nodes.find(n => n.id === edge.source);
            const target = this.nodes.find(n => n.id === edge.target);
            if (!source || !target) continue;

            ctx.beginPath();
            ctx.setLineDash([6, 4]);
            ctx.lineDashOffset = -(now / 80) % 10;
            ctx.moveTo(source.x, source.y);
            ctx.lineTo(target.x, target.y);
            ctx.strokeStyle = this.colors.hop + "aa";
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.setLineDash([]);

            if (edge.rtt != null && this.scale > 0.5) {
                const mx = (source.x + target.x) / 2;
                const my = (source.y + target.y) / 2;
                ctx.fillStyle = this.colors.hop;
                ctx.font = "9px -apple-system, sans-serif";
                ctx.textAlign = "center";
                ctx.fillText(edge.rtt + "ms", mx, my - 5);
            }
        }

        // Nodes
        for (const node of this.nodes) {
            let opacity = node.opacity || 1;
            if (node.isFading) {
                const elapsed = now - node.fadeStart;
                opacity = Math.max(0, 1 - elapsed / 8000);
                node.opacity = opacity;
            }

            let pulse = 1;
            if (node.isNew && now - node.firstSeen < 2000) {
                const t = (now - node.firstSeen) / 2000;
                pulse = 1 + Math.sin(t * Math.PI * 4) * 0.15;
            } else {
                node.isNew = false;
            }

            const isHovered = this.hoveredNode && this.hoveredNode.id === node.id;
            const isSelected = this.selectedNode && this.selectedNode.id === node.id;
            const color = this.colors[node.group] || this.colors.unknown;
            const r = node.radius * pulse;

            ctx.globalAlpha = opacity;

            // New glow
            if (node.isNew) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, r + 10, 0, Math.PI * 2);
                ctx.fillStyle = this.colors.newConn + "22";
                ctx.fill();
            }

            // Selection ring
            if (isSelected) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, r + 6, 0, Math.PI * 2);
                ctx.strokeStyle = this.colors.hop;
                ctx.lineWidth = 2;
                ctx.setLineDash([4, 3]);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            // Hover glow
            if (isHovered) {
                ctx.beginPath();
                ctx.arc(node.x, node.y, r + 5, 0, Math.PI * 2);
                ctx.fillStyle = color + "33";
                ctx.fill();
            }

            // Node body
            ctx.beginPath();
            ctx.arc(node.x, node.y, r, 0, Math.PI * 2);
            ctx.fillStyle = isHovered ? color : color + "cc";
            ctx.fill();
            ctx.strokeStyle = isHovered ? "#e6edf3" : color;
            ctx.lineWidth = isHovered ? 2 : 1;
            ctx.stroke();

            // Inner label
            ctx.fillStyle = "#fff";
            ctx.textAlign = "center";
            ctx.textBaseline = "middle";
            if (node.type === "local") {
                ctx.font = "bold 11px -apple-system, sans-serif";
                ctx.fillText("YOU", node.x, node.y);
            } else if (node.type === "hop") {
                ctx.font = "8px -apple-system, sans-serif";
                ctx.fillText(node.hopNum || "\u2022", node.x, node.y);
            } else if (node.type === "process") {
                ctx.font = "10px -apple-system, sans-serif";
                ctx.fillText("\u2699", node.x, node.y);
            }

            // Label below
            if (this.scale > 0.5 && node.type !== "hop") {
                ctx.font = "10px -apple-system, sans-serif";
                ctx.fillStyle = isHovered ? "#e6edf3" : "#8b949e";
                ctx.textAlign = "center";
                const label = (node.label || "").length > 28 ? node.label.substring(0, 25) + "..." : (node.label || "");
                ctx.fillText(label, node.x, node.y + r + 13);
            }

            // Tracing spinner
            if (this.traceInProgress.has(node.ip)) {
                const angle = (now / 300) % (Math.PI * 2);
                ctx.beginPath();
                ctx.arc(node.x, node.y, r + 8, angle, angle + Math.PI * 1.2);
                ctx.strokeStyle = this.colors.hop;
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            ctx.globalAlpha = 1;
        }

        ctx.restore();
    },

    _getMousePos(e) {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: (e.clientX - rect.left - this.offsetX) / this.scale,
            y: (e.clientY - rect.top - this.offsetY) / this.scale
        };
    },

    _findNodeAt(pos) {
        for (let i = this.nodes.length - 1; i >= 0; i--) {
            const n = this.nodes[i];
            const dx = pos.x - n.x;
            const dy = pos.y - n.y;
            if (dx * dx + dy * dy <= (n.radius + 6) * (n.radius + 6)) return n;
        }
        return null;
    },

    _onMouseDown(e) {
        const pos = this._getMousePos(e);
        const node = this._findNodeAt(pos);
        if (node) {
            this.dragNode = node;
            this.canvas.style.cursor = "grabbing";
        } else {
            this.isPanning = true;
            this.panStart = { x: e.clientX - this.offsetX, y: e.clientY - this.offsetY };
            this.canvas.style.cursor = "move";
        }
    },

    _onMouseMove(e) {
        const pos = this._getMousePos(e);
        if (this.dragNode) {
            this.dragNode.x = pos.x;
            this.dragNode.y = pos.y;
            this.positionCache[this.dragNode.id] = { x: pos.x, y: pos.y };
            return;
        }
        if (this.isPanning) {
            this.offsetX = e.clientX - this.panStart.x;
            this.offsetY = e.clientY - this.panStart.y;
            return;
        }
        const node = this._findNodeAt(pos);
        this.hoveredNode = node;
        this.canvas.style.cursor = node ? "pointer" : "default";
        if (node) {
            this._showTooltip(e, node);
        } else {
            this.tooltip.style.display = "none";
        }
    },

    _onMouseUp() {
        this.dragNode = null;
        this.isPanning = false;
        this.canvas.style.cursor = "default";
    },

    _onWheel(e) {
        e.preventDefault();
        const delta = e.deltaY > 0 ? 0.92 : 1.08;
        const newScale = Math.max(0.25, Math.min(4, this.scale * delta));
        const rect = this.canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        this.offsetX = mx - (mx - this.offsetX) * (newScale / this.scale);
        this.offsetY = my - (my - this.offsetY) * (newScale / this.scale);
        this.scale = newScale;
    },

    _onDblClick(e) {
        const pos = this._getMousePos(e);
        const node = this._findNodeAt(pos);
        if (node && node.type === "remote") {
            this._traceRoute(node);
        }
    },

    _showTooltip(e, node) {
        let html = `<strong>${node.label}</strong>`;
        if (node.ip && node.type !== "process") html += `<br>IP: ${node.ip}`;
        if (node.hostname && node.hostname !== node.label) html += `<br>Host: ${node.hostname}`;
        if (node.group) html += `<br>Type: <span style="color:${this.colors[node.group]}">${node.group}</span>`;
        if (node.connection_count) html += `<br>Connections: ${node.connection_count}`;

        if (node.type === "remote") {
            const edge = this.edges.find(e => !e.isTrace && e.target === node.id);
            if (edge) {
                html += `<br>Processes: ${edge.processes.join(", ")}`;
                html += `<br>Ports: ${edge.remote_ports.slice(0, 6).join(", ")}`;
                html += `<br>States: ${edge.states.join(", ")}`;
            }
            html += `<br><em style="color:#d29922">Double-click to trace route</em>`;
        }

        if (node.type === "hop") {
            if (node.rtt_ms != null) html += `<br>RTT: ${node.rtt_ms}ms`;
            html += `<br>Hop #${node.hopNum}`;
        }

        if (node.type === "process" && node.remote_targets) {
            html += `<br>Targets: ${node.remote_targets.length} IPs`;
        }

        this.tooltip.innerHTML = html;
        this.tooltip.style.display = "block";
        const rect = this.canvas.getBoundingClientRect();
        let left = e.clientX - rect.left + 15;
        let top = e.clientY - rect.top - 10;
        if (left + 280 > this.width) left = left - 300;
        this.tooltip.style.left = left + "px";
        this.tooltip.style.top = top + "px";
    },

    _renderLegend() {
        const legend = document.getElementById("map-legend");
        if (!legend) return;
        const items = [
            ["local", "Your machine"], ["public", "Public IP"],
            ["private", "Private/LAN"], ["process", "Process"], ["hop", "Trace hop"],
        ];
        legend.innerHTML = items.map(([group, label]) =>
            `<span class="legend-item"><span class="legend-dot" style="background:${this.colors[group]}"></span>${label}</span>`
        ).join("");
    },

    _renderTable() {
        const section = document.getElementById("connection-table-section");
        if (!section) return;
        const remoteNodes = this.nodes.filter(n => n.type === "remote" && !n.isFading);

        if (remoteNodes.length === 0) {
            section.innerHTML = `<h3>Connections</h3><p style="color:#8b949e;">No active remote connections.</p>`;
            return;
        }

        remoteNodes.sort((a, b) => (b.connection_count || 0) - (a.connection_count || 0));

        let html = `<h3>Active Connections (${remoteNodes.length} hosts)</h3><div class="conn-table-wrap"><table class="fp-table">
            <tr><td class="label" style="font-weight:600;">Host</td><td style="font-weight:600;">IP</td><td style="font-weight:600;">Type</td><td style="font-weight:600;">#</td><td style="font-weight:600;">Process</td><td style="font-weight:600;">Trace</td></tr>`;

        for (const node of remoteNodes) {
            const edge = this.edges.find(e => !e.isTrace && e.target === node.id);
            const processes = edge ? edge.processes.join(", ") : "";
            const hasTrace = !!this.tracePaths[node.ip];
            const tracing = this.traceInProgress.has(node.ip);
            let traceCell;
            if (tracing) {
                traceCell = `<span class="trace-badge tracing">Tracing...</span>`;
            } else if (hasTrace) {
                traceCell = `<span class="trace-badge">\u2713 ${this.tracePaths[node.ip].length} hops</span>`;
            } else {
                traceCell = `<button class="trace-btn" data-ip="${node.ip}">Trace</button>`;
            }

            html += `<tr>
                <td class="label">${node.hostname || node.ip}</td>
                <td class="mono">${node.ip}</td>
                <td><span class="tag" style="border-color:${this.colors[node.group]}">${node.group}</span></td>
                <td>${node.connection_count || 1}</td>
                <td>${processes}</td>
                <td>${traceCell}</td>
            </tr>`;
        }

        html += `</table></div>`;
        section.innerHTML = html;

        section.querySelectorAll(".trace-btn").forEach(btn => {
            btn.addEventListener("click", () => {
                const ip = btn.dataset.ip;
                const node = this.nodes.find(n => n.ip === ip && n.type === "remote");
                if (node) this._traceRoute(node);
            });
        });
    }
};
