/**
 * GeoMap — Geographic map of connections with traceroute hop paths.
 * Phase 1: Instant geolocate of all destinations via /api/geolocate (< 2s).
 * Phase 2: Progressive traceroute per IP via /api/traceroute, adding hops live.
 * Uses Leaflet + CartoDB dark tiles, canvas renderer for performance.
 */

const GeoMap = {

    map: null,
    layerGroup: null,        // base layer — destination pins + direct lines
    hopLayerGroup: null,     // hop layer — traceroute hops + path lines (added progressively)
    selfLatLng: null,
    connectionData: null,
    geoResults: {},          // ip -> geo object from /api/geolocate
    traceData: {},           // ip -> {hops: [...], geoHops: [...]}
    _tracing: false,         // whether phase 2 is in progress
    _traceAbort: false,      // signal to stop tracing

    colors: {
        self:    "#58a6ff",
        hop:     "#d29922",
        hopPrivate: "#8b949e",
        line:    "#f8514966",
        hopLine: "#d2992266",
    },

    // Heat color: 0.0 = cool (green) -> 0.5 (yellow) -> 1.0 = hot (red)
    _heatColor(t) {
        t = Math.max(0, Math.min(1, t));
        let r, g, b;
        if (t < 0.5) {
            // green -> yellow
            r = Math.round(255 * (t * 2));
            g = 255;
            b = 0;
        } else {
            // yellow -> red
            r = 255;
            g = Math.round(255 * (1 - (t - 0.5) * 2));
            b = 0;
        }
        return `rgb(${r},${g},${b})`;
    },

    async init(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = `
            <h2>Connection World Map</h2>
            <p class="map-subtitle">Geographic locations of active connections — click Trace Routes for hop paths</p>
            <div class="geo-controls">
                <button id="geo-refresh" class="map-btn">Refresh</button>
                <button id="geo-trace" class="map-btn" disabled>Trace Routes</button>
                <button id="geo-fit" class="map-btn">Fit All</button>
                <span id="geo-status" class="map-status">Loading map...</span>
            </div>
            <div id="geo-map-container" style="height:520px; border-radius:8px; border:1px solid var(--border); overflow:hidden;"></div>
            <div id="geo-table-section" class="geo-table-section"></div>
        `;

        this.map = L.map("geo-map-container", {
            center: [30, 0],
            zoom: 2,
            zoomControl: true,
            preferCanvas: true,
        });

        L.tileLayer("https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png", {
            attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
            subdomains: "abcd",
            maxZoom: 19,
        }).addTo(this.map);

        this.layerGroup = L.layerGroup().addTo(this.map);
        this.hopLayerGroup = L.layerGroup().addTo(this.map);
        this._addLegend();

        // Force Leaflet to recalculate container size (safety net if parent was recently shown)
        setTimeout(() => this.map.invalidateSize(), 100);

        document.getElementById("geo-refresh").addEventListener("click", () => {
            this._traceAbort = true;
            this.loadConnections();
        });
        document.getElementById("geo-trace").addEventListener("click", () => this._startTracing());
        document.getElementById("geo-fit").addEventListener("click", () => this._fitAll());

        await this.loadConnections();
    },

    // ─── PHASE 1: Fast geolocate destinations ────────────────────────
    async loadConnections() {
        this._traceAbort = true;
        this._setStatus("Fetching connections...");
        this.layerGroup.clearLayers();
        this.hopLayerGroup.clearLayers();
        this.geoResults = {};
        this.traceData = {};
        this.selfLatLng = null;
        this._maxConns = null;

        try {
            const connResp = await fetch("/api/network-connections");
            this.connectionData = await connResp.json();

            const publicIPs = this.connectionData.nodes
                .filter(n => n.type === "remote" && n.group === "public")
                .map(n => n.ip);

            if (publicIPs.length === 0) {
                this._setStatus("No public connections to map.");
                this._renderTable();
                return;
            }

            this._setStatus(`Geolocating ${publicIPs.length} destinations...`);

            const geoResp = await fetch("/api/geolocate", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ips: publicIPs }),
            });
            const geoData = await geoResp.json();
            this.geoResults = geoData.results || {};

            // Plot self
            if (geoData.self_geo && geoData.self_geo.lat != null) {
                this.selfLatLng = [geoData.self_geo.lat, geoData.self_geo.lon];
                const sm = L.circleMarker(this.selfLatLng, {
                    radius: 10, fillColor: this.colors.self,
                    color: "#fff", weight: 2, opacity: 1, fillOpacity: 0.9,
                }).addTo(this.layerGroup);
                sm.bindPopup(
                    `<div class="geo-popup"><strong>Your Location</strong><br>` +
                    `IP: ${geoData.self_ip}<br>${geoData.self_geo.city}, ${geoData.self_geo.region}<br>` +
                    `${geoData.self_geo.country}<br>ISP: ${geoData.self_geo.isp}<br>${geoData.self_geo.as}</div>`
                );
                sm.bindTooltip("You", { direction: "top", offset: [0, -12] });
            }

            // Plot destinations with direct lines
            let plotted = 0;
            for (const [ip, geo] of Object.entries(this.geoResults)) {
                if (geo.lat == null) continue;
                this._plotDestination(ip, geo);
                plotted++;
            }

            this._fitAll();
            this._renderTable();

            const traceBtn = document.getElementById("geo-trace");
            if (traceBtn) { traceBtn.disabled = false; }

            this._setStatus(`${plotted} destinations mapped — click "Trace Routes" for hop paths`);

            // Auto-start tracing
            this._startTracing();

        } catch (err) {
            this._setStatus(`Error: ${err.message}`);
        }
    },

    _plotDestination(ip, geo) {
        const latLng = [geo.lat, geo.lon];
        const node = this.connectionData.nodes.find(n => n.ip === ip);
        const edge = this.connectionData.edges.find(e => e.target === `remote_${ip}`);
        const connCount = node ? node.connection_count : 1;
        const processes = edge ? edge.processes.join(", ") : "unknown";
        const ports = edge ? edge.remote_ports.slice(0, 5).join(", ") : "";

        // Compute max connection count across all public nodes for normalization
        if (!this._maxConns) {
            this._maxConns = Math.max(1, ...this.connectionData.nodes
                .filter(n => n.type === "remote" && n.group === "public")
                .map(n => n.connection_count || 1));
        }

        // Heat: normalize connection count — more connections = hotter
        const heat = Math.log2(1 + connCount) / Math.log2(1 + this._maxConns);
        const color = this._heatColor(heat);
        const radius = Math.min(6 + connCount * 2.5, 22);

        const dm = L.circleMarker(latLng, {
            radius, fillColor: color, color: color,
            weight: 1.5, opacity: 0.9, fillOpacity: 0.75,
        }).addTo(this.layerGroup);

        dm.bindPopup(
            `<div class="geo-popup"><strong>${geo.city || "Unknown"}, ${geo.country || ""}</strong><br>` +
            `IP: ${ip}<br>ISP: ${geo.isp}<br>Org: ${geo.org}<br>AS: ${geo.as}<br>` +
            `Connections: ${connCount}<br>Process: ${processes}<br>Ports: ${ports}</div>`
        );
        dm.bindTooltip(`${ip} — ${geo.city || geo.country} (${connCount})`, {
            direction: "top", offset: [0, -radius],
        });

        // Direct line to self
        if (this.selfLatLng) {
            L.polyline([this.selfLatLng, latLng], {
                color: this.colors.line, weight: 1, opacity: 0.25, dashArray: "4 6",
            }).addTo(this.layerGroup);
        }
    },

    // ─── PHASE 2: Progressive traceroute ─────────────────────────────
    async _startTracing() {
        if (this._tracing) return;
        const ips = Object.keys(this.geoResults);
        if (ips.length === 0) return;

        this._tracing = true;
        this._traceAbort = false;
        this.hopLayerGroup.clearLayers();

        const traceBtn = document.getElementById("geo-trace");
        if (traceBtn) { traceBtn.disabled = true; traceBtn.textContent = "Tracing..."; }

        let traced = 0;
        for (const ip of ips) {
            if (this._traceAbort) break;

            this._setStatus(`Tracing ${traced + 1}/${ips.length}: ${ip}...`);

            try {
                const resp = await fetch(`/api/traceroute?ip=${encodeURIComponent(ip)}`);
                if (!resp.ok) {
                    // 429 = busy, skip and continue
                    if (resp.status === 429) {
                        this._setStatus(`Traceroute busy, skipping ${ip}...`);
                        continue;
                    }
                    continue;
                }
                const data = await resp.json();
                const hops = data.hops || [];

                // Collect public hop IPs for geolocating
                const hopPublicIPs = hops
                    .filter(h => h.ip && !h.timeout)
                    .map(h => h.ip)
                    .filter(hip => {
                        try {
                            const parts = hip.split(".");
                            const first = parseInt(parts[0]);
                            // Quick private check — 10.x, 172.16-31.x, 192.168.x
                            if (first === 10) return false;
                            if (first === 172 && parseInt(parts[1]) >= 16 && parseInt(parts[1]) <= 31) return false;
                            if (first === 192 && parseInt(parts[1]) === 168) return false;
                            if (first === 127) return false;
                            return true;
                        } catch(e) { return false; }
                    });

                // Batch geolocate hop IPs (skip already cached ones — server caches too)
                let hopGeo = {};
                if (hopPublicIPs.length > 0) {
                    try {
                        const gResp = await fetch("/api/geolocate", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ ips: hopPublicIPs }),
                        });
                        const gData = await gResp.json();
                        hopGeo = gData.results || {};
                    } catch(e) { /* geo failed, still show trace without locations */ }
                }

                // Store and plot
                this.traceData[ip] = { hops, hopGeo };
                this._plotHopChain(ip, hops, hopGeo);
                traced++;

            } catch (err) {
                // Network error — skip this IP
            }
        }

        this._tracing = false;
        this._traceAbort = false;
        if (traceBtn) { traceBtn.disabled = false; traceBtn.textContent = "Trace Routes"; }

        let totalHops = 0;
        for (const t of Object.values(this.traceData)) {
            totalHops += Object.keys(t.hopGeo).length;
        }
        this._setStatus(`${Object.keys(this.geoResults).length} destinations, ${traced} traced, ${totalHops} hops mapped`);
        this._renderTable();
    },

    _plotHopChain(ip, hops, hopGeo) {
        if (!this.selfLatLng) return;
        const destGeo = this.geoResults[ip];
        if (!destGeo || destGeo.lat == null) return;
        const destLatLng = [destGeo.lat, destGeo.lon];

        // Build full hop list with interpolated positions for unknowns.
        // Anchor points: self (index 0), any geolocated hop, dest (last).
        const anchors = [{ idx: 0, latLng: this.selfLatLng }];
        for (let i = 0; i < hops.length; i++) {
            const h = hops[i];
            if (h.ip && hopGeo[h.ip] && hopGeo[h.ip].lat != null) {
                anchors.push({ idx: i + 1, latLng: [hopGeo[h.ip].lat, hopGeo[h.ip].lon] });
            }
        }
        anchors.push({ idx: hops.length + 1, latLng: destLatLng });

        // Interpolate: for each hop, find surrounding anchors and lerp
        function lerpLatLng(a, b, t) {
            return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
        }
        function getPosition(idx) {
            for (let a = 0; a < anchors.length - 1; a++) {
                if (idx >= anchors[a].idx && idx <= anchors[a + 1].idx) {
                    const span = anchors[a + 1].idx - anchors[a].idx;
                    const t = span === 0 ? 0 : (idx - anchors[a].idx) / span;
                    return lerpLatLng(anchors[a].latLng, anchors[a + 1].latLng, t);
                }
            }
            return anchors[anchors.length - 1].latLng;
        }

        // Plot every hop (geolocated = yellow, private/timeout = gray, interpolated position)
        const chain = [this.selfLatLng];
        for (let i = 0; i < hops.length; i++) {
            const hop = hops[i];
            const hopIdx = i + 1;
            const g = hop.ip ? hopGeo[hop.ip] : null;
            const hasGeo = g && g.lat != null;
            const hLatLng = hasGeo ? [g.lat, g.lon] : getPosition(hopIdx);
            chain.push(hLatLng);

            const isPrivate = !hasGeo;
            const hm = L.circleMarker(hLatLng, {
                radius: isPrivate ? 3 : 4,
                fillColor: isPrivate ? this.colors.hopPrivate : this.colors.hop,
                color: isPrivate ? this.colors.hopPrivate : this.colors.hop,
                weight: 1,
                opacity: isPrivate ? 0.5 : 0.8,
                fillOpacity: isPrivate ? 0.3 : 0.6,
            }).addTo(this.hopLayerGroup);

            const rttStr = hop.rtt_ms != null ? `${hop.rtt_ms}ms` : (hop.timeout ? "timeout" : "?");
            const label = hop.ip || "*";
            const locStr = hasGeo ? `${g.city || ""}, ${g.country || ""}` : (hop.timeout ? "timeout" : "private/unknown");
            hm.bindTooltip(
                `Hop ${hop.hop}: ${label} (${rttStr})<br>${locStr}`,
                { direction: "top", offset: [0, -5] }
            );
        }
        chain.push(destLatLng);

        // Draw polyline through all hops
        if (chain.length > 2) {
            L.polyline(chain, {
                color: this.colors.hopLine, weight: 2, opacity: 0.5, dashArray: "3 5",
            }).addTo(this.hopLayerGroup);
        }
    },

    // ─── Shared helpers ──────────────────────────────────────────────
    _fitAll() {
        const allLatLngs = [];
        if (this.selfLatLng) allLatLngs.push(this.selfLatLng);
        this.layerGroup.eachLayer(l => {
            if (l.getLatLng) allLatLngs.push(l.getLatLng());
        });
        if (allLatLngs.length > 1) {
            this.map.fitBounds(L.latLngBounds(allLatLngs).pad(0.1));
        } else if (allLatLngs.length === 1) {
            this.map.setView(allLatLngs[0], 6);
        }
    },

    _addLegend() {
        const legend = L.control({ position: "bottomright" });
        legend.onAdd = () => {
            const div = L.DomUtil.create("div", "geo-legend");
            div.innerHTML =
                `<span><i style="background:${this.colors.self}"></i> You</span>` +
                `<span><i style="background:rgb(0,255,0)"></i> Low traffic</span>` +
                `<span><i style="background:rgb(255,255,0)"></i> Medium</span>` +
                `<span><i style="background:rgb(255,0,0)"></i> High traffic</span>` +
                `<span><i style="background:${this.colors.hop}"></i> Hop</span>` +
                `<span><i style="background:${this.colors.hopPrivate}"></i> Hop (private)</span>`;
            return div;
        };
        legend.addTo(this.map);
    },

    _renderTable() {
        const section = document.getElementById("geo-table-section");
        if (!section) return;

        const entries = Object.entries(this.geoResults).filter(([, g]) => g && g.lat != null);
        if (entries.length === 0) {
            section.innerHTML = `<p style="color:var(--text-muted);margin-top:0.5rem;">No geolocated connections.</p>`;
            return;
        }

        entries.sort((a, b) => {
            const ca = `${a[1].country}${a[1].city}`;
            const cb = `${b[1].country}${b[1].city}`;
            return ca.localeCompare(cb);
        });

        let html = `<h3>Connection Locations (${entries.length})</h3><div class="conn-table-wrap"><table class="fp-table">
            <tr>
                <td class="label" style="font-weight:600;">IP</td>
                <td style="font-weight:600;">City</td>
                <td style="font-weight:600;">Country</td>
                <td style="font-weight:600;">ISP / Org</td>
                <td style="font-weight:600;">Hops</td>
                <td style="font-weight:600;">#</td>
            </tr>`;

        for (const [ip, geo] of entries) {
            const node = this.connectionData
                ? this.connectionData.nodes.find(n => n.ip === ip) : null;
            const count = node ? node.connection_count : 1;

            const td = this.traceData[ip];
            const hopsCol = td
                ? `${Object.keys(td.hopGeo).length}/${td.hops.length}`
                : `\u2014`;

            html += `<tr>
                <td class="mono">${ip}</td>
                <td>${geo.city || "\u2014"}${geo.region ? ", " + geo.region : ""}</td>
                <td>${geo.country || "\u2014"}</td>
                <td>${geo.isp || geo.org || "\u2014"}</td>
                <td>${hopsCol}</td>
                <td>${count}</td>
            </tr>`;
        }

        html += `</table></div>`;
        section.innerHTML = html;
    },

    _setStatus(msg) {
        const el = document.getElementById("geo-status");
        if (el) el.textContent = msg;
    },
};
