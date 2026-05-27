# MyInternetBubble Copilot Instructions

## Platform Identity
MyInternetBubble is a local privacy dashboard that visualizes your digital fingerprint, maps your network connections geographically, and traces data paths across the internet.

## Tech Stack
- Python 3.10+
- Flask 3.x
- Vanilla JavaScript frontend with Leaflet.js and custom canvas graphing

## Project Structure
- `server.py` — Flask backend
- `templates/` — HTML templates
- `static/` — CSS and JS assets
- `requirements.txt` — Python dependencies

## Validation Commands
- `python3 -m py_compile server.py`
- `pip install -r requirements.txt`
- `python3 server.py`

## Code Standards
- Preserve local-only behavior and privacy-first defaults.
- Keep external calls explicit and documented.
- Avoid introducing hidden telemetry, tracking, or network dependencies.

## Response Style
- Be concise.
- Report privacy, network, or browser-fingerprint impact clearly.
