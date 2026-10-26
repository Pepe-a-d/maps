#!/usr/bin/env python3
"""Build the exploration data for one region: municipalities as sectors, and
their drivable roads cut into short pieces you discover by driving them.

Data comes from OpenStreetMap through Overpass (ODbL, © OpenStreetMap
contributors). Run from the project root:

    python3 scripts/build_sectors.py                 # download and build
    python3 scripts/build_sectors.py --cache DIR     # reuse/keep the downloads in DIR

It writes public/data/coruna.json. Pieces are sorted by OSM way id so their
order (which saved progress relies on) stays put while the map doesn't change;
bump VERSION when it does, and saved progress is reset.
"""

import argparse
import json
import math
import os
import urllib.parse
import urllib.request

VERSION = 1
REGION = "A Coruña"
OUTPUT = "public/data/coruna.json"

# A Coruña and the municipalities around it (OSM relation ids).
SECTORS = {
    346810: "a-coruna",
    342626: "arteixo",
    346811: "culleredo",
    347281: "cambre",
    346497: "oleiros",
    346199: "sada",
    342635: "bergondo",
    342630: "abegondo",
    342271: "carral",
}

HIGHWAYS = (
    "motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|"
    "tertiary|tertiary_link|unclassified|residential|living_street"
)

PIECE_M = 100  # roads are cut into pieces of about this length
BOUNDARY_TOLERANCE_M = 15

OVERPASS = [
    "https://overpass-api.de/api/interpreter",
    "https://lz4.overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

ids = ",".join(str(i) for i in SECTORS)
BOUNDS_QUERY = f"[out:json][timeout:180];relation(id:{ids});out geom;"
ROADS_QUERY = f"""[out:json][timeout:600][maxsize:1073741824];
relation(id:{ids});
map_to_area->.a;
way(area.a)[highway~"^({HIGHWAYS})$"][access!~"^(private|no)$"][area!=yes];
out tags geom qt;"""


def overpass(query):
    body = urllib.parse.urlencode({"data": query}).encode()
    last = None
    for url in OVERPASS:
        req = urllib.request.Request(
            url,
            data=body,
            headers={"User-Agent": "maps-sector-builder/1 (+https://pepe-a-d.github.io/maps/)", "Referer": "https://pepe-a-d.github.io/maps/"},
        )
        try:
            with urllib.request.urlopen(req, timeout=900) as res:
                return json.load(res)
        except Exception as err:  # try the next server
            print(f"{url}: {err}")
            last = err
    raise last


def cached(cache, name, query):
    path = os.path.join(cache, name) if cache else None
    if path and os.path.exists(path):
        with open(path) as f:
            return json.load(f)
    data = overpass(query)
    if path:
        with open(path, "w") as f:
            json.dump(data, f)
    return data


# ---------- Geometry ----------

R = 6371008.8


def dist(a, b):
    """Metres between two (lon, lat) points."""
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.radians(math.hypot((b[0] - a[0]) * k, b[1] - a[1])) * R


def point_segment(p, a, b):
    k = math.cos(math.radians(p[1]))
    ax, ay = (a[0] - p[0]) * k, a[1] - p[1]
    dx, dy = (b[0] - a[0]) * k, b[1] - a[1]
    l2 = dx * dx + dy * dy
    t = max(0, min(1, -(ax * dx + ay * dy) / l2)) if l2 else 0
    return math.radians(math.hypot(ax + dx * t, ay + dy * t)) * R


def simplify(points, tolerance):
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        best, index = 0, 0
        for i in range(first + 1, last):
            d = point_segment(points[i], points[first], points[last])
            if d > best:
                best, index = d, i
        if best > tolerance:
            keep[index] = True
            stack += [(first, index), (index, last)]
    return [p for p, k in zip(points, keep) if k]


def inside(p, ring):
    x, y = p
    hit = False
    for (x1, y1), (x2, y2) in zip(ring, ring[1:] + ring[:1]):
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            hit = not hit
    return hit


def assemble(ways):
    """Join a relation's member ways into closed rings."""
    pending = [w[:] for w in ways if len(w) > 1]
    rings = []
    while pending:
        ring = pending.pop()
        while ring[0] != ring[-1]:
            for i, w in enumerate(pending):
                if w[0] == ring[-1]:
                    ring += w[1:]
                elif w[-1] == ring[-1]:
                    ring += w[-2::-1]
                elif w[-1] == ring[0]:
                    ring = w[:-1] + ring
                elif w[0] == ring[0]:
                    ring = w[:0:-1] + ring
                else:
                    continue
                pending.pop(i)
                break
            else:
                break  # can't close it; keep what we have
        rings.append(ring)
    return rings


def encode(points, precision=5):
    """Google encoded polyline of (lon, lat) points."""
    out, prev = [], (0, 0)
    factor = 10**precision
    for lon, lat in points:
        cur = (round(lat * factor), round(lon * factor))
        for v in (cur[0] - prev[0], cur[1] - prev[1]):
            v = ~(v << 1) if v < 0 else v << 1
            while v >= 0x20:
                out.append(chr((0x20 | (v & 0x1F)) + 63))
                v >>= 5
            out.append(chr(v + 63))
        prev = cur
    return "".join(out)


def pieces(points):
    """Cut a road into pieces of about PIECE_M, splitting long segments too."""
    result, current, length = [], [points[0]], 0.0
    for a, b in zip(points, points[1:]):
        seg = dist(a, b)
        start, done = a, 0.0
        while length + (seg - done) > PIECE_M * 1.2:
            take = PIECE_M - length
            t = (done + take) / seg
            cut = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            current.append(cut)
            result.append((current, length + take))
            current, length, done, start = [cut], 0.0, done + take, cut
        current.append(b)
        length += seg - done
    if length > 1:
        result.append((current, length))
    return result


# ---------- Build ----------


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", help="folder to keep/reuse the Overpass downloads")
    args = parser.parse_args()

    bounds = cached(args.cache, "bounds.json", BOUNDS_QUERY)
    roads = cached(args.cache, "roads.json", ROADS_QUERY)

    sectors = []
    for rel in bounds["elements"]:
        members = rel["members"]
        outer = [[(p["lon"], p["lat"]) for p in m["geometry"]] for m in members if m["type"] == "way" and m["role"] in ("outer", "")]
        inner = [[(p["lon"], p["lat"]) for p in m["geometry"]] for m in members if m["type"] == "way" and m["role"] == "inner"]
        label = next((m for m in members if m["type"] == "node" and m["role"] == "label"), None) or next(
            (m for m in members if m["type"] == "node" and m["role"] == "admin_centre"), None
        )
        outer_rings = [simplify(r, BOUNDARY_TOLERANCE_M) for r in assemble(outer)]
        inner_rings = [simplify(r, BOUNDARY_TOLERANCE_M) for r in assemble(inner)]
        if label:
            label_point = (label["lon"], label["lat"])
        else:
            big = max(outer_rings, key=len)
            label_point = (sum(p[0] for p in big) / len(big), sum(p[1] for p in big) / len(big))
        sectors.append(
            {
                "osm": rel["id"],
                "id": SECTORS[rel["id"]],
                "name": rel["tags"]["name"],
                "label": [round(label_point[0], 5), round(label_point[1], 5)],
                "outer": outer_rings,
                "inner": inner_rings,
            }
        )
    sectors.sort(key=lambda s: list(SECTORS).index(s["osm"]))

    def sector_of(p):
        for i, s in enumerate(sectors):
            if any(inside(p, r) for r in s["outer"]) and not any(inside(p, r) for r in s["inner"]):
                return i
        return None

    names, name_index = [], {}
    chunks = []
    length = [0.0] * len(sectors)
    streets = [set() for _ in sectors]
    for way in sorted(roads["elements"], key=lambda w: w["id"]):
        points = [(p["lon"], p["lat"]) for p in way["geometry"]]
        if len(points) < 2:
            continue
        tags = way.get("tags", {})
        name = tags.get("name") or tags.get("ref")
        if name and name not in name_index:
            name_index[name] = len(names)
            names.append(name)
        for piece, piece_len in pieces(points):
            mid = piece[len(piece) // 2] if len(piece) > 2 else ((piece[0][0] + piece[-1][0]) / 2, (piece[0][1] + piece[-1][1]) / 2)
            s = sector_of(mid)
            if s is None:
                continue
            chunks.append([s, name_index[name] if name else -1, round(piece_len), encode(simplify(piece, 2))])
            length[s] += piece_len
            if name:
                streets[s].add(name)

    out = {
        "version": VERSION,
        "region": REGION,
        "attribution": "© OpenStreetMap contributors (ODbL)",
        "sectors": [
            {
                "id": s["id"],
                "name": s["name"],
                "label": s["label"],
                "rings": [[[round(x, 5), round(y, 5)] for x, y in r] for r in s["outer"] + s["inner"]],
                "length": round(length[i]),
                "streets": len(streets[i]),
            }
            for i, s in enumerate(sectors)
        ],
        "names": names,
        "chunks": chunks,
    }
    os.makedirs(os.path.dirname(OUTPUT), exist_ok=True)
    with open(OUTPUT, "w") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    for i, s in enumerate(out["sectors"]):
        print(f"{s['name']:<12} {s['length'] / 1000:7.1f} km  {s['streets']:5d} calles  {sum(1 for c in chunks if c[0] == i):6d} tramos")
    print(f"{len(chunks)} tramos, {len(names)} nombres, {os.path.getsize(OUTPUT) / 1024:.0f} KB -> {OUTPUT}")


if __name__ == "__main__":
    main()
