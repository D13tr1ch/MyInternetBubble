/**
 * Digital Fingerprint Collector
 * Gathers browser, device, and network fingerprint data entirely client-side,
 * then sends it to the local server for scoring.
 */

const FingerprintCollector = {

    /** Collect all fingerprint data and return as an object */
    async collectAll() {
        const results = {};

        // Basic browser properties
        results.userAgent = navigator.userAgent;
        results.platform = navigator.platform;
        results.language = navigator.language;
        results.languages = navigator.languages ? [...navigator.languages] : [];
        results.cookiesEnabled = navigator.cookieEnabled;
        results.doNotTrack = navigator.doNotTrack === "1" || navigator.doNotTrack === "yes";
        results.hardwareConcurrency = navigator.hardwareConcurrency || null;
        results.deviceMemory = navigator.deviceMemory || null;
        results.maxTouchPoints = navigator.maxTouchPoints || 0;
        results.touchSupport = "ontouchstart" in window || results.maxTouchPoints > 0;

        // Screen
        results.screenResolution = `${screen.width}x${screen.height}`;
        results.availableResolution = `${screen.availWidth}x${screen.availHeight}`;
        results.colorDepth = screen.colorDepth;
        results.pixelDepth = screen.pixelDepth;
        results.devicePixelRatio = window.devicePixelRatio || 1;

        // Timezone
        results.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
        results.timezoneOffset = new Date().getTimezoneOffset();

        // Connection info
        if (navigator.connection) {
            results.connection = {
                effectiveType: navigator.connection.effectiveType,
                downlink: navigator.connection.downlink,
                rtt: navigator.connection.rtt,
                saveData: navigator.connection.saveData
            };
        }

        // Plugins
        results.plugins = this._getPlugins();

        // Storage support
        results.localStorage = this._testStorage("localStorage");
        results.sessionStorage = this._testStorage("sessionStorage");
        results.indexedDB = !!window.indexedDB;

        // Canvas fingerprint
        results.canvasHash = await this._getCanvasFingerprint();
        results.canvasDataURL = this._getCanvasImage();

        // WebGL
        const webgl = this._getWebGLInfo();
        results.webglVendor = webgl.vendor;
        results.webglRenderer = webgl.renderer;
        results.webglVersion = webgl.version;
        results.webglExtensions = webgl.extensions;

        // Audio fingerprint
        results.audioHash = await this._getAudioFingerprint();

        // Font detection
        results.fonts = this._detectFonts();

        // WebRTC local IPs
        results.webrtcLeaks = await this._getWebRTCLeaks();

        // Media devices
        results.mediaDevices = await this._getMediaDevices();

        // Misc
        results.pdfViewerEnabled = navigator.pdfViewerEnabled ?? null;
        results.webdriver = navigator.webdriver || false;
        results.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        results.darkMode = window.matchMedia("(prefers-color-scheme: dark)").matches;
        results.hdr = window.matchMedia("(dynamic-range: high)").matches;

        return results;
    },

    _getPlugins() {
        const plugins = [];
        if (navigator.plugins) {
            for (let i = 0; i < navigator.plugins.length; i++) {
                plugins.push({
                    name: navigator.plugins[i].name,
                    filename: navigator.plugins[i].filename
                });
            }
        }
        return plugins;
    },

    _testStorage(type) {
        try {
            const s = window[type];
            s.setItem("__fp_test", "1");
            s.removeItem("__fp_test");
            return true;
        } catch {
            return false;
        }
    },

    async _getCanvasFingerprint() {
        try {
            const canvas = document.createElement("canvas");
            canvas.width = 256;
            canvas.height = 128;
            const ctx = canvas.getContext("2d");

            // Draw a complex scene that varies by GPU/driver/font renderer
            ctx.fillStyle = "#f60";
            ctx.fillRect(10, 10, 100, 50);
            ctx.fillStyle = "#069";
            ctx.font = "14px Arial";
            ctx.fillText("Fingerprint ✈ 🌍", 2, 90);
            ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
            ctx.fillRect(50, 30, 80, 60);

            // Arc
            ctx.beginPath();
            ctx.arc(50, 50, 30, 0, Math.PI * 2);
            ctx.fillStyle = "#e8a";
            ctx.fill();

            const dataURL = canvas.toDataURL();
            return await this._hash(dataURL);
        } catch {
            return null;
        }
    },

    _getCanvasImage() {
        try {
            const canvas = document.createElement("canvas");
            canvas.width = 256;
            canvas.height = 128;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#f60";
            ctx.fillRect(10, 10, 100, 50);
            ctx.fillStyle = "#069";
            ctx.font = "14px Arial";
            ctx.fillText("Fingerprint ✈ 🌍", 2, 90);
            ctx.fillStyle = "rgba(102, 204, 0, 0.7)";
            ctx.fillRect(50, 30, 80, 60);
            ctx.beginPath();
            ctx.arc(50, 50, 30, 0, Math.PI * 2);
            ctx.fillStyle = "#e8a";
            ctx.fill();
            return canvas.toDataURL();
        } catch {
            return null;
        }
    },

    _getWebGLInfo() {
        const result = { vendor: null, renderer: null, version: null, extensions: [] };
        try {
            const canvas = document.createElement("canvas");
            const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");
            if (!gl) return result;

            result.version = gl.getParameter(gl.VERSION);
            const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
            if (debugInfo) {
                result.vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
                result.renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
            }
            result.extensions = gl.getSupportedExtensions() || [];
        } catch { /* WebGL not available */ }
        return result;
    },

    async _getAudioFingerprint() {
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const oscillator = audioCtx.createOscillator();
            const analyser = audioCtx.createAnalyser();
            const gain = audioCtx.createGain();
            const compressor = audioCtx.createDynamicsCompressor();

            oscillator.type = "triangle";
            oscillator.frequency.setValueAtTime(10000, audioCtx.currentTime);
            gain.gain.setValueAtTime(0, audioCtx.currentTime);

            oscillator.connect(compressor);
            compressor.connect(analyser);
            analyser.connect(gain);
            gain.connect(audioCtx.destination);

            oscillator.start(0);

            await new Promise(r => setTimeout(r, 100));

            const data = new Float32Array(analyser.frequencyBinCount);
            analyser.getFloatFrequencyData(data);
            oscillator.stop();
            await audioCtx.close();

            const sum = data.reduce((acc, val) => acc + Math.abs(val), 0);
            return await this._hash(sum.toString());
        } catch {
            return null;
        }
    },

    _detectFonts() {
        const testFonts = [
            "Arial", "Arial Black", "Verdana", "Helvetica", "Times New Roman",
            "Georgia", "Courier New", "Comic Sans MS", "Impact", "Trebuchet MS",
            "Lucida Console", "Tahoma", "Palatino Linotype", "Segoe UI",
            "Roboto", "Open Sans", "Consolas", "Fira Code", "JetBrains Mono",
            "Calibri", "Cambria", "Candara", "Garamond", "Century Gothic",
            "Franklin Gothic Medium", "Futura", "Gill Sans", "Myriad Pro",
            "Noto Sans", "Source Code Pro", "Ubuntu", "Monaco", "Menlo",
            "Cascadia Code", "SF Pro Display", "Inter", "Lato", "Montserrat",
            "Wingdings", "Symbol", "MS Gothic", "MS PGothic"
        ];

        const baseFonts = ["monospace", "sans-serif", "serif"];
        const testString = "mmmmmmmmmmlli";
        const testSize = "72px";

        const span = document.createElement("span");
        span.style.position = "absolute";
        span.style.left = "-9999px";
        span.style.top = "-9999px";
        span.style.fontSize = testSize;
        span.style.lineHeight = "normal";
        span.textContent = testString;
        document.body.appendChild(span);

        // Get baseline widths
        const baseWidths = {};
        for (const base of baseFonts) {
            span.style.fontFamily = base;
            baseWidths[base] = span.offsetWidth;
        }

        const detected = [];
        for (const font of testFonts) {
            let found = false;
            for (const base of baseFonts) {
                span.style.fontFamily = `'${font}', ${base}`;
                if (span.offsetWidth !== baseWidths[base]) {
                    found = true;
                    break;
                }
            }
            if (found) detected.push(font);
        }

        document.body.removeChild(span);
        return detected;
    },

    async _getWebRTCLeaks() {
        return new Promise((resolve) => {
            const ips = [];
            try {
                const pc = new RTCPeerConnection({
                    iceServers: [] // No external STUN — local only
                });
                pc.createDataChannel("");
                pc.createOffer().then(offer => pc.setLocalDescription(offer));
                pc.onicecandidate = (event) => {
                    if (!event || !event.candidate) {
                        pc.close();
                        resolve(ips);
                        return;
                    }
                    const parts = event.candidate.candidate.split(" ");
                    const ip = parts[4];
                    if (ip && !ips.includes(ip) && ip !== "0.0.0.0") {
                        ips.push(ip);
                    }
                };
                // Timeout after 3 seconds
                setTimeout(() => { pc.close(); resolve(ips); }, 3000);
            } catch {
                resolve(ips);
            }
        });
    },

    async _getMediaDevices() {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            return devices.map(d => ({
                kind: d.kind,
                label: d.label || "(requires permission)",
                groupId: d.groupId?.substring(0, 8)
            }));
        } catch {
            return [];
        }
    },

    async _hash(str) {
        const msgBuffer = new TextEncoder().encode(str);
        const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
    }
};

// ----- Dashboard Controller -----
const Dashboard = {

    browserData: null,
    networkData: null,
    summaryData: null,

    async init() {
        this._showLoading(true);
        try {
            // Collect browser fingerprint and network data in parallel
            const [browserData, networkResponse] = await Promise.all([
                FingerprintCollector.collectAll(),
                fetch("/api/network-fingerprint")
            ]);

            this.browserData = browserData;
            this.networkData = await networkResponse.json();

            // Get summary/score from server
            const summaryResponse = await fetch("/api/fingerprint-summary", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(browserData)
            });
            this.summaryData = await summaryResponse.json();

            this._render();
        } catch (err) {
            document.getElementById("app").innerHTML =
                `<div class="error">Failed to collect fingerprint data: ${err.message}</div>`;
        } finally {
            this._showLoading(false);
        }
    },

    _showLoading(show) {
        document.getElementById("loading").style.display = show ? "flex" : "none";
        document.getElementById("app").style.display = show ? "none" : "block";
    },

    _render() {
        this._renderScoreCard();
        this._renderBrowserFingerprint();
        this._renderNetworkFingerprint();
        this._renderDigitalAudit();
        this._renderCanvasPreview();
        this._renderRecommendations();
        this._renderRawData();

        // Make #app visible BEFORE initializing maps — Leaflet needs
        // a visible container with real dimensions to calculate tile layout.
        this._showLoading(false);

        // Init network map now that #app is visible and has dimensions
        if (typeof NetworkMap !== 'undefined') {
            NetworkMap.init('network-map-section');
        }
        // Init geographic map
        if (typeof GeoMap !== 'undefined') {
            GeoMap.init('geo-map-section');
        }
    },

    _renderScoreCard() {
        const s = this.summaryData;
        const el = document.getElementById("score-card");
        const scoreClass = s.uniqueness_score >= 75 ? "high" : s.uniqueness_score >= 45 ? "medium" : "low";

        el.innerHTML = `
            <div class="score-circle ${scoreClass}">
                <span class="score-number">${s.uniqueness_score}</span>
                <span class="score-label">/ 100</span>
            </div>
            <div class="score-info">
                <h2>Trackability: <span class="${scoreClass}">${s.rating}</span></h2>
                <p>${s.advice}</p>
                <p class="hash">Master Fingerprint: <code>${s.master_fingerprint_hash.substring(0, 32)}...</code></p>
                <p class="meta">${s.component_count} unique data points collected</p>
            </div>
        `;
    },

    _renderBrowserFingerprint() {
        const d = this.browserData;
        const el = document.getElementById("browser-section");

        const rows = [
            ["User Agent", d.userAgent],
            ["Platform", d.platform],
            ["Language", `${d.language} (${d.languages.join(", ")})`],
            ["Screen", `${d.screenResolution} (available: ${d.availableResolution})`],
            ["Color Depth", `${d.colorDepth}-bit (pixel: ${d.pixelDepth})`],
            ["Device Pixel Ratio", d.devicePixelRatio],
            ["Timezone", `${d.timezone} (UTC offset: ${d.timezoneOffset} min)`],
            ["CPU Cores", d.hardwareConcurrency || "Hidden"],
            ["Device Memory", d.deviceMemory ? `${d.deviceMemory} GB` : "Hidden"],
            ["Touch Support", d.touchSupport ? `Yes (${d.maxTouchPoints} points)` : "No"],
            ["Cookies Enabled", d.cookiesEnabled ? "Yes" : "No"],
            ["Do Not Track", d.doNotTrack ? "Enabled" : "Disabled"],
            ["LocalStorage", d.localStorage ? "Available" : "Blocked"],
            ["IndexedDB", d.indexedDB ? "Available" : "Blocked"],
            ["WebDriver", d.webdriver ? "⚠ Detected (automation)" : "Not detected"],
            ["Dark Mode", d.darkMode ? "Yes" : "No"],
            ["Reduced Motion", d.reducedMotion ? "Yes" : "No"],
            ["HDR Display", d.hdr ? "Yes" : "No"],
            ["Canvas Hash", d.canvasHash ? `<code>${d.canvasHash.substring(0, 24)}...</code>` : "Blocked"],
            ["WebGL Vendor", d.webglVendor || "Hidden"],
            ["WebGL Renderer", d.webglRenderer || "Hidden"],
            ["WebGL Extensions", d.webglExtensions ? `${d.webglExtensions.length} extensions` : "None"],
            ["Audio Hash", d.audioHash ? `<code>${d.audioHash.substring(0, 24)}...</code>` : "Blocked"],
            ["Detected Fonts", `${d.fonts.length} fonts`],
            ["Plugins", `${d.plugins.length} plugins`],
            ["Media Devices", `${d.mediaDevices.length} devices`],
        ];

        if (d.connection) {
            rows.push(["Connection", `${d.connection.effectiveType} (${d.connection.downlink} Mbps, ${d.connection.rtt}ms RTT)`]);
        }

        el.innerHTML = `<h2>Browser & Device Fingerprint</h2>` +
            `<table class="fp-table">` +
            rows.map(([k, v]) => `<tr><td class="label">${k}</td><td>${v}</td></tr>`).join("") +
            `</table>`;

        // Fonts detail
        if (d.fonts.length > 0) {
            el.innerHTML += `<details><summary>Detected Fonts (${d.fonts.length})</summary><div class="tag-list">${d.fonts.map(f => `<span class="tag">${f}</span>`).join("")}</div></details>`;
        }

        // WebRTC leaks
        if (d.webrtcLeaks && d.webrtcLeaks.length > 0) {
            el.innerHTML += `<div class="warning-box"><strong>⚠ WebRTC IP Leak:</strong> ${d.webrtcLeaks.join(", ")}</div>`;
        }
    },

    _renderNetworkFingerprint() {
        const d = this.networkData;
        const el = document.getElementById("network-section");

        const rows = [
            ["Client IP", d.client_ip],
            ["Header Fingerprint", `<code>${d.header_fingerprint_hash}</code>`],
            ["Local Hostname", d.local_hostname],
            ["Headers Sent", d.header_count],
        ];

        let html = `<h2>Network Fingerprint</h2>`;
        html += `<table class="fp-table">${rows.map(([k, v]) => `<tr><td class="label">${k}</td><td>${v}</td></tr>`).join("")}</table>`;

        // Privacy flags
        if (d.privacy_flags.length > 0) {
            html += `<div class="flags-section"><h3>Privacy Flags</h3><ul>`;
            for (const flag of d.privacy_flags) {
                html += `<li class="flag-item">⚠ ${flag}</li>`;
            }
            html += `</ul></div>`;
        }

        // HTTP Headers detail
        html += `<details><summary>All HTTP Headers (${d.header_count})</summary><table class="fp-table">`;
        for (const [k, v] of Object.entries(d.headers)) {
            const escaped = v.replace(/</g, "&lt;").replace(/>/g, "&gt;");
            html += `<tr><td class="label">${k}</td><td class="mono">${escaped}</td></tr>`;
        }
        html += `</table></details>`;

        el.innerHTML = html;
    },

    _renderDigitalAudit() {
        const d = this.browserData;
        const el = document.getElementById("audit-section");

        const checks = [];

        // Assess trackability vectors
        if (d.canvasHash) {
            checks.push({ status: "warn", text: "Canvas fingerprinting is possible — websites can uniquely identify your GPU/rendering stack" });
        } else {
            checks.push({ status: "ok", text: "Canvas fingerprinting is blocked" });
        }

        if (d.webglRenderer) {
            checks.push({ status: "warn", text: `WebGL exposes your GPU: ${d.webglRenderer}` });
        } else {
            checks.push({ status: "ok", text: "WebGL renderer is hidden" });
        }

        if (d.audioHash) {
            checks.push({ status: "warn", text: "Audio fingerprinting is possible via AudioContext" });
        } else {
            checks.push({ status: "ok", text: "Audio fingerprinting is blocked" });
        }

        if (d.fonts.length > 20) {
            checks.push({ status: "warn", text: `${d.fonts.length} system fonts detectable — high entropy` });
        } else if (d.fonts.length > 0) {
            checks.push({ status: "info", text: `${d.fonts.length} system fonts detectable` });
        }

        if (d.webrtcLeaks && d.webrtcLeaks.length > 0) {
            checks.push({ status: "fail", text: `WebRTC leaks ${d.webrtcLeaks.length} local IP(s) — VPN bypass risk` });
        } else {
            checks.push({ status: "ok", text: "No WebRTC IP leaks detected" });
        }

        if (d.webdriver) {
            checks.push({ status: "fail", text: "WebDriver flag is set — you're identified as an automated browser" });
        }

        if (!d.doNotTrack) {
            checks.push({ status: "info", text: "Do Not Track is disabled" });
        }

        if (d.cookiesEnabled) {
            checks.push({ status: "info", text: "Cookies are enabled — cross-site tracking is possible" });
        }

        if (d.hardwareConcurrency) {
            checks.push({ status: "info", text: `CPU core count exposed: ${d.hardwareConcurrency}` });
        }

        if (d.deviceMemory) {
            checks.push({ status: "info", text: `Device memory exposed: ${d.deviceMemory} GB` });
        }

        const icons = { ok: "✅", warn: "⚠️", fail: "❌", info: "ℹ️" };

        let html = `<h2>Digital Footprint Audit</h2>`;
        html += `<div class="audit-list">`;
        for (const check of checks) {
            html += `<div class="audit-item ${check.status}">${icons[check.status]} ${check.text}</div>`;
        }
        html += `</div>`;

        el.innerHTML = html;
    },

    _renderCanvasPreview() {
        const el = document.getElementById("canvas-section");
        if (this.browserData.canvasDataURL) {
            el.innerHTML = `
                <h2>Canvas Fingerprint Preview</h2>
                <p>This is the exact image rendered by your browser. Differences in GPU, drivers, and font rendering make this unique to your system.</p>
                <img src="${this.browserData.canvasDataURL}" class="canvas-preview" alt="Canvas fingerprint" />
            `;
        }
    },

    _renderRecommendations() {
        const recs = this.summaryData.recommendations;
        const el = document.getElementById("recommendations-section");

        if (!recs || recs.length === 0) {
            el.innerHTML = `<h2>Recommendations</h2><p>No specific recommendations — your setup looks good.</p>`;
            return;
        }

        let html = `<h2>Recommendations</h2><div class="rec-list">`;
        for (const rec of recs) {
            html += `
                <div class="rec-card">
                    <span class="rec-category">${rec.category}</span>
                    <p class="rec-issue">${rec.issue}</p>
                    <p class="rec-action">→ ${rec.action}</p>
                </div>
            `;
        }
        html += `</div>`;
        el.innerHTML = html;
    },

    _renderRawData() {
        const el = document.getElementById("raw-section");
        el.innerHTML = `
            <h2>Raw Fingerprint Data</h2>
            <details>
                <summary>Browser Data (JSON)</summary>
                <pre>${JSON.stringify(this.browserData, null, 2)}</pre>
            </details>
            <details>
                <summary>Network Data (JSON)</summary>
                <pre>${JSON.stringify(this.networkData, null, 2)}</pre>
            </details>
            <details>
                <summary>Summary Data (JSON)</summary>
                <pre>${JSON.stringify(this.summaryData, null, 2)}</pre>
            </details>
        `;
    }
};

// Start on page load
document.addEventListener("DOMContentLoaded", () => Dashboard.init());
