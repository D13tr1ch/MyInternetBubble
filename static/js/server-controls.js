/**
 * ServerControls — Start/Stop/Restart server + Uninstall, with live uptime display.
 */

const ServerControls = {

    uptimeTimer: null,
    startTime: null,

    init(containerId) {
        const container = document.getElementById(containerId);
        if (!container) return;

        container.innerHTML = `
            <h2>Server Controls</h2>
            <p class="map-subtitle">Manage the local dashboard server</p>
            <div class="sctrl-status">
                <div class="sctrl-indicator sctrl-running"></div>
                <span class="sctrl-label">Server running</span>
                <span class="sctrl-uptime" id="sctrl-uptime">—</span>
                <span class="sctrl-pid" id="sctrl-pid"></span>
            </div>
            <div class="sctrl-buttons">
                <button id="sctrl-restart" class="map-btn map-btn-primary">Restart</button>
                <button id="sctrl-stop" class="map-btn sctrl-btn-warn">Stop Server</button>
                <button id="sctrl-uninstall" class="map-btn sctrl-btn-danger">Uninstall</button>
            </div>
            <div id="sctrl-confirm" class="sctrl-confirm" style="display:none;"></div>
            <div id="sctrl-message" class="sctrl-message"></div>
        `;

        document.getElementById("sctrl-restart").addEventListener("click", () => this._restart());
        document.getElementById("sctrl-stop").addEventListener("click", () => this._confirmStop());
        document.getElementById("sctrl-uninstall").addEventListener("click", () => this._confirmUninstall());

        this._fetchStatus();
        this.uptimeTimer = setInterval(() => this._tickUptime(), 1000);
    },

    async _fetchStatus() {
        try {
            const resp = await fetch("/api/server/status");
            const data = await resp.json();
            this.startTime = Date.now() / 1000 - data.uptime;
            document.getElementById("sctrl-pid").textContent = `PID ${data.pid}`;
            this._tickUptime();
        } catch (err) {
            this._setMsg("Could not reach server", "error");
        }
    },

    _tickUptime() {
        if (!this.startTime) return;
        const secs = Math.floor(Date.now() / 1000 - this.startTime);
        const h = Math.floor(secs / 3600);
        const m = Math.floor((secs % 3600) / 60);
        const s = secs % 60;
        const parts = [];
        if (h > 0) parts.push(`${h}h`);
        parts.push(`${m}m`);
        parts.push(`${s}s`);
        document.getElementById("sctrl-uptime").textContent = `Uptime: ${parts.join(" ")}`;
    },

    async _restart() {
        this._setMsg("Restarting server...", "info");
        try {
            await fetch("/api/server/restart", { method: "POST" });
            this._setMsg("Server is restarting — page will reload in 3 seconds...", "info");
            setTimeout(() => window.location.reload(), 3000);
        } catch (err) {
            this._setMsg("Restart failed: " + err.message, "error");
        }
    },

    _confirmStop() {
        const box = document.getElementById("sctrl-confirm");
        box.innerHTML = `
            <p>Stop the server? The dashboard will become unavailable until you manually restart it.</p>
            <div class="sctrl-confirm-btns">
                <button id="sctrl-stop-yes" class="map-btn sctrl-btn-warn">Yes, Stop</button>
                <button id="sctrl-stop-no" class="map-btn">Cancel</button>
            </div>
        `;
        box.style.display = "block";
        document.getElementById("sctrl-stop-yes").addEventListener("click", () => this._stop());
        document.getElementById("sctrl-stop-no").addEventListener("click", () => { box.style.display = "none"; });
    },

    async _stop() {
        document.getElementById("sctrl-confirm").style.display = "none";
        this._setMsg("Stopping server...", "info");
        try {
            await fetch("/api/server/stop", { method: "POST" });
            this._setMsg("Server stopped. Close this tab — to restart, run: python server.py", "info");
            if (this.uptimeTimer) clearInterval(this.uptimeTimer);
        } catch (err) {
            this._setMsg("Server may already be stopped", "info");
        }
    },

    _confirmUninstall() {
        const box = document.getElementById("sctrl-confirm");
        box.innerHTML = `
            <div class="sctrl-danger-box">
                <p><strong>This will permanently delete the entire project folder.</strong></p>
                <p>All files, the virtual environment, and configuration will be removed. This cannot be undone.</p>
                <p>Type <strong>UNINSTALL</strong> to confirm:</p>
                <input type="text" id="sctrl-uninstall-input" class="sctrl-confirm-input" placeholder="Type UNINSTALL" autocomplete="off" />
                <div class="sctrl-confirm-btns">
                    <button id="sctrl-uninstall-yes" class="map-btn sctrl-btn-danger" disabled>Permanently Delete</button>
                    <button id="sctrl-uninstall-no" class="map-btn">Cancel</button>
                </div>
            </div>
        `;
        box.style.display = "block";

        const input = document.getElementById("sctrl-uninstall-input");
        const btn = document.getElementById("sctrl-uninstall-yes");

        input.addEventListener("input", () => {
            btn.disabled = input.value.trim() !== "UNINSTALL";
        });
        btn.addEventListener("click", () => this._uninstall());
        document.getElementById("sctrl-uninstall-no").addEventListener("click", () => { box.style.display = "none"; });
    },

    async _uninstall() {
        document.getElementById("sctrl-confirm").style.display = "none";
        this._setMsg("Uninstalling — server will stop and all files will be deleted...", "error");
        try {
            await fetch("/api/server/uninstall", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ confirm: "UNINSTALL" }),
            });
            this._setMsg("Uninstall in progress. This tab will stop working shortly.", "error");
            if (this.uptimeTimer) clearInterval(this.uptimeTimer);
        } catch (err) {
            this._setMsg("Uninstall may already be in progress", "info");
        }
    },

    _setMsg(msg, level) {
        const el = document.getElementById("sctrl-message");
        if (!el) return;
        const color = level === "error" ? "var(--red)" : level === "info" ? "var(--yellow)" : "var(--text-muted)";
        el.innerHTML = `<span style="color:${color}">${this._escapeHtml(msg)}</span>`;
    },

    _escapeHtml(text) {
        const d = document.createElement("div");
        d.textContent = text;
        return d.innerHTML;
    },
};
