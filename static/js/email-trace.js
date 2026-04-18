/**
 * EmailTrace — Scan Gmail for sender IPs via IMAP, geolocate, and display on map.
 * Credentials are sent once per scan and never stored.
 */

const EmailTrace = {

    emails: [],
    geo: {},
    scanning: false,

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
                    <small><a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">Generate app password</a></small>
                </div>
                <div class="email-field email-field-count">
                    <label for="email-count">Emails to scan</label>
                    <input type="number" id="email-count" value="20" min="1" max="50" />
                </div>
                <button id="email-scan" class="map-btn map-btn-primary">Scan Emails</button>
                <span id="email-status" class="map-status"></span>
            </div>
            <div id="email-results" class="email-results" style="display:none;"></div>
        `;

        document.getElementById("email-scan").addEventListener("click", () => this._scan());
    },

    async _scan() {
        if (this.scanning) return;

        const emailAddr = document.getElementById("email-addr").value.trim();
        const appPass = document.getElementById("email-pass").value.trim();
        const count = parseInt(document.getElementById("email-count").value) || 20;

        if (!emailAddr || !appPass) {
            this._setStatus("Enter email and app password");
            return;
        }

        this.scanning = true;
        const btn = document.getElementById("email-scan");
        btn.disabled = true;
        btn.textContent = "Scanning...";
        this._setStatus("Connecting to Gmail...");

        try {
            const resp = await fetch("/api/email-trace", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email: emailAddr, app_password: appPass, count }),
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
        } finally {
            this.scanning = false;
            btn.disabled = false;
            btn.textContent = "Scan Emails";
            // Clear password from DOM
            document.getElementById("email-pass").value = "";
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

        let html = `<h3>Email Origins</h3>
            <div class="conn-table-wrap"><table class="fp-table">
            <tr>
                <td class="label" style="font-weight:600">From</td>
                <td style="font-weight:600">Subject</td>
                <td style="font-weight:600">Origin IPs</td>
                <td style="font-weight:600">Location</td>
            </tr>`;

        for (const em of this.emails) {
            const from = this._escapeHtml(em.from);
            const subj = this._escapeHtml(em.subject);
            const ipCells = em.ips.length > 0
                ? em.ips.map(ip => `<span class="mono">${ip}</span>`).join("<br>")
                : '<span style="color:var(--text-muted)">none</span>';
            const locCells = em.ips.length > 0
                ? em.ips.map(ip => {
                    const g = this.geo[ip];
                    return g ? `${g.city}, ${g.country}` : "—";
                }).join("<br>")
                : "—";

            html += `<tr>
                <td class="label" style="max-width:200px;overflow:hidden;text-overflow:ellipsis">${from}</td>
                <td style="max-width:250px;overflow:hidden;text-overflow:ellipsis">${subj}</td>
                <td>${ipCells}</td>
                <td>${locCells}</td>
            </tr>`;
        }

        html += `</table></div>`;
        container.innerHTML = html;
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

    _escapeHtml(text) {
        const d = document.createElement("div");
        d.textContent = text;
        return d.innerHTML;
    },
};
