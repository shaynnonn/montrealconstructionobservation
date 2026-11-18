"""
Montréal Construction Observatory: automatic data update.

Downloads the City's "Entraves et travaux en cours" CSV, cleans it the same
way as notebooks/test.ipynb, and merges it into a history file so finished
worksites are kept instead of disappearing.

Writes three files in data/:
  worksites.geojson          worksites active right now (same format the map already uses)
  worksites_history.geojson  every worksite ever seen, with first_seen / last_seen / listed
  last_updated.json          when the update ran and how many worksites it found

Run it from the repo root:
  python scripts/update_data.py                 # download from the City
  python scripts/update_data.py --csv my.csv    # use a local CSV instead (for testing)
"""

import argparse
import io
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

# ---------------------------------------------------------------- settings
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
WORKSITES = DATA / "worksites.geojson"
HISTORY = DATA / "worksites_history.geojson"
LAST_UPDATED = DATA / "last_updated.json"

# The City's open data portal (CKAN). We ask the API for the current file link,
# and fall back to the direct link if the API doesn't answer.
RESOURCE_ID = "cc41b532-f12d-40fb-9f55-eb58c9a2b12b"
API_URL = f"https://donnees.montreal.ca/api/3/action/resource_show?id={RESOURCE_ID}"
FALLBACK_URL = (
    "https://donnees.montreal.ca/dataset/info-travaux/resource/"
    f"{RESOURCE_ID}/download/entraves-travaux-en-cours.csv"
)

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
}
PROPS = list(RENAME_MAP.values())
REQUIRED = {"permit_id", "borough", "reason", "organization", "start_date", "end_date"}

# Safety net: if the new download has fewer than this share of the worksites
# active last time, something is probably wrong with the City's file, so we stop
# without overwriting anything.
MIN_SHARE_OF_PREVIOUS = 0.5

# Date of the September download, used to start the history from the old file
SEED_DATE = "2026-09-25"


# ---------------------------------------------------------------- download
def download_csv() -> pd.DataFrame:
    headers = {"User-Agent": "montreal-construction-observatory (GitHub Actions)"}
    url = FALLBACK_URL
    try:
        req = urllib.request.Request(API_URL, headers=headers)
        with urllib.request.urlopen(req, timeout=60) as r:
            url = json.load(r)["result"]["url"] or FALLBACK_URL
    except Exception as e:  # API down or changed: use the direct link
        print(f"API lookup failed ({e}); using the direct link")
    print("Downloading", url)
    req = urllib.request.Request(url, headers=headers)
    with urllib.request.urlopen(req, timeout=120) as r:
        raw = r.read()
    return pd.read_csv(io.BytesIO(raw))


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
        history[pid] = f

    dropped = 0
    for pid, f in history.items():
        if pid not in current_ids and f["properties"].get("listed", True):
            f["properties"]["listed"] = False  # no longer in the City's file (finished or removed)
            dropped += 1

    print(f"History: {new} new, {updated} still listed, {dropped} no longer listed since last run, "
          f"{len(history)} total")
    return history


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
    parser.add_argument("--today", help="pretend today is YYYY-MM-DD (for testing)")
    args = parser.parse_args()

    today = args.today or datetime.now(timezone.utc).date().isoformat()
    entraves = pd.read_csv(args.csv) if args.csv else download_csv()
    clean = clean_worksites(entraves)
    current = to_features(clean)

    # Safety net against a broken or half-empty download
    history = load_history()
    previous_active = sum(1 for f in history.values() if f["properties"].get("listed", True))
    if previous_active and len(current) < MIN_SHARE_OF_PREVIOUS * previous_active:
        sys.exit(f"STOP: only {len(current)} worksites downloaded vs {previous_active} last time. "
                 "Nothing was overwritten. Check the City's file before running again.")

    history = merge(history, current, today)
    hist_feats = sorted(history.values(), key=lambda f: f["properties"]["permit_id"])

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

    load_date = None
    if "load_date" in entraves.columns:
        load_date = str(entraves["load_date"].dropna().max())
    write_json(LAST_UPDATED, {
        "updated": today,
        "active_worksites": len(current),
        "worksites_in_history": len(hist_feats),
        "city_data_loaded": load_date,
    })
    print("All checks passed")


if __name__ == "__main__":
    main()
