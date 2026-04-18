/**
 * ServerConsole — Live server log viewer.
 * Polls /api/console and displays timestamped entries with level badges.
 */

const ServerConsole = {

    entries: [],
    lastTs: 0,
    pollTimer: null,
    pollRate: 2000,
    maxDisplay: 200,
    paused: false,

    init(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = `
            <h2>Server Console</h2>
            <p class="map-subtitle">Live server activity log — requests, GeoIP lookups, events</p>
            <div class="console-controls">
                <button id="console-toggle" class="map-btn map-btn-primary">Start</button>
                <button id="console-clear" class="map-btn">Clear</button>
                <label class="console-autoscroll">
                    <input type="checkbox" id="console-autoscroll" checked /> Auto-scroll
                </label>
                <span id="console-status" class="map-status">Idle</span>
            </div>
            <div id="console-output" class="console-output"></div>
        `;

        document.getElementById("console-toggle").addEventListener("click", () => this._toggle());
        document.getElementById("console-clear").addEventListener("click", () => this._clear());

        // Auto-start
        this._toggle();
    },

    _toggle() {
        const btn = document.getElementById("console-toggle");
        if (this.pollTimer) {
            clearInterval(this.pollTimer);
            this.pollTimer = null;
            btn.textContent = "Start";
            btn.classList.remove("map-btn-active");
            this._setStatus("Paused");
        } else {
            this._poll(); // immediate first fetch
            this.pollTimer = setInterval(() => this._poll(), this.pollRate);
            btn.textContent = "Pause";
            btn.classList.add("map-btn-active");
            this._setStatus("Streaming...");
        }
    },

    _clear() {
        this.entries = [];
        this.lastTs = 0;
        const output = document.getElementById("console-output");
        if (output) output.innerHTML = "";
    },

    _setStatus(msg) {
        const el = document.getElementById("console-status");
        if (el) el.textContent = msg;
    },

    async _poll() {
        try {
            const resp = await fetch(`/api/console?since=${this.lastTs}`);
            const data = await resp.json();
            if (data.entries && data.entries.length > 0) {
                for (const e of data.entries) {
                    this.entries.push(e);
                    if (e.ts > this.lastTs) this.lastTs = e.ts;
                }
                // Trim
                if (this.entries.length > this.maxDisplay) {
                    this.entries = this.entries.slice(-this.maxDisplay);
                }
                this._render();
            }
        } catch (err) {
            // silently ignore poll failures
        }
    },

    _render() {
        const output = document.getElementById("console-output");
        if (!output) return;

        const levelColors = {
            req: "#58a6ff",
            geo: "#3fb950",
            info: "#d29922",
            error: "#f85149",
            warn: "#db6d28",
            email: "#bc8cff",
        };

        // Only render the last maxDisplay entries
        const visible = this.entries.slice(-this.maxDisplay);
        output.innerHTML = visible.map(e => {
            const t = new Date(e.ts * 1000);
            const ts = t.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit" });
            const ms = String(t.getMilliseconds()).padStart(3, "0");
            const color = levelColors[e.level] || "#8b949e";
            const badge = `<span class="console-badge" style="color:${color}">${e.level.toUpperCase().padEnd(5)}</span>`;
            return `<div class="console-line">${badge}<span class="console-ts">${ts}.${ms}</span> ${this._escapeHtml(e.msg)}</div>`;
        }).join("");

        // Auto-scroll
        const autoScroll = document.getElementById("console-autoscroll");
        if (autoScroll && autoScroll.checked) {
            output.scrollTop = output.scrollHeight;
        }
    },

    _escapeHtml(text) {
        const d = document.createElement("div");
        d.textContent = text;
        return d.innerHTML;
    },
};
