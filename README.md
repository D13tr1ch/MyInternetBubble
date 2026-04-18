# MyInternetBubble

A local privacy dashboard that visualizes your digital fingerprint, maps your network connections geographically, and traces the route your data takes across the internet — all running on your machine.

![Python](https://img.shields.io/badge/Python-3.10%2B-blue)
![Flask](https://img.shields.io/badge/Flask-3.x-green)
![License](https://img.shields.io/badge/License-MIT-yellow)

## Features

- **Browser Fingerprint Audit** — See exactly what websites can learn about you: user agent, screen resolution, WebGL renderer, installed fonts, canvas fingerprint, and more.
- **Trackability Score** — Get a 0–100 uniqueness score showing how trackable your browser is.
- **Network Connection Map** — Live force-directed graph of all your active TCP connections with process names, states, and traceroute on double-click.
- **Geographic World Map** — Every public connection geolocated and pinned on a dark-themed Leaflet map. Destinations are heat-colored by traffic volume (green → yellow → red).
- **Traceroute Hop Paths** — Progressive traceroute for each connection, with every hop (public and private) plotted on the map showing the actual path your data travels.
- **Connection Table** — Sortable table of all connections with IP, city, country, ISP, hop count, and connection count.
- **Digital Footprint Audit** — Checks for Do Not Track, cookie settings, ad blocker detection, WebRTC leak potential, and more.
- **Recommendations** — Actionable privacy tips based on your actual configuration.

## Screenshots

*Coming soon — run it locally to see your own network bubble!*

## Quick Start

### Prerequisites

- Python 3.10 or newer
- Windows (uses `Get-NetTCPConnection` and `tracert`)

### Install & Run

```bash
# Clone the repo
git clone https://github.com/D13tr1ch/MyInternetBubble.git
cd MyInternetBubble

# Create virtual environment
python -m venv .venv

# Activate it
# Windows PowerShell:
.venv\Scripts\Activate.ps1
# Windows CMD:
.venv\Scripts\activate.bat
# Linux/macOS:
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Run the server
python server.py
```

Open **http://127.0.0.1:5000** in your browser.

## How It Works

1. **Browser fingerprint** is collected client-side (JavaScript) and sent to the local Flask server for scoring.
2. **Network connections** are enumerated via PowerShell's `Get-NetTCPConnection` with process name resolution.
3. **Geolocation** uses [ip-api.com](http://ip-api.com) (free tier, no API key needed) to map IPs to coordinates.
4. **Traceroute** runs Windows `tracert` per destination, with results cached for 5 minutes and concurrency-limited to 2 simultaneous traces.
5. **Everything stays local** — no data is sent anywhere except IP geolocation lookups to ip-api.com.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Backend | Python / Flask |
| Frontend | Vanilla JavaScript (no frameworks) |
| Map | Leaflet.js + CartoDB dark tiles |
| Network Graph | HTML5 Canvas (custom force-directed layout) |
| Geolocation | ip-api.com (free, no key) |
| Traceroute | Windows `tracert` |
| Connection Data | PowerShell `Get-NetTCPConnection` |

## Project Structure

```
MyInternetBubble/
├── server.py                  # Flask backend — all API endpoints
├── requirements.txt           # Python dependencies
├── templates/
│   └── index.html             # Main page
└── static/
    ├── css/
    │   └── style.css          # Dark theme dashboard styles
    └── js/
        ├── fingerprint.js     # Browser fingerprint collection + dashboard
        ├── geo-map.js         # Leaflet world map with traceroute paths
        └── network-map.js     # Force-directed network connection graph
```

## Privacy

This tool is designed to **increase** your privacy awareness. It runs entirely locally:

- No accounts, no sign-ups, no telemetry
- No data leaves your machine (except IP geolocation queries to ip-api.com)
- No cookies, no tracking, no analytics
- Everything shuts down when you close the server

## License

MIT License — see [LICENSE](LICENSE) for details.

## Support

If you find this useful, consider buying me a coffee:

<a href="https://www.buymeacoffee.com/D13tr1ch" target="_blank">
  <img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" height="50">
</a>

---

*Built with curiosity and a healthy dose of paranoia.*
