"""
Digital Fingerprint Tracker — Local Privacy Awareness Dashboard
Runs a local Flask server that shows what your browser, network, and device expose.
All data stays local. Nothing is sent to external servers (except optional breach checks).
"""

import datetime
import hashlib
import email as email_lib
import email.policy
import imaplib
import ipaddress
import json
import re
import socket
import struct
import subprocess
import time
from collections import defaultdict

import requests as http_requests
from flask import Flask, jsonify, render_template, request

app = Flask(__name__, static_folder="static", template_folder="templates")


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/network-fingerprint")
def network_fingerprint():
    """Collect what the network layer reveals about the client."""
    # Request headers (what the browser sends to every website)
    headers = {k: v for k, v in request.headers}

    # Client IP as seen by this server
    client_ip = request.remote_addr

    # Derive a header-based fingerprint hash
    header_str = json.dumps(headers, sort_keys=True)
    header_hash = hashlib.sha256(header_str.encode()).hexdigest()[:16]

    # Server-side DNS info
    hostname = socket.gethostname()
    try:
        local_ips = socket.getaddrinfo(hostname, None, socket.AF_UNSPEC)
        local_addresses = list({addr[4][0] for addr in local_ips})
    except socket.gaierror:
        local_addresses = []

    # Header analysis — flag privacy-relevant headers
    privacy_flags = []
    if "X-Forwarded-For" in headers:
        privacy_flags.append("X-Forwarded-For header present — proxy chain visible")
    if headers.get("Dnt") == "1":
        privacy_flags.append("Do Not Track enabled (most sites ignore this)")
    if "Sec-Ch-Ua" in headers:
        privacy_flags.append("Client Hints expose detailed browser/OS version")
    if "Referer" in headers:
        privacy_flags.append(f"Referer header leaks previous page: {headers['Referer']}")
    ua = headers.get("User-Agent", "")
    if ua:
        privacy_flags.append("User-Agent string reveals browser, OS, and device details")

    # Accept-Language analysis
    lang = headers.get("Accept-Language", "")
    if lang:
        privacy_flags.append(f"Accept-Language reveals locale preferences: {lang}")

    return jsonify(
        {
            "client_ip": client_ip,
            "headers": headers,
            "header_fingerprint_hash": header_hash,
            "local_hostname": hostname,
            "local_addresses": local_addresses,
            "privacy_flags": privacy_flags,
            "header_count": len(headers),
        }
    )


@app.route("/api/fingerprint-summary", methods=["POST"])
def fingerprint_summary():
    """
    Receive the full client-side + server-side fingerprint data,
    compute a combined uniqueness hash, and return a privacy score.
    """
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "No data provided"}), 400

    # Combine key fields into a master fingerprint
    components = [
        data.get("userAgent", ""),
        data.get("platform", ""),
        data.get("language", ""),
        str(data.get("screenResolution", "")),
        str(data.get("colorDepth", "")),
        data.get("timezone", ""),
        data.get("canvasHash", ""),
        data.get("webglRenderer", ""),
        data.get("webglVendor", ""),
        str(data.get("hardwareConcurrency", "")),
        str(data.get("deviceMemory", "")),
        str(data.get("touchSupport", "")),
        data.get("audioHash", ""),
    ]
    combined = "|".join(components)
    master_hash = hashlib.sha256(combined.encode()).hexdigest()

    # Privacy score: more unique traits = more trackable (higher = worse)
    uniqueness_factors = 0
    max_factors = 13

    if data.get("canvasHash"):
        uniqueness_factors += 2  # Canvas is highly unique
    if data.get("webglRenderer"):
        uniqueness_factors += 2
    if data.get("audioHash"):
        uniqueness_factors += 2
    if data.get("fonts") and len(data["fonts"]) > 10:
        uniqueness_factors += 2
    if data.get("hardwareConcurrency"):
        uniqueness_factors += 1
    if data.get("deviceMemory"):
        uniqueness_factors += 1
    if data.get("screenResolution"):
        uniqueness_factors += 1
    if data.get("timezone"):
        uniqueness_factors += 1
    if data.get("plugins") and len(data.get("plugins", [])) > 0:
        uniqueness_factors += 1

    score = min(100, int((uniqueness_factors / max_factors) * 100))

    if score >= 75:
        rating = "High"
        advice = "Your browser is highly unique and easily trackable. Consider using a privacy-focused browser like Tor or Brave with strict settings."
    elif score >= 45:
        rating = "Medium"
        advice = "Your fingerprint has moderate uniqueness. Use browser extensions like CanvasBlocker, disable WebGL, and standardize your setup."
    else:
        rating = "Low"
        advice = "Your fingerprint is relatively common. Keep privacy extensions active to maintain this."

    recommendations = _get_recommendations(data)

    return jsonify(
        {
            "master_fingerprint_hash": master_hash,
            "uniqueness_score": score,
            "rating": rating,
            "advice": advice,
            "recommendations": recommendations,
            "component_count": len([c for c in components if c]),
        }
    )


@app.route("/api/network-connections")
def network_connections():
    """
    Collect active TCP connections from the OS.
    Returns a graph-friendly structure of nodes and edges.
    """
    connections = _get_tcp_connections()
    nodes, edges, registry_pulses = _build_connection_graph(connections)
    return jsonify({
        "nodes": nodes,
        "edges": edges,
        "connection_count": len(connections),
        "registry_pulses": registry_pulses,
    })


@app.route("/api/resolve-host")
def resolve_host():
    """Lazily resolve a single IP to a hostname (called from frontend)."""
    ip = request.args.get("ip", "").strip()
    if not ip:
        return jsonify({"error": "No IP provided"}), 400
    # Validate it's actually an IP address to prevent SSRF via DNS
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return jsonify({"error": "Invalid IP address"}), 400
    hostname = _resolve_hostname(ip)
    return jsonify({"ip": ip, "hostname": hostname})


@app.route("/api/traceroute")
def traceroute():
    """Run a traceroute to a given IP and return the hop path."""
    global _trace_active
    ip = request.args.get("ip", "").strip()
    if not ip:
        return jsonify({"error": "No IP provided"}), 400
    try:
        ipaddress.ip_address(ip)
    except ValueError:
        return jsonify({"error": "Invalid IP address"}), 400

    # Return cached result if fresh
    cached = _trace_cache.get(ip)
    if cached and (time.time() - cached["timestamp"]) < _trace_cache_ttl:
        return jsonify({"ip": ip, "hops": cached["hops"], "cached": True})

    # Enforce concurrency limit
    if _trace_active >= _trace_max_concurrent:
        return jsonify({"error": "Too many traceroutes in progress, try again shortly", "busy": True}), 429

    _trace_active += 1
    try:
        hops = _run_traceroute(ip)
        _trace_cache[ip] = {"hops": hops, "timestamp": time.time()}
        return jsonify({"ip": ip, "hops": hops, "cached": False})
    finally:
        _trace_active -= 1


def _run_traceroute(target_ip, max_hops=15):
    """Run tracert on Windows and parse the output into hop list."""
    hops = []
    try:
        result = subprocess.run(
            ["tracert", "-d", "-w", "1000", "-h", str(max_hops), target_ip],
            capture_output=True,
            text=True,
            timeout=45,
        )
        for line in result.stdout.splitlines():
            line = line.strip()
            if not line or line.startswith("Tracing") or line.startswith("Trace") or line.startswith("over"):
                continue
            parts = line.split()
            if not parts or not parts[0].isdigit():
                continue
            hop_num = int(parts[0])
            hop_ip = None
            for part in reversed(parts):
                try:
                    ipaddress.ip_address(part)
                    hop_ip = part
                    break
                except ValueError:
                    continue
            rtts = []
            for part in parts[1:]:
                if part == "*":
                    rtts.append(None)
                elif part == "<1":
                    rtts.append(0.5)
                else:
                    try:
                        val = float(part)
                        rtts.append(val)
                    except ValueError:
                        pass
            avg_rtt = None
            valid_rtts = [r for r in rtts if r is not None]
            if valid_rtts:
                avg_rtt = round(sum(valid_rtts) / len(valid_rtts), 1)
            hops.append({
                "hop": hop_num,
                "ip": hop_ip,
                "rtt_ms": avg_rtt,
                "timeout": hop_ip is None,
                "group": _classify_ip(hop_ip) if hop_ip else "unknown",
            })
    except (subprocess.TimeoutExpired, FileNotFoundError):
        pass
    return hops


def _get_tcp_connections():
    """Get active TCP connections with process names in a single PowerShell call."""
    connections = []
    try:
        # Single batched call: join connection data with process names
        ps_script = (
            "Get-NetTCPConnection -State Established,Listen,TimeWait,CloseWait "
            "-ErrorAction SilentlyContinue | ForEach-Object { "
            "$pn = 'unknown'; "
            "try { $p = Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue; "
            "if ($p) { $pn = $p.ProcessName } } catch {}; "
            "[PSCustomObject]@{ "
            "LA=$_.LocalAddress; LP=$_.LocalPort; "
            "RA=$_.RemoteAddress; RP=$_.RemotePort; "
            "S=[int]$_.State; OP=$_.OwningProcess; PN=$pn "
            "} } | ConvertTo-Json -Depth 2 -Compress"
        )
        result = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True,
            text=True,
            timeout=20,
        )
        if result.stdout.strip():
            data = json.loads(result.stdout)
            if isinstance(data, dict):
                data = [data]
            for conn in data:
                remote_addr = conn.get("RA", "")
                if remote_addr in ("127.0.0.1", "::1", "0.0.0.0", "::"):
                    continue
                connections.append(
                    {
                        "local_address": conn.get("LA", ""),
                        "local_port": conn.get("LP", 0),
                        "remote_address": remote_addr,
                        "remote_port": conn.get("RP", 0),
                        "state": _map_tcp_state(conn.get("S", 0)),
                        "pid": conn.get("OP", 0),
                        "process": conn.get("PN", "unknown"),
                    }
                )
    except (subprocess.TimeoutExpired, json.JSONDecodeError, FileNotFoundError):
        pass
    return connections


def _map_tcp_state(state_val):
    """Map numeric TCP state to human-readable string."""
    state_map = {
        1: "Closed",
        2: "Listen",
        3: "SynSent",
        4: "SynReceived",
        5: "Established",
        6: "FinWait1",
        7: "FinWait2",
        8: "CloseWait",
        9: "Closing",
        10: "LastAck",
        11: "TimeWait",
        12: "DeleteTCB",
    }
    if isinstance(state_val, int):
        return state_map.get(state_val, f"Unknown({state_val})")
    return str(state_val)


def _resolve_hostname(ip):
    """Reverse-DNS lookup. Returns hostname or None. Has a short timeout."""
    try:
        # Set a low timeout to avoid blocking on unresponsive DNS
        socket.setdefaulttimeout(1.5)
        host = socket.gethostbyaddr(ip)[0]
        return host
    except (socket.herror, socket.gaierror, OSError, socket.timeout):
        return None
    finally:
        socket.setdefaulttimeout(None)


def _classify_ip(ip_str):
    """Classify an IP address for visual grouping."""
    try:
        ip = ipaddress.ip_address(ip_str)
        if ip.is_private:
            return "private"
        if ip.is_loopback:
            return "loopback"
        if ip.is_link_local:
            return "link-local"
        if ip.is_multicast:
            return "multicast"
        return "public"
    except ValueError:
        return "unknown"


def _build_connection_graph(connections):
    """
    Build a graph of nodes (IPs/processes) and edges (connections)
    suitable for the frontend visualization.
    Registry connections (GeoIP providers) are separated out with a pulse counter.
    """
    nodes_map = {}
    edges = []
    registry_pulses = []  # list of {ip, hostname, port, process, timestamp}

    # Ensure registry IPs are resolved (fast after first call)
    _resolve_registry_ips()

    # Add local machine as central node
    hostname = socket.gethostname()
    nodes_map["local"] = {
        "id": "local",
        "label": hostname,
        "type": "local",
        "ip": "127.0.0.1",
        "group": "local",
    }

    # Group connections by remote address for cleaner graph
    remote_groups = defaultdict(list)
    for conn in connections:
        remote_groups[conn["remote_address"]].append(conn)

    for remote_ip, conns in remote_groups.items():
        # Check if this IP belongs to a GeoIP registry (fast dict lookup)
        reg_host = _registry_ip_map.get(remote_ip)
        if reg_host:
            for c in conns:
                registry_pulses.append({
                    "ip": remote_ip,
                    "hostname": reg_host,
                    "port": c["remote_port"],
                    "process": c["process"],
                    "state": c["state"],
                })
            continue  # Exclude from main graph

        node_id = f"remote_{remote_ip}"
        ip_class = _classify_ip(remote_ip)

        nodes_map[node_id] = {
            "id": node_id,
            "label": remote_ip,
            "type": "remote",
            "ip": remote_ip,
            "group": ip_class,
            "hostname": None,
            "connection_count": len(conns),
        }

        # Aggregate processes and ports for edge metadata
        processes = list({c["process"] for c in conns})
        ports = list({c["remote_port"] for c in conns})
        states = list({c["state"] for c in conns})

        edges.append(
            {
                "source": "local",
                "target": node_id,
                "processes": processes,
                "remote_ports": sorted(ports),
                "states": states,
                "count": len(conns),
            }
        )

    # Also add unique process nodes for detail
    process_conns = defaultdict(list)
    for conn in connections:
        process_conns[conn["process"]].append(conn)

    for proc_name, conns in process_conns.items():
        node_id = f"process_{proc_name}"
        remote_ips = list({c["remote_address"] for c in conns})
        nodes_map[node_id] = {
            "id": node_id,
            "label": proc_name,
            "type": "process",
            "group": "process",
            "connection_count": len(conns),
            "remote_targets": remote_ips[:10],  # Limit for display
        }

    nodes = list(nodes_map.values())
    return nodes, edges, registry_pulses


def _get_recommendations(data):
    """Generate actionable privacy recommendations based on collected data."""
    recs = []

    ua = data.get("userAgent", "")
    if "Chrome" in ua and "Brave" not in ua:
        recs.append(
            {
                "category": "Browser",
                "issue": "Using standard Chrome — highly fingerprintable",
                "action": "Consider Brave, Firefox with resistFingerprinting, or Tor Browser",
            }
        )

    if data.get("webglRenderer"):
        recs.append(
            {
                "category": "WebGL",
                "issue": f"GPU exposed: {data['webglRenderer']}",
                "action": "Disable WebGL or use WebGL fingerprint spoofing extension",
            }
        )

    if data.get("canvasHash"):
        recs.append(
            {
                "category": "Canvas",
                "issue": "Canvas fingerprint is computable",
                "action": "Install CanvasBlocker extension to add noise to canvas reads",
            }
        )

    fonts = data.get("fonts", [])
    if len(fonts) > 20:
        recs.append(
            {
                "category": "Fonts",
                "issue": f"{len(fonts)} unique fonts detected — highly identifying",
                "action": "Reduce installed fonts or use a browser that blocks font enumeration",
            }
        )

    if data.get("webrtcLeaks"):
        recs.append(
            {
                "category": "WebRTC",
                "issue": "Local IP addresses leaked via WebRTC",
                "action": "Disable WebRTC or use uBlock Origin to prevent WebRTC leaks",
            }
        )

    if not data.get("doNotTrack"):
        recs.append(
            {
                "category": "DNT",
                "issue": "Do Not Track is disabled",
                "action": 'Enable DNT in browser settings (note: most sites ignore it, but it\'s still a signal)',
            }
        )

    if data.get("cookiesEnabled"):
        recs.append(
            {
                "category": "Cookies",
                "issue": "Third-party cookies may be enabled",
                "action": "Block third-party cookies in browser settings",
            }
        )

    return recs


# --- Traceroute cache & rate limiting ---
_trace_cache = {}       # ip -> {"hops": [...], "timestamp": float}
_trace_cache_ttl = 300  # 5 minutes
_trace_active = 0       # current running traceroutes
_trace_max_concurrent = 2

# --- GeoIP Cache (in-memory, lives for server lifetime) ---
_geo_cache = {}

# --- GeoIP Provider Round-Robin (avoids Total Uptime / ip-api.com) ---
_geo_providers = [
    {
        "name": "ipwho.is",
        "url": "https://ipwho.is/{ip}",
        "ok": lambda d: d.get("success") is True,
        "parse": lambda d: {
            "lat": d.get("latitude", 0),
            "lon": d.get("longitude", 0),
            "city": d.get("city", ""),
            "region": d.get("region", ""),
            "country": d.get("country", ""),
            "isp": d.get("connection", {}).get("isp", ""),
            "org": d.get("connection", {}).get("org", ""),
            "as": "AS{} {}".format(
                d.get("connection", {}).get("asn", ""),
                d.get("connection", {}).get("org", ""),
            ).strip(),
        },
    },
    {
        "name": "ipapi.co",
        "url": "https://ipapi.co/{ip}/json/",
        "ok": lambda d: "latitude" in d and not d.get("error"),
        "parse": lambda d: {
            "lat": d.get("latitude", 0),
            "lon": d.get("longitude", 0),
            "city": d.get("city", ""),
            "region": d.get("region", ""),
            "country": d.get("country_name", ""),
            "isp": d.get("org", ""),
            "org": d.get("org", ""),
            "as": "AS{}".format(d.get("asn", "")) if d.get("asn") else "",
        },
    },
    {
        "name": "freeipapi.com",
        "url": "https://freeipapi.com/api/json/{ip}",
        "ok": lambda d: "latitude" in d,
        "parse": lambda d: {
            "lat": d.get("latitude", 0),
            "lon": d.get("longitude", 0),
            "city": d.get("cityName", ""),
            "region": d.get("regionName", ""),
            "country": d.get("countryName", ""),
            "isp": "",
            "org": "",
            "as": "",
        },
    },
    {
        "name": "ipinfo.io",
        "url": "https://ipinfo.io/{ip}/json",
        "ok": lambda d: "loc" in d and not d.get("error"),
        "parse": lambda d: {
            "lat": float(d.get("loc", "0,0").split(",")[0]),
            "lon": float(d.get("loc", "0,0").split(",")[1]),
            "city": d.get("city", ""),
            "region": d.get("region", ""),
            "country": d.get("country", ""),
            "isp": d.get("org", ""),
            "org": d.get("org", ""),
            "as": d.get("org", ""),
        },
    },
    {
        "name": "ipbase.com",
        "url": "https://api.ipbase.com/v1/json/{ip}",
        "ok": lambda d: "latitude" in d or ("location" in d and "latitude" in d.get("location", {})),
        "parse": lambda d: {
            "lat": d.get("latitude") or d.get("location", {}).get("latitude", 0),
            "lon": d.get("longitude") or d.get("location", {}).get("longitude", 0),
            "city": d.get("city") or d.get("location", {}).get("city", {}).get("name", ""),
            "region": d.get("region_name", ""),
            "country": d.get("country_name") or d.get("location", {}).get("country", {}).get("name", ""),
            "isp": d.get("isp", ""),
            "org": d.get("organization", ""),
            "as": "",
        },
    },
    {
        "name": "reallyfreegeoip.org",
        "url": "https://reallyfreegeoip.org/json/{ip}",
        "ok": lambda d: "latitude" in d,
        "parse": lambda d: {
            "lat": d.get("latitude", 0),
            "lon": d.get("longitude", 0),
            "city": d.get("city", ""),
            "region": d.get("region_name", ""),
            "country": d.get("country_name", ""),
            "isp": "",
            "org": "",
            "as": "",
        },
    },
]
_geo_rr_index = 0

# Hostnames of GeoIP registries the dashboard contacts — used to tag connections
_REGISTRY_HOSTS = {
    "ipwho.is", "ipapi.co", "freeipapi.com", "ipinfo.io",
    "api.ipbase.com", "ipbase.com", "reallyfreegeoip.org",
    "api.ipify.org", "ipify.org",
}

# Resolved IP -> hostname map for fast matching (populated lazily)
_registry_ip_map = {}       # ip_str -> hostname
_registry_ips_resolved = False


def _resolve_registry_ips():
    """Resolve all registry hostnames to IPs once. Called lazily on first use."""
    global _registry_ips_resolved
    if _registry_ips_resolved:
        return
    for host in _REGISTRY_HOSTS:
        try:
            infos = socket.getaddrinfo(host, 443, socket.AF_UNSPEC, socket.SOCK_STREAM)
            for info in infos:
                ip = info[4][0]
                _registry_ip_map[ip] = host
        except (socket.gaierror, OSError):
            pass
    _registry_ips_resolved = True


def _geolocate_ip(ip_str):
    """Geolocate a single IP using round-robin providers with fallback."""
    global _geo_rr_index
    if ip_str in _geo_cache:
        return _geo_cache[ip_str]
    for _ in range(len(_geo_providers)):
        provider = _geo_providers[_geo_rr_index % len(_geo_providers)]
        _geo_rr_index += 1
        try:
            resp = http_requests.get(
                provider["url"].format(ip=ip_str), timeout=5,
                headers={"User-Agent": "DigitalFingerprintTracker/1.0"},
            )
            if resp.status_code == 200:
                data = resp.json()
                if provider["ok"](data):
                    geo = provider["parse"](data)
                    _geo_cache[ip_str] = geo
                    _log("geo", f"{ip_str} → {geo.get('city','?')}, {geo.get('country','?')} via {provider['name']}")
                    return geo
        except Exception:
            continue
    return None


def _geolocate_batch(ip_list):
    """Geolocate a list of IPs, round-robining across providers. Returns dict of ip->geo."""
    results = {}
    for ip in ip_list:
        geo = _geolocate_ip(ip)
        if geo:
            results[ip] = geo
    return results


def _get_own_public_ip():
    """Detect own public IP and geolocate it (cached)."""
    if "_self" in _geo_cache:
        return _geo_cache["_self"]["ip"], _geo_cache["_self"]["geo"]
    own_ip = None
    for url in ("https://api.ipify.org?format=json", "https://ipwho.is/"):
        try:
            r = http_requests.get(url, timeout=5)
            if r.status_code == 200:
                d = r.json()
                own_ip = d.get("ip") or d.get("query")
                if own_ip:
                    break
        except Exception:
            continue
    if not own_ip:
        return None, None
    own_geo = _geolocate_ip(own_ip)
    if own_geo:
        _geo_cache["_self"] = {"ip": own_ip, "geo": own_geo}
    return own_ip, own_geo


@app.route("/api/geolocate", methods=["POST"])
def geolocate():
    """
    Batch geolocate IPs using round-robin free providers.
    Accepts {"ips": ["1.2.3.4", ...]} — max 100 per call.
    Returns {"results": {ip: {lat, lon, city, region, country, isp, org, as}, ...}}
    """
    data = request.get_json(silent=True)
    if not data or "ips" not in data:
        return jsonify({"error": "POST body must contain 'ips' array"}), 400

    raw_ips = data["ips"]
    if not isinstance(raw_ips, list):
        return jsonify({"error": "'ips' must be a list"}), 400

    # Validate and deduplicate
    valid_ips = []
    for ip_str in raw_ips[:100]:
        try:
            addr = ipaddress.ip_address(str(ip_str).strip())
            if not addr.is_private and not addr.is_loopback and not addr.is_link_local:
                valid_ips.append(str(addr))
        except ValueError:
            continue

    # Geolocate via round-robin providers (cache-aware)
    results = _geolocate_batch(valid_ips)

    # Own public IP for map center
    own_ip, own_geo = _get_own_public_ip()

    return jsonify({
        "results": results,
        "self_ip": own_ip,
        "self_geo": own_geo,
    })


@app.route("/api/trace-and-locate", methods=["POST"])
def trace_and_locate():
    """
    For each public IP: run 1 traceroute (cached), collect all hop IPs,
    then batch-geolocate everything. Returns full path data for the map.
    Accepts: {"ips": ["1.2.3.4", ...]}
    Returns: {
      "self_ip", "self_geo",
      "targets": {ip: {"geo": {...}, "hops": [{hop, ip, rtt_ms, geo}, ...]}},
    }
    """
    data = request.get_json(silent=True)
    if not data or "ips" not in data:
        return jsonify({"error": "POST body must contain 'ips' array"}), 400

    raw_ips = data["ips"]
    if not isinstance(raw_ips, list):
        return jsonify({"error": "'ips' must be a list"}), 400

    # Validate — only public IPs
    valid_ips = []
    for ip_str in raw_ips[:50]:  # cap at 50 targets
        try:
            addr = ipaddress.ip_address(str(ip_str).strip())
            if not addr.is_private and not addr.is_loopback and not addr.is_link_local:
                valid_ips.append(str(addr))
        except ValueError:
            continue

    # 1. Run traceroutes sequentially (using cache — most will be instant)
    all_traces = {}
    all_hop_ips = set()
    for ip in valid_ips:
        cached = _trace_cache.get(ip)
        if cached and (time.time() - cached["timestamp"]) < _trace_cache_ttl:
            hops = cached["hops"]
        else:
            hops = _run_traceroute(ip, max_hops=15)
            _trace_cache[ip] = {"hops": hops, "timestamp": time.time()}
        all_traces[ip] = hops
        for h in hops:
            if h["ip"] and not h["timeout"]:
                all_hop_ips.add(h["ip"])

    # 2. Collect all IPs to geolocate (targets + hops)
    all_ips_to_geo = set(valid_ips) | all_hop_ips
    # Filter to public only
    ips_for_lookup = []
    for ip_str in all_ips_to_geo:
        try:
            addr = ipaddress.ip_address(ip_str)
            if not addr.is_private and not addr.is_loopback and not addr.is_link_local:
                ips_for_lookup.append(ip_str)
        except ValueError:
            continue

    # 3. Batch geolocate via round-robin providers (cache-aware)
    geo_results = _geolocate_batch(ips_for_lookup)

    # 4. Get self location
    own_ip, own_geo = _get_own_public_ip()

    # 5. Build response — targets with their trace hops annotated with geo
    targets = {}
    for ip in valid_ips:
        hops_with_geo = []
        for h in all_traces.get(ip, []):
            hop_entry = {
                "hop": h["hop"],
                "ip": h["ip"],
                "rtt_ms": h["rtt_ms"],
                "timeout": h["timeout"],
            }
            if h["ip"] and h["ip"] in geo_results:
                hop_entry["geo"] = geo_results[h["ip"]]
            hops_with_geo.append(hop_entry)

        targets[ip] = {
            "geo": geo_results.get(ip),
            "hops": hops_with_geo,
        }

    return jsonify({
        "self_ip": own_ip,
        "self_geo": own_geo,
        "targets": targets,
    })


# ─── Server Console (ring-buffer log) ─────────────────────────────────
_console_log = []           # list of {ts, level, msg}
_console_max = 500


def _log(level, msg):
    """Append a timestamped entry to the in-memory server console."""
    _console_log.append({"ts": time.time(), "level": level, "msg": msg})
    if len(_console_log) > _console_max:
        del _console_log[: len(_console_log) - _console_max]


@app.after_request
def _log_request(response):
    """Log every request to the console buffer."""
    if request.path.startswith("/api/console"):
        return response  # don't log console polls
    _log("req", f"{request.method} {request.path} → {response.status_code}")
    return response


@app.route("/api/console")
def server_console():
    """Return console log entries since a given timestamp (or last 100)."""
    since = request.args.get("since", type=float, default=0)
    entries = [e for e in _console_log if e["ts"] > since]
    return jsonify({"entries": entries[-200:]})


# ─── Email Header Trace ───────────────────────────────────────────────

# Regex for IPv4 and IPv6 in Received: headers
_IP_IN_HEADER_RE = re.compile(
    r"\[?"
    r"("
    r"(?:(?:25[0-5]|2[0-4]\d|1?\d\d?)\.){3}(?:25[0-5]|2[0-4]\d|1?\d\d?)"
    r"|"
    r"(?:[0-9a-fA-F]{1,4}:){2,7}[0-9a-fA-F]{1,4}"
    r")"
    r"\]?"
)


def _extract_ips_from_headers(raw_headers):
    """Parse Received: headers and extract public IPs in order."""
    ips_seen = set()
    ips_ordered = []
    for match in _IP_IN_HEADER_RE.finditer(raw_headers):
        ip_str = match.group(1)
        try:
            addr = ipaddress.ip_address(ip_str)
            if addr.is_private or addr.is_loopback or addr.is_link_local:
                continue
            if ip_str not in ips_seen:
                ips_seen.add(ip_str)
                ips_ordered.append(ip_str)
        except ValueError:
            continue
    return ips_ordered


@app.route("/api/email-trace", methods=["POST"])
def email_trace():
    """
    Connect to Gmail via IMAP, fetch recent emails, extract IPs from Received: headers,
    geolocate them, and return structured data.
    Accepts: {"email": "user@gmail.com", "app_password": "xxxx xxxx xxxx xxxx", "count": 20}
    Credentials are used once for this request and never stored.
    """
    data = request.get_json(silent=True)
    if not data:
        return jsonify({"error": "No data provided"}), 400

    email_addr = (data.get("email") or "").strip()
    app_password = (data.get("app_password") or "").strip()
    count = min(int(data.get("count", 20)), 200)  # cap at 200
    months = min(int(data.get("months", 1)), 12)  # 1-12 months lookback

    if not email_addr or not app_password:
        return jsonify({"error": "Email and app password are required"}), 400

    # IMAP SINCE date — go back N months
    since_date = datetime.date.today() - datetime.timedelta(days=months * 30)
    since_str = since_date.strftime("%d-%b-%Y")  # e.g. "17-Oct-2025"

    _log("info", f"Email trace: connecting to Gmail for {email_addr[:3]}*** (last {months}mo, max {count})")

    emails = []
    try:
        mail = imaplib.IMAP4_SSL("imap.gmail.com", 993)
        mail.login(email_addr, app_password)

        folders = [("INBOX", "inbox"), ("[Gmail]/Spam", "spam")]
        for folder_name, folder_label in folders:
            status, _ = mail.select(folder_name, readonly=True)
            if status != "OK":
                _log("info", f"Email trace: {folder_name} not available, skipping")
                continue

            status, msg_ids = mail.search(None, f'(SINCE {since_str})')
            if status != "OK" or not msg_ids[0]:
                _log("info", f"Email trace: no emails in {folder_name} since {since_str}")
                continue

            ids = msg_ids[0].split()
            total_in_folder = len(ids)
            ids = ids[-count:]
            _log("info", f"Email trace: scanning {folder_name} — {total_in_folder} total, fetching last {len(ids)}")

            for mid in reversed(ids):
                try:
                    status, msg_data = mail.fetch(mid, "(BODY[HEADER.FIELDS (FROM SUBJECT DATE RECEIVED)])")
                    if status != "OK":
                        continue
                    raw = msg_data[0][1]
                    if isinstance(raw, bytes):
                        raw = raw.decode("utf-8", errors="replace")

                    msg = email_lib.message_from_string(raw, policy=email_lib.policy.default)
                    sender = str(msg.get("From", "unknown"))
                    subject = str(msg.get("Subject", "(no subject)"))
                    date = str(msg.get("Date", ""))

                    status2, full_hdr = mail.fetch(mid, "(BODY[HEADER.FIELDS (RECEIVED)])")
                    received_raw = ""
                    if status2 == "OK" and full_hdr[0][1]:
                        hdr_bytes = full_hdr[0][1]
                        if isinstance(hdr_bytes, bytes):
                            received_raw = hdr_bytes.decode("utf-8", errors="replace")

                    ips = _extract_ips_from_headers(received_raw)

                    emails.append({
                        "from": sender,
                        "subject": subject[:80],
                        "date": date,
                        "ips": ips,
                        "folder": folder_label,
                    })
                except Exception:
                    continue

        mail.logout()
    except imaplib.IMAP4.error as e:
        _log("error", f"Email trace IMAP error: {e}")
        return jsonify({"error": f"IMAP login failed: {e}"}), 401
    except Exception as e:
        _log("error", f"Email trace error: {e}")
        return jsonify({"error": str(e)}), 500

    # Collect all unique IPs
    all_ips = []
    seen = set()
    for em in emails:
        for ip in em["ips"]:
            if ip not in seen:
                seen.add(ip)
                all_ips.append(ip)

    _log("info", f"Email trace: geolocating {len(all_ips)} unique IPs...")
    # Geolocate all IPs
    geo = _geolocate_batch(all_ips)

    _log("info", f"Email trace: {len(emails)} emails, {len(all_ips)} unique IPs")

    return jsonify({
        "emails": emails,
        "geo": geo,
        "ip_count": len(all_ips),
    })


if __name__ == "__main__":
    print("=" * 60)
    print("  Digital Fingerprint Tracker")
    print("  Local Privacy Awareness Dashboard")
    print("  Open http://127.0.0.1:5000 in your browser")
    print("=" * 60)
    app.run(host="127.0.0.1", port=5000, debug=True)
