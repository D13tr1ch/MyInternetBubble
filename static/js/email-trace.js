/**
 * EmailTrace — Scan Gmail for sender IPs via IMAP, geolocate, and display on map.
 * Credentials are sent once per scan and never stored.
 */

const EmailTrace = {

    emails: [],
    geo: {},
    scanning: false,
    _consolePollTimer: null,
    _consoleSince: 0,

    init(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = `
            <h2>Email Origin Trace</h2>
            <p class="map-subtitle">Connect to Gmail via IMAP to trace where your emails originate — credentials are used once and never stored</p>
            <div class="email-form">
                <div class="email-field">
                    <label for="email-addr">Gmail address</label>
                    <input type="email" id="email-addr" placeholder="you@gmail.com" autocomplete="email" />
                </div>
                <div class="email-field">
                    <label for="email-pass">App password</label>
                    <input type="password" id="email-pass" placeholder="xxxx xxxx xxxx xxxx" autocomplete="off" />
                    <small>One-time use only — cleared after scan. <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">Generate app password</a></small>
                </div>
                <div class="email-field email-field-count">
                    <label for="email-count">Max emails</label>
                    <input type="number" id="email-count" value="50" min="1" max="200" />
                </div>
                <div class="email-field email-field-count">
                    <label for="email-months">Lookback</label>
                    <select id="email-months">
                        <option value="1">1 month</option>
                        <option value="3">3 months</option>
                        <option value="6" selected>6 months</option>
                        <option value="12">12 months</option>
                    </select>
                </div>
                <button id="email-scan" class="map-btn map-btn-primary">Scan Emails</button>
                <span id="email-status" class="map-status"></span>
            </div>
            <div id="email-console" class="console-output email-console">
<span class="console-line"><span class="console-badge" style="color:#d29922">INFO </span><span class="console-ts">--:--:--.---</span> Waiting for scan...</span>
<span class="console-line"><span class="console-badge" style="color:#8b949e">EXAMPLE</span><span class="console-ts">12:34:56.789</span> Email trace: connecting to Gmail for use***</span>
<span class="console-line"><span class="console-badge" style="color:#8b949e">EXAMPLE</span><span class="console-ts">12:34:57.320</span> Email trace: scanning INBOX (last 6mo, max 50)</span>
<span class="console-line"><span class="console-badge" style="color:#8b949e">EXAMPLE</span><span class="console-ts">12:34:58.105</span> Email trace: scanning [Gmail]/Spam (last 6mo, max 50)</span>
<span class="console-line"><span class="console-badge" style="color:#3fb950">GEO  </span><span class="console-ts">12:34:59.440</span> 209.85.220.41 → Mountain View, US via ipwho.is</span>
<span class="console-line"><span class="console-badge" style="color:#3fb950">GEO  </span><span class="console-ts">12:35:00.112</span> 74.125.82.51 → Mountain View, US via ipapi.co</span>
<span class="console-line"><span class="console-badge" style="color:#d29922">INFO </span><span class="console-ts">12:35:01.890</span> Email trace: 38 emails, 12 unique IPs</span>
</div>
            <div id="email-results" class="email-results" style="display:none;"></div>
        `;

        document.getElementById("email-scan").addEventListener("click", () => this._scan());
    },

    async _scan() {
        if (this.scanning) return;

        const emailAddr = document.getElementById("email-addr").value.trim();
        const appPass = document.getElementById("email-pass").value.trim();
        const count = parseInt(document.getElementById("email-count").value) || 50;
        const months = parseInt(document.getElementById("email-months").value) || 6;

        if (!emailAddr || !appPass) {
            this._setStatus("Enter email and app password");
            return;
        }

        this.scanning = true;
        const btn = document.getElementById("email-scan");
        btn.disabled = true;
        btn.textContent = "Scanning...";
        this._setStatus("Connecting to Gmail...");

        // Start live console for this scan
        this._consoleSince = Date.now() / 1000 - 1;
        this._clearConsole();
        this._appendConsole("info", "Connecting to Gmail...");
        this._startConsolePoll();

        try {
            const resp = await fetch("/api/email-trace", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: emailAddr, app_password: appPass, count, months }),
            });
            const data = await resp.json();

            if (data.error) {
                this._setStatus(`Error: ${data.error}`);
                return;
            }

            this.emails = data.emails || [];
            this.geo = data.geo || {};
            this._setStatus(`${this.emails.length} emails scanned, ${data.ip_count} unique IPs`);
            this._renderResults();

            // Plot on geo map if available
            if (typeof GeoMap !== "undefined" && GeoMap.map && GeoMap.layerGroup) {
                this._plotOnMap();
            }

        } catch (err) {
            this._setStatus(`Error: ${err.message}`);
            this._appendConsole("error", err.message);
        } finally {
            this.scanning = false;
            btn.disabled = false;
            btn.textContent = "Scan Emails";
            // Clear password from DOM
            document.getElementById("email-pass").value = "";
            // Final console poll then stop
            await this._pollConsole();
            this._stopConsolePoll();
        }
    },

    _setStatus(msg) {
        const el = document.getElementById("email-status");
        if (el) el.textContent = msg;
    },

    _renderResults() {
        const container = document.getElementById("email-results");
        if (!container) return;

        if (this.emails.length === 0) {
            container.style.display = "none";
            return;
        }

        container.textContent = "";
        const title = document.createElement("h3");
        title.textContent = "Email Origins";
        container.appendChild(title);

        const wrap = document.createElement("div");
        wrap.className = "conn-table-wrap";
        const table = document.createElement("table");
        table.className = "fp-table";

        const head = document.createElement("tr");
        ["From", "Subject", "Folder", "Origin IPs", "Location"].forEach((label, idx) => {
            const cell = document.createElement("td");
            if (idx === 0) cell.className = "label";
            cell.style.fontWeight = "600";
            cell.textContent = label;
            head.appendChild(cell);
        });
        table.appendChild(head);

        for (const em of this.emails) {
            const tr = document.createElement("tr");

            const fromTd = document.createElement("td");
            fromTd.className = "label";
            fromTd.style.maxWidth = "200px";
            fromTd.style.overflow = "hidden";
            fromTd.style.textOverflow = "ellipsis";
            fromTd.textContent = em.from || "";
            tr.appendChild(fromTd);

            const subjTd = document.createElement("td");
            subjTd.style.maxWidth = "250px";
            subjTd.style.overflow = "hidden";
            subjTd.style.textOverflow = "ellipsis";
            subjTd.textContent = em.subject || "";
            tr.appendChild(subjTd);

            const folderTd = document.createElement("td");
            folderTd.textContent = em.folder === "spam" ? "spam" : (em.folder || "inbox");
            tr.appendChild(folderTd);

            const ipTd = document.createElement("td");
            if (em.ips.length > 0) {
                em.ips.forEach((ip, index) => {
                    const span = document.createElement("span");
                    span.className = "mono";
                    span.textContent = ip;
                    ipTd.appendChild(span);
                    if (index < em.ips.length - 1) ipTd.appendChild(document.createElement("br"));
                });
            } else {
                const none = document.createElement("span");
                none.style.color = "var(--text-muted)";
                none.textContent = "none";
                ipTd.appendChild(none);
            }
            tr.appendChild(ipTd);

            const locTd = document.createElement("td");
            if (em.ips.length > 0) {
                em.ips.forEach((ip, index) => {
                    const g = this.geo[ip];
                    const span = document.createElement("span");
                    span.textContent = g ? `${g.city}, ${g.country}` : "—";
                    locTd.appendChild(span);
                    if (index < em.ips.length - 1) locTd.appendChild(document.createElement("br"));
                });
            } else {
                locTd.textContent = "—";
            }
            tr.appendChild(locTd);

            table.appendChild(tr);
        }

        wrap.appendChild(table);
        container.appendChild(wrap);
        container.style.display = "block";
    },

    _plotOnMap() {
        // Add email origin IPs as purple markers on the geo map
        for (const [ip, geo] of Object.entries(this.geo)) {
            if (!geo.lat) continue;
            const latLng = [geo.lat, geo.lon];

            // Count how many emails came from this IP
            let emailCount = 0;
            for (const em of this.emails) {
                if (em.ips.includes(ip)) emailCount++;
            }

            const marker = L.circleMarker(latLng, {
                radius: Math.min(5 + emailCount, 12),
                fillColor: "#bc8cff",
                color: "#fff",
                weight: 1,
                opacity: 0.9,
                fillOpacity: 0.7,
            }).addTo(GeoMap.layerGroup);

            marker.bindPopup(
                `<div class="geo-popup"><strong>Email Origin</strong><br>` +
                `IP: ${ip}<br>${geo.city}, ${geo.country}<br>` +
                `ISP: ${geo.isp || "—"}<br>` +
                `Emails: ${emailCount}</div>`
            );
            marker.bindTooltip(`✉ ${ip}`, { direction: "top", offset: [0, -8] });

            // Draw line from self to origin
            if (GeoMap.selfLatLng) {
                L.polyline([GeoMap.selfLatLng, latLng], {
                    color: "#bc8cff",
                    weight: 1.5,
                    opacity: 0.35,
                    dashArray: "4 6",
                }).addTo(GeoMap.layerGroup);
            }
        }
    },

    // ─── Email Console helpers ───────────────────────────────

    _clearConsole() {
        const el = document.getElementById("email-console");
        if (el) el.innerHTML = "";
    },

    _appendConsole(level, msg) {
        const el = document.getElementById("email-console");
        if (!el) return;
        const colors = { req: "#58a6ff", geo: "#3fb950", info: "#d29922", error: "#f85149", email: "#bc8cff" };
        const color = colors[level] || "#8b949e";
        const t = new Date();
        const ts = t.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const ms = String(t.getMilliseconds()).padStart(3, "0");
        const line = document.createElement("div");
        line.className = "console-line";

        const badge = document.createElement("span");
        badge.className = "console-badge";
        badge.style.color = color;
        badge.textContent = level.toUpperCase().padEnd(5);

        const tsEl = document.createElement("span");
        tsEl.className = "console-ts";
        tsEl.textContent = `${ts}.${ms}`;

        line.appendChild(badge);
        line.appendChild(tsEl);
        line.appendChild(document.createTextNode(` ${msg}`));
        el.appendChild(line);
        el.scrollTop = el.scrollHeight;
    },

    _startConsolePoll() {
        this._stopConsolePoll();
        this._consolePollTimer = setInterval(() => this._pollConsole(), 800);
    },

    _stopConsolePoll() {
        if (this._consolePollTimer) {
            clearInterval(this._consolePollTimer);
            this._consolePollTimer = null;
        }
    },

    async _pollConsole() {
        try {
            const resp = await fetch(`/api/console?since=${this._consoleSince}`);
            const data = await resp.json();
            if (data.entries && data.entries.length > 0) {
                for (const e of data.entries) {
                    // Only show email/geo related entries
                    if (e.msg.includes("Email trace") || e.msg.includes("email-trace") || e.level === "geo") {
                        this._appendConsole(e.level, e.msg);
                    }
                    if (e.ts > this._consoleSince) this._consoleSince = e.ts;
                }
            }
        } catch (err) { /* ignore */ }
    },

    _escapeHtml(text) {
        const d = document.createElement("div");
        d.textContent = text;
        return d.innerHTML;
    },
};
