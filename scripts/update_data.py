"""
Montréal Construction Observatory: automatic data update.

Downloads the City's "Entraves et travaux en cours" CSV, cleans it the same
way as notebooks/test.ipynb, adds what each worksite blocks (road, sidewalk,
bike path, bus stop) from the "Impacts" CSV, and merges it into a history file
so finished worksites are kept instead of disappearing. Finally, it links permits
that continue an earlier one (renewals), to show worksites extended past their
planned end date.

Writes three files in data/:
  worksites.geojson          worksites active right now (same format the map already uses)
  worksites_history.geojson  every worksite ever seen, with first_seen / last_seen / listed
  last_updated.json          when the update ran and how many worksites it found
  extension_check.csv        every renewal link with its evidence (for checking by hand)
  possible_missed.csv        near-misses that did NOT pass the rules (to check for missed renewals)

Run it from the repo root:
  python scripts/update_data.py                 # download from the City
  python scripts/update_data.py --csv my.csv    # use a local CSV instead (for testing)
  python scripts/update_data.py --csv my.csv --impacts impacts.csv
  python scripts/update_data.py --extensions-only                 # only redo the renewal links
  python scripts/update_data.py --extensions-only --backfill raw_dataset/entraves-travaux-en-cours.csv
                                # fill in contract numbers for old permits from an older City CSV
"""

import argparse
import io
import json
import math
import re
import sys
import unicodedata
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path

import pandas as pd

# ---------------------------------------------------------------- settings
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
WORKSITES = DATA / "worksites.geojson"
HISTORY = DATA / "worksites_history.geojson"
LAST_UPDATED = DATA / "last_updated.json"
EXTENSION_CHECK = DATA / "extension_check.csv"
POSSIBLE_MISSED = DATA / "possible_missed.csv"

# The City's open data portal (CKAN). We ask the API for the current file link,
# and fall back to the direct link if the API doesn't answer.
DATASET_ID = "667342f7-f667-4c3c-9837-65e81312cd8d"
WORKSITES_RESOURCE = ("cc41b532-f12d-40fb-9f55-eb58c9a2b12b", "entraves-travaux-en-cours.csv")
IMPACTS_RESOURCE = ("a2bc8014-488c-495d-941b-e7ae1999d1bd", "impacts-entraves-travaux-en-cours.csv")

# Rough box around the island of Montréal (same as the notebook)
MIN_LON, MAX_LON = -74.0, -73.45
MIN_LAT, MAX_LAT = 45.39, 45.72

# Same renaming as the notebook. The order here is the order of the popup properties.
RENAME_MAP = {
    "permit_permit_id": "permit_id",
    "boroughid": "borough",
    "permitcategory": "permit_type",
    "currentstatus": "status",
    "reason_category": "reason",
    "submittercategory": "applicant_type",
    "organizationname": "organization",
    "duration_start_date": "start_date",
    "duration_end_date": "end_date",
    "occupancy_name": "occupancy",
    "id": "request_id",          # permit request id: links a worksite to its impacts
    "contractnumber": "contract_number",   # City contract: proves two permits are one project
}
PROPS = list(RENAME_MAP.values())
REQUIRED = {"permit_id", "borough", "reason", "organization", "start_date", "end_date"}

# Safety net: if the new download has fewer than this share of the worksites
# active last time, something is probably wrong with the City's file, so we stop
# without overwriting anything.
MIN_SHARE_OF_PREVIOUS = 0.5

# Date of the September download, used to start the history from the old file
SEED_DATE = "2026-09-25"

# Impacts: French values from the City -> short codes, from worst to least bad.
# When a worksite has several street segments, we keep the worst impact.
ROAD_IMPACT = {
    "Rue barrée": "closed",
    "Voie de stationnement et voie de circulation obstruées": "lane_and_parking",
    "Voie de circulation obstruée": "lane",
    "Voie de stationnement obstruée": "parking",
    "Aucun impact / non applicable": "none",
}
SIDEWALK_IMPACT = {
    "Barré": "closed",
    "Obstrué (un passage piéton de 1,5 m est conservé)": "narrowed",
    "Obstrué": "narrowed",
    "Aucun impact / non applicable": "none",
}
BIKE_IMPACT = {
    "Barrée": "closed",
    "Obstruée": "narrowed",
    "Aucun impact / non applicable": "none",
}
IMPACT_PROPS = ["impact_road", "impact_sidewalk", "impact_bike", "impact_bus", "impact_streets"]


# ---------------------------------------------------------------- download
def download_csv(resource) -> pd.DataFrame:
    resource_id, filename = resource
    headers = {"User-Agent": "montreal-construction-observatory (GitHub Actions)"}
    api_url = f"https://donnees.montreal.ca/api/3/action/resource_show?id={resource_id}"
    url = (f"https://donnees.montreal.ca/dataset/{DATASET_ID}/resource/"
           f"{resource_id}/download/{filename}")
    try:
        req = urllib.request.Request(api_url, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as r:
            url = json.load(r)["result"]["url"] or url
    except Exception as e:  # API down or changed: use the direct link
        print(f"API lookup failed ({e}); using the direct link")
    print("Downloading", url)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
    return pd.read_csv(io.BytesIO(raw))


# ---------------------------------------------------------------- impacts
def worst(values, scale):
    """The worst impact among several street segments (scale is ordered worst first)."""
    order = list(scale.values())
    codes = [scale.get(v) for v in values if scale.get(v)]
    return min(codes, key=order.index) if codes else None


def segment_name(row) -> str:
    """'rue de Bordeaux, from rue Gauthier to rue Rachel Est' (or just the name)."""
    name = str(row["name"]).strip()
    a, b = str(row["fromname"]).strip(), str(row["toname"]).strip()
    if a in ("", "nan", name) and b in ("", "nan", name):
        return name
    return f"{name}, from {a} to {b}"


def summarize_impacts(impacts: pd.DataFrame) -> dict:
    """Returns {request_id: {impact_road, impact_sidewalk, impact_bike, impact_bus, impact_streets}}."""
    for col, scale in [("streetimpacttype", ROAD_IMPACT), ("sidewalk_blockedtype", SIDEWALK_IMPACT),
                       ("backsidewalk_blockedtype", SIDEWALK_IMPACT), ("bikepath_blockedtype", BIKE_IMPACT)]:
        unknown = set(impacts[col].dropna()) - set(scale)
        if unknown:
            print(f"Note: new values in {col} not translated yet: {unknown}")

    summary = {}
    for request_id, rows in impacts.groupby("id_request"):
        sidewalks = list(rows["sidewalk_blockedtype"]) + list(rows["backsidewalk_blockedtype"])
        streets = list(dict.fromkeys(segment_name(r) for _, r in rows.iterrows()))  # unique, in order
        summary[request_id] = {
            "impact_road": worst(rows["streetimpacttype"], ROAD_IMPACT),
            "impact_sidewalk": worst(sidewalks, SIDEWALK_IMPACT),
            "impact_bike": worst(rows["bikepath_blockedtype"], BIKE_IMPACT),
            "impact_bus": bool((rows["stmimpact_blockedtype"] == "Déplacer").any()),
            "impact_streets": streets[:3],   # at most 3 segments in the popup
        }
    return summary


def add_impacts(features: list, summary: dict) -> None:
    matched = 0
    for f in features:
        info = summary.get(f["properties"].get("request_id"))
        if info:
            matched += 1
        for k in IMPACT_PROPS:
            f["properties"][k] = info[k] if info else None   # None = no impact info from the City
    print(f"Impacts: found for {matched} of {len(features)} worksites")


# ---------------------------------------------------------------- clean (= notebook)
def clean_worksites(entraves: pd.DataFrame) -> pd.DataFrame:
    missing_cols = [c for c in RENAME_MAP if c not in entraves.columns]
    if missing_cols:
        sys.exit(f"STOP: the City's CSV is missing columns {missing_cols}. "
                 "They may have renamed them; update RENAME_MAP.")

    keep = list(RENAME_MAP) + ["latitude", "longitude"]
    clean = entraves[keep].rename(columns=RENAME_MAP).copy()

    removed = {}
    n = len(clean); clean = clean.drop_duplicates(); removed["exact duplicates"] = n - len(clean)
    n = len(clean); clean = clean.dropna(subset=["permit_id"]); removed["no permit ID"] = n - len(clean)

    clean["latitude"] = pd.to_numeric(clean["latitude"], errors="coerce")
    clean["longitude"] = pd.to_numeric(clean["longitude"], errors="coerce")
    n = len(clean); clean = clean.dropna(subset=["latitude", "longitude"]); removed["no coordinates"] = n - len(clean)

    n = len(clean)
    inside = (clean["longitude"].between(MIN_LON, MAX_LON)
              & clean["latitude"].between(MIN_LAT, MAX_LAT))
    clean = clean[inside]; removed["outside Montréal"] = n - len(clean)

    # One row per permit (keeps the last if the City ever lists one twice)
    n = len(clean); clean = clean.drop_duplicates(subset=["permit_id"], keep="last")
    removed["repeated permit ID"] = n - len(clean)

    for col in ["borough", "permit_type", "status", "reason", "applicant_type", "organization"]:
        clean[col] = clean[col].astype("string").str.strip()
    for col in ["start_date", "end_date"]:
        clean[col] = pd.to_datetime(clean[col], errors="coerce").dt.date  # date only, like the notebook

    # Contract numbers come in as numbers (441930.0): keep them as text ("441930")
    clean["contract_number"] = clean["contract_number"].map(contract_text)

    print("Raw rows:", len(entraves))
    for reason, count in removed.items():
        print(f"  removed ({reason}): {count}")
    print("Rows left:", len(clean))
    return clean.reset_index(drop=True)


def to_features(clean: pd.DataFrame) -> list:
    geo = clean.astype(object).where(pd.notna(clean), None)  # JSON can't store NaN
    feats = []
    for _, row in geo.iterrows():
        feats.append({
            "type": "Feature",
            "geometry": {"type": "Point",
                         "coordinates": [float(row["longitude"]), float(row["latitude"])]},
            "properties": {k: (str(row[k]) if row[k] is not None and k.endswith("_date") else row[k])
                           for k in PROPS},
        })
    return feats


# ---------------------------------------------------------------- history
def load_json(path: Path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, obj) -> None:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, default=str)


def load_history() -> dict:
    """Returns {permit_id: feature}. Starts from the old worksites.geojson the first time."""
    if HISTORY.exists():
        feats = load_json(HISTORY)["features"]
        return {f["properties"]["permit_id"]: f for f in feats}
    if WORKSITES.exists():
        print(f"No history yet: starting it from the current worksites.geojson ({SEED_DATE})")
        feats = load_json(WORKSITES)["features"]
        for f in feats:
            f["properties"].update(first_seen=SEED_DATE, last_seen=SEED_DATE, listed=True)
        return {f["properties"]["permit_id"]: f for f in feats}
    return {}


def merge(history: dict, current: list, today: str) -> dict:
    current_ids = set()
    new = updated = 0
    for f in current:
        pid = f["properties"]["permit_id"]
        current_ids.add(pid)
        old = history.get(pid)
        first_seen = old["properties"]["first_seen"] if old else today
        if old:
            updated += 1
        else:
            new += 1
        f = json.loads(json.dumps(f))  # copy
        f["properties"].update(first_seen=first_seen, last_seen=today, listed=True)
        # Keep what we already had if this run has none (e.g. the impacts download failed)
        if old:
            for k in IMPACT_PROPS + ["contract_number"]:
                if f["properties"].get(k) is None and old["properties"].get(k) is not None:
                    f["properties"][k] = old["properties"][k]
        history[pid] = f

    dropped = 0
    for pid, f in history.items():
        if pid not in current_ids and f["properties"].get("listed", True):
            f["properties"]["listed"] = False  # no longer in the City's file (finished or removed)
            dropped += 1

    print(f"History: {new} new, {updated} still listed, {dropped} no longer listed since last run, "
          f"{len(history)} total")
    return history



# ---------------------------------------------------------------- extensions (renewed permits)
# When work runs late, the City doesn't change the end date: it issues a NEW permit at the
# same place. These rules link a new permit to the one it continues.
EXT_MAX_GAP_DAYS = 7          # new permit starts within 7 days before/after the old one ends
EXT_SAME_TEXT_MAX_M = 50      # same street text: up to 50 m apart
EXT_OTHER_TEXT_MAX_M = 10     # different street text: almost the same point
EXT_SHORT_PERMIT_DAYS = 7     # first permit shorter than this = "repeated short permits"
MISSED_MAX_M = 100            # near-misses exported for checking
MISSED_MAX_GAP_DAYS = 30
EXT_PROPS = ["chain_id", "chain_size", "chain_position", "chain_start", "original_end",
             "chain_type", "chain_confidence"]
# Known renewal that must always be detected (Pomerleau, University between Pins and University)
KNOWN_CASES = [("OCC-2510DP14469802", "OCC-2609BG07437359")]


def contract_text(v):
    """441930.0 -> '441930'; empty -> None."""
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return None
    t = str(v).strip()
    if t.endswith(".0"):
        t = t[:-2]
    return t or None


def norm_text(s) -> str:
    """Lower case, no accents, no punctuation, single spaces."""
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-z0-9 ]", " ", s.lower())
    return " ".join(s.split())


def norm_org(s) -> str:
    """'POMERLEAU INC.' and 'Pomerleau inc' -> 'pomerleau'."""
    words = norm_text(s).split()
    while words and words[-1] in {"inc", "ltee", "ltd", "limitee", "senc", "enr", "co"}:
        words.pop()
    return " ".join(words)


def to_date(s):
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def metres(a, b) -> float:
    """Distance between two [lon, lat] points (good enough at Montréal's latitude)."""
    return math.hypot((a[0] - b[0]) * 78_700, (a[1] - b[1]) * 111_000)


def find_extension_links(history: dict):
    """Returns (links, near_misses). A link = (old_feature, new_feature, evidence dict)."""
    feats = list(history.values())
    info = []
    for f in feats:
        p = f["properties"]
        info.append({
            "f": f, "p": p, "xy": f["geometry"]["coordinates"],
            "org": norm_org(p.get("organization")), "text": norm_text(p.get("occupancy")),
            "start": to_date(p.get("start_date")), "end": to_date(p.get("end_date")),
        })

    # Grid index (~100 m cells) so we only compare permits that are close to each other
    cell = 0.001
    grid = {}
    for i in info:
        grid.setdefault((int(i["xy"][0] / cell), int(i["xy"][1] / cell)), []).append(i)

    candidates, near_misses = [], []
    for a in info:                                     # a = the earlier permit
        if not (a["org"] and a["end"] and a["start"]):
            continue
        gx, gy = int(a["xy"][0] / cell), int(a["xy"][1] / cell)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for b in grid.get((gx + dx, gy + dy), []):   # b = the possible continuation
                    if b is a or b["org"] != a["org"] or not (b["start"] and b["end"]):
                        continue
                    dist = metres(a["xy"], b["xy"])
                    gap = (b["start"] - a["end"]).days
                    same_text = bool(a["text"]) and a["text"] == b["text"]
                    same_reason = a["p"].get("reason") == b["p"].get("reason")
                    ca, cb = a["p"].get("contract_number"), b["p"].get("contract_number")

                    rules = {
                        "same_place": (same_text and dist <= EXT_SAME_TEXT_MAX_M) or dist <= EXT_OTHER_TEXT_MAX_M,
                        "timing": -EXT_MAX_GAP_DAYS <= gap <= EXT_MAX_GAP_DAYS,
                        "ends_later": b["end"] > a["end"],
                        "starts_later": b["start"] > a["start"],
                        "same_borough": a["p"].get("borough") == b["p"].get("borough"),
                        "seen_order": str(b["p"].get("first_seen", "")) >= str(a["p"].get("first_seen", "")),
                        "contracts_agree": not (ca and cb and ca != cb),   # different contracts = different projects
                    }
                    evidence = {
                        "distance_m": round(dist, 1), "gap_days": gap, "same_text": same_text,
                        "same_reason": same_reason,
                        "contract": ("same" if ca and cb and ca == cb else
                                     "different" if ca and cb else "unknown"),
                        "confidence": "high" if same_text and same_reason else "medium",
                    }
                    if all(rules.values()):
                        # Best match first: same text, same reason, same contract, closest, smallest gap
                        score = (not same_text, not same_reason, evidence["contract"] != "same",
                                 dist, abs(gap))
                        candidates.append((score, a, b, evidence))
                    elif dist <= MISSED_MAX_M and abs(gap) <= MISSED_MAX_GAP_DAYS and b["start"] > a["start"]:
                        failed = [k for k, ok in rules.items() if not ok]
                        near_misses.append((a, b, evidence, failed))

    # One-to-one: each permit continues at most one, and is continued by at most one
    candidates.sort(key=lambda c: c[0])
    used_old, used_new, links = set(), set(), []
    for score, a, b, ev in candidates:
        if id(a) in used_old or id(b) in used_new:
            continue
        used_old.add(id(a))
        used_new.add(id(b))
        links.append((a, b, ev))
    return links, near_misses


def apply_extension_chains(history: dict, links: list) -> dict:
    """Group links into chains and write the chain fields on every permit. Returns stats."""
    for f in history.values():
        for k in EXT_PROPS:
            f["properties"].pop(k, None)

    nxt = {id(a["f"]): (b, ev) for a, b, ev in links}
    has_prev = {id(b["f"]) for a, b, ev in links}
    by_id = {id(i["f"]): i for a, b, ev in links for i in (a, b)}

    stats = {"extended": 0, "repeated_short": 0, "high": 0, "medium": 0}
    for key, first in by_id.items():
        if key in has_prev:
            continue                                   # not the start of a chain
        chain, confs, cur = [first], [], first
        while id(cur["f"]) in nxt:
            cur, ev = nxt[id(cur["f"])]
            chain.append(cur)
            confs.append(ev["confidence"])
        planned_days = (first["end"] - first["start"]).days
        chain_type = "extended" if planned_days >= EXT_SHORT_PERMIT_DAYS else "repeated_short"
        confidence = "high" if all(c == "high" for c in confs) else "medium"
        stats[chain_type] += 1
        stats[confidence] += 1
        for pos, member in enumerate(chain, start=1):
            member["p"].update({
                "chain_id": first["p"]["permit_id"],
                "chain_size": len(chain),
                "chain_position": pos,
                "chain_start": first["p"]["start_date"],
                "original_end": first["p"]["end_date"],
                "chain_type": chain_type,
                "chain_confidence": confidence,
            })
    return stats


def check_extensions(links: list, history: dict) -> None:
    """Sanity checks: stop the update if the matching ever produces something impossible."""
    olds = [id(a["f"]) for a, b, ev in links]
    news = [id(b["f"]) for a, b, ev in links]
    assert len(olds) == len(set(olds)), "a permit is continued by two permits"
    assert len(news) == len(set(news)), "a permit continues two permits"
    for a, b, ev in links:
        assert a["f"] is not b["f"], "a permit is linked to itself"
        assert a["p"].get("borough") == b["p"].get("borough"), "link across boroughs"
        assert abs(ev["gap_days"]) <= EXT_MAX_GAP_DAYS, "link outside the time window"
        assert b["end"] > a["end"], "continuation doesn't end later"
    linked = {(a["p"]["permit_id"], b["p"]["permit_id"]) for a, b, ev in links}
    for old_id, new_id in KNOWN_CASES:
        if old_id in history and new_id in history:
            assert (old_id, new_id) in linked, f"known renewal {old_id} -> {new_id} not detected"


def export_extension_csvs(links: list, near_misses: list) -> None:
    def row(a, b, ev):
        pa, pb = a["p"], b["p"]
        return {
            "old_permit": pa["permit_id"], "new_permit": pb["permit_id"],
            "organization": pa.get("organization"), "borough": pa.get("borough"),
            "old_occupancy": pa.get("occupancy"), "new_occupancy": pb.get("occupancy"),
            "old_reason": pa.get("reason"), "new_reason": pb.get("reason"),
            "old_start": pa.get("start_date"), "old_end": pa.get("end_date"),
            "new_start": pb.get("start_date"), "new_end": pb.get("end_date"),
            "old_contract": pa.get("contract_number"), "new_contract": pb.get("contract_number"),
            **ev,
            "wkt": f"LINESTRING({a['xy'][0]} {a['xy'][1]}, {b['xy'][0]} {b['xy'][1]})",
        }
    rows = [dict(link_id=i + 1, **row(a, b, ev)) for i, (a, b, ev) in enumerate(links)]
    pd.DataFrame(rows).to_csv(EXTENSION_CHECK, index=False, encoding="utf-8-sig")
    miss = [dict(**row(a, b, ev), failed_rules=", ".join(failed)) for a, b, ev, failed in near_misses]
    pd.DataFrame(miss).to_csv(POSSIBLE_MISSED, index=False, encoding="utf-8-sig")


def backfill_from_csv(history: dict, path: str) -> None:
    """Fill in contract numbers (and request ids) for old permits from an older City CSV."""
    old = pd.read_csv(path)
    by_permit = {r["permit_permit_id"]: r for _, r in old.iterrows()}
    filled = 0
    for pid, f in history.items():
        r = by_permit.get(pid)
        if r is None:
            continue
        p = f["properties"]
        if p.get("contract_number") is None and contract_text(r.get("contractnumber")):
            p["contract_number"] = contract_text(r.get("contractnumber"))
            filled += 1
        if p.get("request_id") is None and isinstance(r.get("id"), str):
            p["request_id"] = r["id"]
    print(f"Backfill: contract numbers added to {filled} permits from {path}")


def update_extensions(history: dict) -> dict:
    links, near_misses = find_extension_links(history)
    check_extensions(links, history)
    stats = apply_extension_chains(history, links)
    export_extension_csvs(links, near_misses)

    with_contracts = [ev for a, b, ev in links if ev["contract"] != "unknown"]
    confirmed = sum(ev["contract"] == "same" for ev in with_contracts)
    stats.update(links=len(links), near_misses=len(near_misses),
                 contract_checked=len(with_contracts), contract_confirmed=confirmed)
    share = f"{confirmed / len(with_contracts):.0%}" if with_contracts else "n/a"
    print(f"Extensions: {len(links)} links in {stats['extended'] + stats['repeated_short']} chains "
          f"({stats['extended']} extended, {stats['repeated_short']} repeated short; "
          f"{stats['high']} high, {stats['medium']} medium confidence)")
    print(f"  contract-number check: {confirmed}/{len(with_contracts)} links share the same contract ({share})")
    print(f"  near-misses for checking: {len(near_misses)} (see {POSSIBLE_MISSED.name})")
    return stats


# ---------------------------------------------------------------- checks (= notebook check cell)
def check(feats: list, label: str) -> None:
    assert len(feats) > 0, f"{label}: file is empty"
    for f in feats:
        x, y = f["geometry"]["coordinates"]
        assert MIN_LON <= x <= MAX_LON and MIN_LAT <= y <= MAX_LAT, f"{label}: point outside Montréal"
        assert REQUIRED <= f["properties"].keys(), f"{label}: worksite missing popup properties"


# ---------------------------------------------------------------- main
def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--csv", help="use a local CSV instead of downloading")
    parser.add_argument("--impacts", help="use a local impacts CSV instead of downloading")
    parser.add_argument("--today", help="pretend today is YYYY-MM-DD (for testing)")
    parser.add_argument("--extensions-only", action="store_true",
                        help="don't download: only redo the renewal links on the saved history")
    parser.add_argument("--backfill", help="older City CSV to fill in missing contract numbers")
    args = parser.parse_args()

    today = args.today or datetime.now(timezone.utc).date().isoformat()
    history = load_history()
    entraves = None

    if args.extensions_only:
        if not HISTORY.exists():
            sys.exit("STOP: no worksites_history.geojson yet. Run a normal update first.")
    else:
        entraves = pd.read_csv(args.csv) if args.csv else download_csv(WORKSITES_RESOURCE)
        clean = clean_worksites(entraves)
        current = to_features(clean)

        # What each worksite blocks. Optional: if the impacts file fails, the update still runs.
        try:
            impacts = pd.read_csv(args.impacts) if args.impacts else download_csv(IMPACTS_RESOURCE)
            add_impacts(current, summarize_impacts(impacts))
        except Exception as e:
            print(f"WARNING: impacts not added this time ({e})")
            add_impacts(current, {})

        # Safety net against a broken or half-empty download
        previous_active = sum(1 for f in history.values() if f["properties"].get("listed", True))
        if previous_active and len(current) < MIN_SHARE_OF_PREVIOUS * previous_active:
            sys.exit(f"STOP: only {len(current)} worksites downloaded vs {previous_active} last time. "
                     "Nothing was overwritten. Check the City's file before running again.")

        history = merge(history, current, today)

    if args.backfill:
        backfill_from_csv(history, args.backfill)

    ext_stats = update_extensions(history)

    hist_feats = sorted(history.values(), key=lambda f: f["properties"]["permit_id"])
    current = [f for f in hist_feats if f["properties"].get("listed")]   # active now, with chain fields

    check(current, "worksites.geojson")
    check(hist_feats, "worksites_history.geojson")

    DATA.mkdir(exist_ok=True)
    write_json(WORKSITES, {"type": "FeatureCollection", "features": current})
    write_json(HISTORY, {"type": "FeatureCollection", "features": hist_feats})

    size_mb = WORKSITES.stat().st_size / 1_000_000
    assert size_mb < 5, "worksites.geojson too big for the page"
    print(f"worksites.geojson: {len(current)} active worksites, {size_mb:.2f} MB")
    print(f"worksites_history.geojson: {len(hist_feats)} worksites, "
          f"{HISTORY.stat().st_size / 1_000_000:.2f} MB")

    previous = load_json(LAST_UPDATED) if LAST_UPDATED.exists() else {}
    load_date = previous.get("city_data_loaded")
    if entraves is not None and "load_date" in entraves.columns:
        load_date = str(entraves["load_date"].dropna().max())
    write_json(LAST_UPDATED, {
        "updated": previous.get("updated", today) if args.extensions_only else today,
        "active_worksites": len(current),
        "worksites_in_history": len(hist_feats),
        "city_data_loaded": load_date,
        "extensions": ext_stats,
    })
    print("All checks passed")


if __name__ == "__main__":
    main()
