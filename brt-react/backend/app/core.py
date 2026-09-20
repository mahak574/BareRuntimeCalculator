"""
core.py - Core Math and Machine Learning Engine for BRT Calculator

This module is responsible for loading the massive train datasets (Excel/CSV),
cleaning them, building one-hop journeys between consecutive stations, and then
applying K-Means clustering and statistical outlier removal to calculate the 
optimal Base Running Time (BRT), Acceleration, and Deceleration metrics.

Key concepts:
- One-Hop Journey: A single trip of one train between two immediate stations.
- Clustering: K-Means is used to find the most common (dense) speed clusters.
- Fallback Pools: If a specific train doesn't have enough data on a leg, 
  the engine falls back to looking at ALL trains of the same speed class.
"""

import glob
import os
import time
import threading

import numpy as np
import pandas as pd
from scipy.optimize import lsq_linear
from sklearn.cluster import KMeans

CACHE_VERSION = "v16_react_api"
MOVEMENT_COLS = ["train", "train_date", "cadarvldprttime", "cacarvldprtflag", "cavsttncode"]
MASTER_COLS = ["TRAINNUMBER", "SEQNUMBER", "STTNCODE", "MANRUNTIME", "MANINTRDIST"]

COMBOS = ["T-T", "D-T", "T-A", "D-A"]
MIN_COMBO_SAMPLES = 5
MIN_LEG_SAMPLES = 5
MIN_CORR_SAMPLES = 5
MAD_OUTLIER_THRESHOLD = 3.5
DISTANCE_BAND_KM = 2.0
MIN_BLOCKS_FOR_POOL = 3
BROAD_POOL_MIN_CORR_SAMPLES = 30
MAX_ACCEL_DECEL_MINUTES = 15.0
MAX_FIT_CONDITION_NUMBER = 1e8

EMPTY_LEG_COLUMNS = ["train", "train_date", "Travel_Time", "flag_a", "flag_b"]

DATA_DIR = os.environ.get("BRT_DATA_DIR", ".")
MOVEMENT_FILE = os.environ.get("BRT_MOVEMENT_FILE", "cris 1.csv")
MASTER_FILE = os.environ.get("BRT_MASTER_FILE", "cris 2.xlsx")
ROUTE_FILE = os.environ.get("BRT_ROUTE_FILE", "bina kota.xlsx")
SCHEDULE_FILE = os.environ.get("BRT_SCHEDULE_FILE", "schedule.xlsx")

_CACHE_LOCK = threading.Lock()
_CACHE = {}


def cache_get(key):
    return _CACHE.get(key)


def cache_set(key, value):
    with _CACHE_LOCK:
        _CACHE[key] = value
    return value


def clear_cache():
    with _CACHE_LOCK:
        _CACHE.clear()


def resolve_input_path(preferred_path):
    preferred_path = os.path.abspath(preferred_path)
    if os.path.exists(preferred_path):
        return preferred_path
    folder = os.path.dirname(preferred_path) or "."
    stem, ext = os.path.splitext(os.path.basename(preferred_path))
    candidates = [
        os.path.join(folder, f"{stem}(1){ext}"),
        os.path.join(folder, f"{stem} (1){ext}"),
    ]
    for candidate in candidates:
        if os.path.exists(candidate):
            return candidate
    return preferred_path


def versioned_parquet_path(source_path):
    stem, _ = os.path.splitext(source_path)
    return f"{stem}_{CACHE_VERSION}.parquet"


def journey_cache_path():
    return f"journey_{CACHE_VERSION}.parquet"


def read_cached_dataframe(parquet_path):
    if os.path.exists(parquet_path):
        try:
            return pd.read_parquet(parquet_path)
        except Exception:
            pass
    return None


def write_cached_dataframe(df, parquet_path):
    try:
        df.to_parquet(parquet_path, index=False)
    except Exception:
        pass
    return parquet_path


def clear_local_cache_files():
    patterns = [
        f"*_{CACHE_VERSION}.parquet",
        f"journey_{CACHE_VERSION}.parquet",
        "*_layout_cache.json",
    ]
    removed = 0
    for pattern in patterns:
        for path in glob.glob(os.path.join(DATA_DIR, pattern)):
            try:
                os.remove(path)
                removed += 1
            except OSError:
                pass
    return removed


def build_one_hop_journey(movement_df):
    df = movement_df.copy()
    group = df.groupby(["train", "train_date"], sort=False)
    df["next_flag"] = group["cacarvldprtflag"].shift(-1)
    df["Next_Station"] = group["cavsttncode"].shift(-1)
    df["Next_Time"] = group["cadarvldprttime"].shift(-1)

    df["combination"] = df["cacarvldprtflag"].astype("string") + "-" + df["next_flag"].astype("string")
    journey = df[df["combination"].isin(COMBOS)].copy()
    journey["Travel_Time"] = (journey["Next_Time"] - journey["cadarvldprttime"]).dt.total_seconds() / 60.0
    journey = journey[journey["Travel_Time"] > 0]

    return journey[[
        "train", "train_date", "cavsttncode", "Next_Station",
        "Travel_Time", "cacarvldprtflag", "next_flag",
    ]].copy()


def _build_journey_index(journey_df):
    journey_index = {}
    for (station_a, station_b), grp in journey_df.groupby(["cavsttncode", "Next_Station"], sort=False):
        journey_index[(station_a, station_b)] = (
            grp[["train", "train_date", "Travel_Time", "cacarvldprtflag", "next_flag"]]
            .rename(columns={"cacarvldprtflag": "flag_a", "next_flag": "flag_b"})
            .reset_index(drop=True)
        )
    return journey_index


def _distance_band(distance_km):
    if pd.isna(distance_km):
        return np.nan
    return float(np.floor(float(distance_km) / DISTANCE_BAND_KM) * DISTANCE_BAND_KM)


def fit_accel_decel(is_departure_start, is_arrival_stop, travel_time, min_samples=MIN_COMBO_SAMPLES):
    y = np.asarray(travel_time, dtype=float)
    is_d = np.asarray(is_departure_start, dtype=float)
    is_a = np.asarray(is_arrival_stop, dtype=float)
    mask = ~np.isnan(y)
    y, is_d, is_a = y[mask], is_d[mask], is_a[mask]
    n = len(y)
    if n < min_samples:
        return None

    X = np.column_stack([np.ones(n), is_d + is_a, is_d])
    gram = X.T @ X
    try:
        if np.linalg.cond(gram) > MAX_FIT_CONDITION_NUMBER:
            return None
    except np.linalg.LinAlgError:
        return None

    try:
        fit = lsq_linear(X, y, bounds=([-np.inf, 0.0, 0.0], [np.inf, np.inf, np.inf]))
    except Exception:
        return None

    baseline, delta, gamma = fit.x
    decel, accel = float(delta), float(delta + gamma)

    if not (np.isfinite(accel) and np.isfinite(decel)) or accel > MAX_ACCEL_DECEL_MINUTES or decel > MAX_ACCEL_DECEL_MINUTES:
        return None

    p = X.shape[1]
    dof = max(n - p, 1)
    resid = y - X @ fit.x
    sigma2 = float(resid @ resid) / dof

    cov = sigma2 * np.linalg.pinv(gram)
    se_decel = float(np.sqrt(max(cov[1, 1], 0.0)))
    se_accel = float(np.sqrt(max(cov[1, 1] + cov[2, 2] + 2 * cov[1, 2], 0.0)))

    return {
        "baseline": float(baseline), "accel": min(max(accel, 0.0), 3.5), "decel": min(max(decel, 0.0), 3.0),
        "se_accel": se_accel, "se_decel": se_decel, "samples": n,
    }


def _pool_stats_map(enriched_df, keys, min_corr_samples=MIN_CORR_SAMPLES):
    if enriched_df.empty:
        return {}

    if "cavsttncode" in enriched_df.columns and "Next_Station" in enriched_df.columns:
        block_id = (
            enriched_df["cavsttncode"].astype(str)
            + "->"
            + enriched_df["Next_Station"].astype(str)
        )
        enriched_df = enriched_df.assign(block_id=block_id)
    else:
        block_id = None

    enriched_df = enriched_df.assign(
        is_d=enriched_df["combination"].str.startswith("D"),
        is_a=enriched_df["combination"].str.endswith("A")
    )

    output = {}

    grouped = enriched_df.groupby(
        list(keys),
        dropna=False,
        sort=False,
    )

    for key, grp in grouped:

        is_d = grp["is_d"]
        is_a = grp["is_a"]

        fit = fit_accel_decel(
            is_d,
            is_a,
            grp["Travel_Time"],
            min_samples=min_corr_samples,
        )

        block_n = grp["block_id"].nunique() if block_id is not None else 0

        out_key = key[0] if len(keys) == 1 and isinstance(key, tuple) else key

        output[out_key] = {
            "accel": fit["accel"] if fit else np.nan,
            "decel": fit["decel"] if fit else np.nan,
            "se_accel": fit["se_accel"] if fit else np.nan,
            "se_decel": fit["se_decel"] if fit else np.nan,
            "samples": fit["samples"] if fit else len(grp),
            "block_n": block_n,
        }

    return output


def build_correction_pools(journey_df, master_df, section_map):
    route_meta = master_df.dropna(subset=["NEXT_STATION"]).copy()
    route_meta["block_set"] = route_meta["STTNCODE"] + "-" + route_meta["NEXT_STATION"]
    route_meta["section_name"] = route_meta["block_set"].map(section_map)
    route_meta["distance_band"] = route_meta["MANINTRDIST"].apply(_distance_band)
    route_meta = route_meta[[
        "TRAINNUMBER", "STTNCODE", "NEXT_STATION", "MPS", "MANINTRDIST", "section_name", "distance_band",
    ]].drop_duplicates(subset=["TRAINNUMBER", "STTNCODE", "NEXT_STATION"])

    empty = {"exact": {}, "block_mps": {}, "distance_mps": {}, "train_mps": {}, "mps": {}}
    if journey_df.empty or route_meta.empty:
        return empty

    enriched = journey_df.merge(
        route_meta, left_on=["train", "cavsttncode", "Next_Station"],
        right_on=["TRAINNUMBER", "STTNCODE", "NEXT_STATION"], how="inner",
    )
    if enriched.empty:
        return empty

    enriched["combination"] = enriched["cacarvldprtflag"].astype("string") + "-" + enriched["next_flag"].astype("string")
    enriched = enriched[enriched["combination"].isin(COMBOS)].copy()

    return {
        "exact": _pool_stats_map(enriched, ["train", "cavsttncode", "Next_Station"]),
        "block_mps": _pool_stats_map(enriched, ["cavsttncode", "Next_Station", "MPS"]),
        "distance_mps": _pool_stats_map(enriched, ["section_name", "distance_band", "MPS"], BROAD_POOL_MIN_CORR_SAMPLES),
        "train_mps": _pool_stats_map(enriched, ["train", "MPS"], BROAD_POOL_MIN_CORR_SAMPLES),
        "mps": _pool_stats_map(enriched, ["MPS"], BROAD_POOL_MIN_CORR_SAMPLES),
    }


def load_and_process_data(force_reload=False):
    """
    Main pipeline to load, clean, and cache the raw dataset files.
    Reads MOVEMENT, MASTER, and LAYOUT files, filters for the desired timeframe,
    computes 1-hop journeys between stations, and builds the statistical
    correction pools for acceleration/deceleration.
    
    Args:
        force_reload (bool): If True, bypasses cache and forces reading from raw CSV/Excel.
        
    Returns:
        dict: A massive dictionary containing the structured DataFrames and lookup tables.
    """
    cache_key = "loaded_data"
    if not force_reload:
        cached = cache_get(cache_key)
        if cached is not None:
            return cached

    start = time.perf_counter()
    movement_path = resolve_input_path(os.path.join(DATA_DIR, MOVEMENT_FILE))
    master_path = resolve_input_path(os.path.join(DATA_DIR, MASTER_FILE))

    movement_parquet = versioned_parquet_path(movement_path)
    movement_df = read_cached_dataframe(movement_parquet)

    if movement_df is None:
        movement_df = pd.read_csv(
            movement_path, usecols=MOVEMENT_COLS, engine="pyarrow",
            dtype={"cacarvldprtflag": "string", "cavsttncode": "string"},
        )
        write_cached_dataframe(movement_df, movement_parquet)

    movement_df["cadarvldprttime"] = pd.to_datetime(movement_df["cadarvldprttime"], errors="coerce")
    movement_df["train_date"] = pd.to_datetime(movement_df["train_date"], errors="coerce")
    movement_df = movement_df.dropna(subset=["cadarvldprttime", "train_date", "train", "cavsttncode"]).copy()
    movement_df["train"] = pd.to_numeric(movement_df["train"], errors="coerce")
    movement_df = movement_df.dropna(subset=["train"])
    movement_df["train"] = movement_df["train"].astype(int).astype(str)
    movement_df["cavsttncode"] = movement_df["cavsttncode"].astype(str).str.strip()
    movement_df["cacarvldprtflag"] = movement_df["cacarvldprtflag"].astype("string").str.strip()

    movement_df = movement_df.drop_duplicates(
        subset=["train", "train_date", "cavsttncode", "cadarvldprttime", "cacarvldprtflag"]
    )
    movement_df = movement_df.sort_values(["train", "train_date", "cadarvldprttime"], kind="mergesort").reset_index(drop=True)

    master_xl = pd.ExcelFile(master_path)
    full_master_df = pd.read_excel(master_xl, sheet_name="Sheet1")
    full_master_df.columns = [str(c).strip() for c in full_master_df.columns]

    missing_cols = [c for c in MASTER_COLS if c not in full_master_df.columns]
    if missing_cols:
        raise ValueError(f"Required column(s) {missing_cols} not found in master data (Sheet1).")

    master = full_master_df[MASTER_COLS].copy()
    master["TRAINNUMBER"] = pd.to_numeric(master["TRAINNUMBER"], errors="coerce")
    master = master.dropna(subset=["TRAINNUMBER"]).copy()
    master["TRAINNUMBER"] = master["TRAINNUMBER"].astype(int).astype(str)
    master["STTNCODE"] = master["STTNCODE"].astype(str).str.strip()
    master = master.sort_values(["TRAINNUMBER", "SEQNUMBER"], kind="mergesort").copy()
    master["NEXT_STATION"] = master.groupby("TRAINNUMBER", sort=False)["STTNCODE"].shift(-1)

    try:
        mps_df = pd.read_excel(master_xl, sheet_name="Sheet2")
        mps_df.columns = [str(c).strip().upper() for c in mps_df.columns]
        mps_df["TRAIN"] = pd.to_numeric(mps_df["TRAIN"], errors="coerce")
        mps_df = mps_df.dropna(subset=["TRAIN"]).copy()
        mps_df["TRAIN"] = mps_df["TRAIN"].astype(int).astype(str)
        mps_df = mps_df[["TRAIN", "MPS"]].drop_duplicates("TRAIN").rename(columns={"TRAIN": "TRAINNUMBER"})
        master = master.merge(mps_df, on="TRAINNUMBER", how="left")
    except Exception:
        master["MPS"] = np.nan
    master["MPS"] = pd.to_numeric(master["MPS"], errors="coerce")

    try:
        section_df = pd.read_excel(master_xl, sheet_name="Sheet3")
        section_df.columns = [str(c).strip().upper() for c in section_df.columns]
        section_df = section_df[["SECTION", "BLCKSCTN"]].dropna().drop_duplicates("BLCKSCTN")
        section_map = dict(zip(
            section_df["BLCKSCTN"].astype(str).str.strip(),
            section_df["SECTION"].astype(str).str.strip(),
        ))
    except Exception:
        section_map = {}

    common_trains = set(movement_df["train"]).intersection(set(master["TRAINNUMBER"]))
    movement_df = movement_df[movement_df["train"].isin(common_trains)].copy()
    master = master[master["TRAINNUMBER"].isin(common_trains)].copy()

    journey_cache = os.path.join(DATA_DIR, journey_cache_path())
    journey_df = read_cached_dataframe(journey_cache)

    if journey_df is None:
        journey_df = build_one_hop_journey(movement_df)
        route_pairs = master.dropna(subset=["NEXT_STATION"])[["TRAINNUMBER", "STTNCODE", "NEXT_STATION"]].drop_duplicates()
        journey_df = journey_df.merge(
            route_pairs, left_on=["train", "cavsttncode", "Next_Station"],
            right_on=["TRAINNUMBER", "STTNCODE", "NEXT_STATION"], how="inner",
        )
        journey_df = journey_df[[
            "train", "train_date", "cavsttncode", "Next_Station",
            "Travel_Time", "cacarvldprtflag", "next_flag",
        ]].copy()
        write_cached_dataframe(journey_df, journey_cache)

    journey_index = _build_journey_index(journey_df)
    chart_bounds = compute_global_chart_bounds(journey_df)          # <-- naya
    correction_pools = build_correction_pools(journey_df, master, section_map)

    result = {
        "master": master,
        "section_map": section_map,
        "journey_index": journey_index,
        "correction_pools": correction_pools,
        "chart_bounds": chart_bounds,                                 # <-- naya
        "load_time_sec": round(time.perf_counter() - start, 2),
    }
    cache_set(cache_key, result)
    return result


def get_leg_subset(station_a, station_b, trains, journey_index):
    subset = journey_index.get((station_a, station_b))
    if subset is None or subset.empty:
        return pd.DataFrame(columns=EMPTY_LEG_COLUMNS)
    if trains is not None:
        subset = subset[subset["train"].isin(list(trains))]
    return subset.copy()


def round_to_nearest_15_sec(minutes):
    if pd.isna(minutes):
        return np.nan
    return round((minutes * 60.0) / 15.0) * 15.0 / 60.0


def robust_mean_1d(values, min_samples=MIN_COMBO_SAMPLES):
    x = pd.Series(values).dropna().astype(float).to_numpy()
    if len(x) == 0:
        return np.nan
    if len(x) < min_samples:
        return float(np.mean(x))
    median = np.median(x)
    mad = np.median(np.abs(x - median))
    if mad == 0:
        return float(np.mean(x))
    robust_z = np.abs(x - median) / (1.4826 * mad)
    clean = x[robust_z <= 3.5]
    if len(clean) < min_samples:
        clean = x
    return float(np.mean(clean))


def get_dominant_combination(subset):
    if subset is None or subset.empty:
        return "N/A"
    combo = subset["flag_a"].astype(str) + "-" + subset["flag_b"].astype(str)
    counts = combo.value_counts()
    return counts.idxmax() if not counts.empty else "N/A"


def detect_outliers_mad(values, threshold=MAD_OUTLIER_THRESHOLD):
    x = np.asarray(values, dtype=float)
    if len(x) < 5:
        return np.ones(len(x), dtype=int)
    median = np.median(x)
    mad = np.median(np.abs(x - median))
    if mad == 0:
        return np.ones(len(x), dtype=int)
    robust_z = 0.6745 * (x - median) / mad
    return np.where(np.abs(robust_z) > threshold, -1, 1)


def compute_leg_raw_brt(subset, mad_threshold=MAD_OUTLIER_THRESHOLD, n_clusters=3):
    data_df = subset[["Travel_Time", "train_date"]].dropna(subset=["Travel_Time"])
    travel_times, dates = data_df["Travel_Time"], data_df["train_date"]

    if len(travel_times) == 0:
        return np.nan, 0, [], np.nan

    if len(travel_times) < 5:
        raw = float(travel_times.mean())
        se_raw = float(travel_times.std(ddof=1) / np.sqrt(len(travel_times))) if len(travel_times) > 1 else np.inf
        points = [
            {"date": d.isoformat(), "minutes": float(t), "is_outlier": False, "cluster": None}
            for t, d in zip(travel_times, dates)
        ]
        return raw, len(travel_times), points, se_raw

    preds = detect_outliers_mad(travel_times.values, threshold=mad_threshold)
    clean_mask = preds == 1
    clean_times, clean_dates = travel_times[clean_mask], dates[clean_mask]

    if len(clean_times) < n_clusters:
        clean_times, clean_dates = travel_times, dates

    effective_k = max(min(n_clusters, int(clean_times.nunique())), 1)
    clean_vals = clean_times.to_numpy().reshape(-1, 1)

    if effective_k == 1:
        labels = np.zeros(len(clean_vals), dtype=int)
    else:
        kmeans = KMeans(n_clusters=effective_k, random_state=42, n_init=3)
        labels = kmeans.fit_predict(clean_vals)

    cluster_means = {int(c): float(clean_vals[labels == c].mean()) for c in np.unique(labels)}
    lower_cluster = int(min(cluster_means, key=cluster_means.get))
    lower_mask = labels == lower_cluster
    lower_times = clean_times.to_numpy()[lower_mask]

    if len(lower_times) >= MIN_LEG_SAMPLES:
        raw_brt = float(np.mean(lower_times))
        raw_brt_samples = len(lower_times)
        se_raw = float(np.std(lower_times, ddof=1) / np.sqrt(raw_brt_samples)) if raw_brt_samples > 1 else np.inf
    else:
        clean_arr = clean_times.to_numpy()
        raw_brt = float(np.mean(clean_arr))
        raw_brt_samples = len(clean_arr)
        se_raw = float(np.std(clean_arr, ddof=1) / np.sqrt(raw_brt_samples)) if raw_brt_samples > 1 else np.inf

    outlier_map = dict(zip(travel_times.index, preds))
    points = []
    for idx, t, d in zip(travel_times.index, travel_times, dates):
        is_outlier = outlier_map.get(idx) == -1
        cluster = None
        if idx in clean_times.index:
            pos = clean_times.index.get_loc(idx)
            cluster = int(labels[pos])
        points.append({
            "date": d.isoformat(),
            "minutes": float(t),
            "is_outlier": bool(is_outlier),
            "cluster": cluster,
            "is_lower_cluster": bool(cluster == lower_cluster) if cluster is not None else False,
        })

    return raw_brt, raw_brt_samples, points, se_raw


def resolve_correction_fallbacks(train_no, station, next_station, section_name, mps, correction_pools, distance_km=None):
    candidates = [("exact", (str(train_no), station, next_station))]
    mps_key = float(mps) if mps is not None and pd.notna(mps) else None

    if mps_key is not None:
        candidates.append(("block_mps", (station, next_station, mps_key)))
        if distance_km is not None and pd.notna(distance_km) and section_name not in (None, "-", "") and pd.notna(section_name):
            candidates.append(("distance_mps", (section_name, _distance_band(distance_km), mps_key)))
        candidates.append(("train_mps", (str(train_no), mps_key)))
        candidates.append(("mps", mps_key))

    accel = decel = np.nan
    se_accel = se_decel = np.nan
    accel_source = decel_source = "none"

    for pool_name, key in candidates:
        stats = correction_pools.get(pool_name, {}).get(key)
        if not stats:
            continue
        if pool_name in ("distance_mps", "train_mps", "mps") and stats.get("block_n", 0) < MIN_BLOCKS_FOR_POOL:
            continue
        if pd.isna(accel) and pd.notna(stats.get("accel")):
            accel, accel_source, se_accel = float(stats["accel"]), pool_name, stats.get("se_accel", np.nan)
        if pd.isna(decel) and pd.notna(stats.get("decel")):
            decel, decel_source, se_decel = float(stats["decel"]), pool_name, stats.get("se_decel", np.nan)
        if pd.notna(accel) and pd.notna(decel):
            break

    return {
        "accel": accel, "decel": decel, "accel_source": accel_source, "decel_source": decel_source,
        "se_accel": se_accel, "se_decel": se_decel,
    }


def decompose_leg_estimate(subset, distance_km=None, mps_kmph=None, accel_fallback=np.nan,
                            decel_fallback=np.nan, accel_fallback_source="none", decel_fallback_source="none",
                            se_accel_fallback=np.nan, se_decel_fallback=np.nan):
    if subset is None or subset.empty:
        return {
            "baseline": np.nan, "accel": np.nan, "decel": np.nan, "dominant": "N/A",
            "low_confidence": True, "samples": 0, "baseline_source": "none",
            "accel_source": "none", "decel_source": "none", "se_accel": np.nan, "se_decel": np.nan,
        }

    working = subset.copy()
    working["combination"] = working["flag_a"].astype(str) + "-" + working["flag_b"].astype(str)
    combo_counts = working["combination"].value_counts()
    dominant = combo_counts.idxmax() if not combo_counts.empty else "N/A"

    fit = fit_accel_decel(
        working["flag_a"].astype(str) == "D", working["flag_b"].astype(str) == "A", working["Travel_Time"],
    )

    if pd.notna(distance_km) and pd.notna(mps_kmph) and float(mps_kmph) > 0:
        baseline, baseline_source = (float(distance_km) / float(mps_kmph)) * 60.0, "physics_formula"
    elif fit is not None:
        baseline, baseline_source = fit["baseline"], "regression"
    else:
        baseline, baseline_source = np.nan, "none"

    if fit is not None:
        accel, accel_source, se_accel = fit["accel"], "local", fit["se_accel"]
        decel, decel_source, se_decel = fit["decel"], "local", fit["se_decel"]
    else:
        accel, accel_source, se_accel = accel_fallback, accel_fallback_source, se_accel_fallback
        decel, decel_source, se_decel = decel_fallback, decel_fallback_source, se_decel_fallback

    low_confidence = False
    if dominant in ("D-T", "D-A") and pd.isna(accel):
        low_confidence = True
    if dominant in ("T-A", "D-A") and pd.isna(decel):
        low_confidence = True

    return {
        "baseline": baseline, "accel": accel, "decel": decel, "dominant": dominant,
        "low_confidence": low_confidence, "samples": len(working),
        "baseline_source": baseline_source, "accel_source": accel_source, "decel_source": decel_source,
        "se_accel": se_accel, "se_decel": se_decel,
    }


def get_common_yrange(subset, pad_frac=0.08):
    vals = subset["Travel_Time"].dropna()
    if vals.empty:
        return (0, 1)
    lo, hi = vals.quantile(0.01), vals.quantile(0.99)
    if lo == hi:
        lo, hi = vals.min(), vals.max()
    if lo == hi:
        lo, hi = lo - 1, hi + 1
    pad = (hi - lo) * pad_frac
    return (max(0, lo - pad), hi + pad)

def compute_global_chart_bounds(journey_df, pad_frac=0.08):
    """Global X (date) and Y (minutes) domain across the ENTIRE journey dataset,
    so every leg/route chart uses the same fixed axis scale instead of one
    computed per-subset."""
    if journey_df.empty:
        return {"x": [None, None], "y": [0, 1]}

    y_vals = journey_df["Travel_Time"].dropna()
    if y_vals.empty:
        y_domain = [0, 1]
    else:
        lo, hi = y_vals.quantile(0.01), y_vals.quantile(0.99)
        if lo == hi:
            lo, hi = y_vals.min(), y_vals.max()
        if lo == hi:
            lo, hi = lo - 1, hi + 1
        pad = (hi - lo) * pad_frac
        y_domain = [max(0.0, float(lo - pad)), float(hi + pad)]

    x_vals = journey_df["train_date"].dropna()
    if x_vals.empty:
        x_domain = [None, None]
    else:
        x_domain = [
            int(x_vals.min().timestamp() * 1000),
            int(x_vals.max().timestamp() * 1000),
        ]

    return {"x": x_domain, "y": y_domain}
def _safe(v):
    if v is None:
        return None
    if isinstance(v, (np.floating, float)) and pd.isna(v):
        return None
    if isinstance(v, np.bool_):
        return bool(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return float(v)
    return v


def sanitize_json(obj):
    if isinstance(obj, dict):
        return {k: sanitize_json(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [sanitize_json(v) for v in obj]
    if isinstance(obj, np.bool_):
        return bool(obj)
    if isinstance(obj, (np.floating, float)):
        return None if not np.isfinite(obj) else float(obj)
    if isinstance(obj, np.integer):
        return int(obj)
    if pd.isna(obj):
        return None
    if isinstance(obj, (pd.Timestamp,)):
        return obj.isoformat()
    from datetime import datetime, date, timedelta
    if isinstance(obj, (datetime, date, timedelta)):
        return str(obj)
    return obj


def build_route_legs(train_no, master_df, journey_index, section_map, correction_pools):
    train_no = str(int(train_no))
    route_master = master_df[master_df["TRAINNUMBER"] == train_no].sort_values("SEQNUMBER")
    if route_master.empty:
        return None, f"Train {train_no} not found in master data."

    legs = [
        (a, b, rt, dist, mps)
        for a, b, rt, dist, mps in zip(
            route_master["STTNCODE"], route_master["NEXT_STATION"], route_master["MANRUNTIME"],
            route_master["MANINTRDIST"], route_master["MPS"],
        )
        if pd.notna(b)
    ]
    if not legs:
        return None, f"No valid route legs found for train {train_no}."

    leg_rows = []
    for station, next_station, existing_runtime_sec, distance_km, mps_kmph in legs:
        subset = get_leg_subset(station, next_station, [train_no], journey_index)
        existing_runtime = existing_runtime_sec / 60.0 if pd.notna(existing_runtime_sec) else np.nan

        fallback = resolve_correction_fallbacks(
            train_no, station, next_station, section_map.get(f"{station}-{next_station}", "-"),
            mps_kmph, correction_pools, distance_km,
        )

        if subset.empty:
            leg_rows.append({
                "station": station, "next_station": next_station, "flag": "N/A", "dominant": "N/A",
                "existing_runtime": _safe(round(existing_runtime, 2)) if pd.notna(existing_runtime) else None,
                "samples": 0, "raw_brt": None, "rounded_estimate": None, "confidence": 0.0,
                "accel": None, "decel": None, "accel_mean": None, "decel_mean": None, "net_brt": None,
            })
            continue

        dominant = get_dominant_combination(subset)
        working = subset.copy()
        working["combination"] = working["flag_a"].astype(str) + "-" + working["flag_b"].astype(str)
        dominant_subset = working[working["combination"] == dominant]
        chart_subset = dominant_subset if len(dominant_subset) >= MIN_LEG_SAMPLES else working

        raw_brt, raw_samples, _points, se_raw = compute_leg_raw_brt(chart_subset)

        decomp = decompose_leg_estimate(
            subset, distance_km=distance_km, mps_kmph=mps_kmph,
            accel_fallback=fallback["accel"], decel_fallback=fallback["decel"],
            accel_fallback_source=fallback["accel_source"], decel_fallback_source=fallback["decel_source"],
            se_accel_fallback=fallback["se_accel"], se_decel_fallback=fallback["se_decel"],
        )

        leg_rows.append({
            "station": station, "next_station": next_station, "flag": dominant, "dominant": dominant,
            "existing_runtime": _safe(round(existing_runtime, 2)) if pd.notna(existing_runtime) else None,
            "samples": raw_samples, "raw_brt": _safe(raw_brt), "_se_raw": se_raw,
            "rounded_estimate": None,
            "low_confidence": bool(decomp["low_confidence"] or raw_samples < MIN_LEG_SAMPLES),
            "confidence": None,
            "accel": _safe(decomp["accel"]) if dominant in ("D-T", "D-A") else None,
            "decel": _safe(decomp["decel"]) if dominant in ("T-A", "D-A") else None,
            "accel_source": decomp["accel_source"] if dominant in ("D-T", "D-A") else None,
            "decel_source": decomp["decel_source"] if dominant in ("T-A", "D-A") else None,
            "_se_accel": decomp["se_accel"], "_se_decel": decomp["se_decel"],
            "accel_mean": None, "decel_mean": None, "net_brt": None,
            "distance_km": _safe(distance_km), "mps": _safe(mps_kmph),
        })

    accel_values = [leg["accel"] for leg in leg_rows if leg.get("accel") is not None and leg["accel"] <= MAX_ACCEL_DECEL_MINUTES]
    decel_values = [leg["decel"] for leg in leg_rows if leg.get("decel") is not None and leg["decel"] <= MAX_ACCEL_DECEL_MINUTES]
    accel_se_values = [leg["_se_accel"] for leg in leg_rows if leg.get("accel") is not None and leg["accel"] <= MAX_ACCEL_DECEL_MINUTES and pd.notna(leg.get("_se_accel"))]
    decel_se_values = [leg["_se_decel"] for leg in leg_rows if leg.get("decel") is not None and leg["decel"] <= MAX_ACCEL_DECEL_MINUTES and pd.notna(leg.get("_se_decel"))]
    accelM = float(np.mean(accel_values)) if accel_values else np.nan
    decelM = float(np.mean(decel_values)) if decel_values else np.nan
    se_accelM = (float(np.std(accel_values, ddof=1) / np.sqrt(len(accel_values))) if len(accel_values) > 1
                 else (accel_se_values[0] if accel_se_values else np.inf))
    se_decelM = (float(np.std(decel_values, ddof=1) / np.sqrt(len(decel_values))) if len(decel_values) > 1
                 else (decel_se_values[0] if decel_se_values else np.inf))
    for leg in leg_rows:
        leg["accel_mean"], leg["decel_mean"] = _safe(accelM), _safe(decelM)
        dominant, raw_brt = leg.get("dominant", "N/A"), leg.get("raw_brt")
        if raw_brt is None:
            continue

        needs_accel, needs_decel = dominant in ("D-T", "D-A"), dominant in ("T-A", "D-A")
        accel_ok = leg["accel"] is not None and pd.notna(leg["accel"]) and leg["accel"] > 0
        decel_ok = leg["decel"] is not None and pd.notna(leg["decel"]) and leg["decel"] > 0
        a_use = (leg["accel"] if accel_ok else accelM) if needs_accel else 0.0
        d_use = (leg["decel"] if decel_ok else decelM) if needs_decel else 0.0
        a_use, d_use = (a_use if pd.notna(a_use) else 0.0), (d_use if pd.notna(d_use) else 0.0)
        se_a = (leg["_se_accel"] if accel_ok else se_accelM) if needs_accel else 0.0
        se_d = (leg["_se_decel"] if decel_ok else se_decelM) if needs_decel else 0.0
        se_a = se_a if pd.notna(se_a) else 0.0
        se_d = se_d if pd.notna(se_d) else 0.0

        leg["_raw_net"] = max(float(raw_brt) - a_use - d_use, 0.0)
        se_raw = leg.get("_se_raw", np.inf)
        leg["_se_net"] = np.sqrt(se_raw ** 2 + se_a ** 2 + se_d ** 2) if np.isfinite(se_raw) else np.inf

        if needs_accel and not accel_ok and pd.isna(accelM):
            leg["low_confidence"] = True
        if needs_decel and not decel_ok and pd.isna(decelM):
            leg["low_confidence"] = True

    for leg in leg_rows:
        raw_net = leg.get("_raw_net")
        if raw_net is None:
            continue
        leg["net_brt"] = _safe(raw_net)
        leg["rounded_estimate"] = _safe(round_to_nearest_15_sec(raw_net))
        leg["confidence"] = round(min(leg.get("samples", 0) / (MIN_LEG_SAMPLES * 2), 1.0), 2)
        for k in ("_raw_net", "_se_net", "_se_raw", "_se_accel", "_se_decel"):
            leg.pop(k, None)

    return leg_rows, None


def get_train_leg_chart_data(station, next_station, train_no, journey_index):
    subset = get_leg_subset(station, next_station, [str(train_no)], journey_index)
    if subset.empty:
        return {"raw": None, "samples": 0, "points": []}

    working = subset.copy()
    working["combination"] = working["flag_a"].astype(str) + "-" + working["flag_b"].astype(str)
    combo_counts = working["combination"].value_counts()
    dominant = combo_counts.idxmax() if not combo_counts.empty else "N/A"
    dominant_subset = working[working["combination"] == dominant]
    chart_subset = dominant_subset if len(dominant_subset) >= MIN_LEG_SAMPLES else working

    raw, samples, points, _se_raw = compute_leg_raw_brt(chart_subset)
    return {"raw": float(raw) if pd.notna(raw) else None, "samples": int(samples), "points": points, "dominant": str(dominant)}


def get_available_sections(master_df, section_map):
    legs = master_df.dropna(subset=["NEXT_STATION"])[["STTNCODE", "NEXT_STATION"]].drop_duplicates()
    legs["block_set"] = legs["STTNCODE"] + "-" + legs["NEXT_STATION"]
    legs["section_name"] = legs["block_set"].map(section_map)
    return sorted(legs.dropna(subset=["section_name"])["section_name"].unique().tolist())


def derive_lower_cluster_from_combo_points(combo_points):
    if not combo_points:
        return None, None

    df = pd.DataFrame(combo_points)
    majority_combo = df["combo"].value_counts().idxmax()
    dom = df[df["combo"] == majority_combo].copy()
    if dom.empty:
        return None, None

    vals = dom["minutes"].to_numpy().reshape(-1, 1)
    k = min(3, dom["minutes"].nunique())
    k = max(k, 1)
    if k == 1:
        labels = np.zeros(len(vals), dtype=int)
    else:
        labels = KMeans(n_clusters=k, random_state=42, n_init=3).fit_predict(vals)

    dom["sub_cluster"] = labels
    sub_means = dom.groupby("sub_cluster")["minutes"].mean()
    lower_sub = sub_means.idxmin()
    lower = dom[dom["sub_cluster"] == lower_sub]
    return lower, majority_combo


def compute_section_leg_chart_data(subset, mad_threshold=MAD_OUTLIER_THRESHOLD, n_clusters=3):
    cols = ["Travel_Time", "train_date", "flag_a", "flag_b", "train"]
    data_df = subset[cols].dropna(subset=["Travel_Time"]).copy()
    n = len(data_df)

    empty = {
        "pooled": {"raw": None, "samples": 0, "points": []},
        "outlier_method": f"MAD (median absolute deviation), {mad_threshold}x threshold, applied to the complete dataset",
        "kept_count": 0, "outlier_count": 0,
        "combo_points": [], "dominant_combo": None,
        "cluster_points": [], "cluster_means": [], "lower_cluster": None,
    }
    if n == 0:
        return empty

    data_df["combination"] = data_df["flag_a"].astype(str) + "-" + data_df["flag_b"].astype(str)
    
    preds = detect_outliers_mad(
        data_df["Travel_Time"].to_numpy(),
        threshold=mad_threshold,
    )
    data_df["is_outlier"] = preds == -1

    pooled_points = [
        {"date": d.isoformat(), "minutes": float(t), "is_outlier": bool(o), "combo": c}
        for t, d, o, c in zip(data_df["Travel_Time"], data_df["train_date"], data_df["is_outlier"], data_df["combination"])
    ]
    raw_mean = robust_mean_1d(data_df["Travel_Time"].to_numpy(), min_samples=MIN_LEG_SAMPLES)

    kept_df = data_df[~data_df["is_outlier"]].copy()
    valid = kept_df[kept_df["combination"].isin(COMBOS)]

    combo_points, combo_counts = [], {}
    for combo, cs in valid.groupby("combination"):
        if len(cs) < MIN_COMBO_SAMPLES:
            continue
        combo_counts[combo] = len(cs)
        for m, d, tr in zip(cs["Travel_Time"], cs["train_date"], cs["train"]):
            combo_points.append({"combo": combo, "minutes": float(m), "date": d.isoformat(), "train": str(tr)})

    dominant_combo = max(combo_counts, key=combo_counts.get) if combo_counts else None
    cluster_points, cluster_means, lower_cluster = [], [], None
    if dominant_combo is not None:
        dom_df = valid[valid["combination"] == dominant_combo]
        vals = dom_df["Travel_Time"].to_numpy().reshape(-1, 1)
        k = max(min(n_clusters, dom_df["Travel_Time"].nunique()), 1)
        labels = (np.zeros(len(vals), dtype=int) if k == 1
                  else KMeans(n_clusters=k, random_state=42, n_init=3).fit_predict(vals))

        for (m, d, tr), c in zip(zip(dom_df["Travel_Time"], dom_df["train_date"], dom_df["train"]), labels):
            cluster_points.append({"minutes": float(m), "date": d.isoformat(), "train": str(tr), "cluster": int(c)})
        cluster_ids = sorted(set(int(x) for x in labels))
        for c in cluster_ids:
            ys = [p["minutes"] for p in cluster_points if p["cluster"] == c]
            cluster_means.append({"cluster": c, "mean": float(np.mean(ys)), "samples": len(ys)})
        lower_entry = min(cluster_means, key=lambda e: e["mean"]) if cluster_means else None
        if lower_entry is not None:
            lower_cluster = lower_entry["cluster"]
            for p in cluster_points:
                p["is_lower_cluster"] = bool(p["cluster"] == lower_cluster)

    return {
        "pooled": {"raw": _safe(raw_mean), "samples": n, "points": pooled_points},
        "outlier_method": f"MAD (median absolute deviation), {mad_threshold}x threshold, applied to the complete dataset",
        "kept_count": int((~data_df["is_outlier"]).sum()),
        "outlier_count": int(data_df["is_outlier"].sum()),
        "combo_points": combo_points,
        "dominant_combo": dominant_combo,
        "cluster_points": cluster_points,
        "cluster_means": cluster_means,
        "lower_cluster": lower_cluster,
    }


def compute_dominant_cluster_raw_brt(subset):
    combo_points = []
    if subset.empty:
        pass
    else:
        t_subset = subset.copy()
        t_subset["combination"] = t_subset["flag_a"].astype(str) + "-" + t_subset["flag_b"].astype(str)
        valid = t_subset[t_subset["combination"].isin(COMBOS)]
        for (train_no, combo), cs in valid.groupby(["train", "combination"]):
            if len(cs) < MIN_COMBO_SAMPLES:
                continue
            for m, d in zip(cs["Travel_Time"], cs["train_date"]):
                combo_points.append({"combo": combo, "minutes": float(m), "date": d})

    lower, dominant = derive_lower_cluster_from_combo_points(combo_points)
    if lower is None or lower.empty:
        return np.nan, 0, "N/A", np.nan

    vals = lower["minutes"].to_numpy()
    raw = float(np.mean(vals))
    se_raw = float(np.std(vals, ddof=1) / np.sqrt(len(vals))) if len(vals) > 1 else np.inf
    return raw, int(len(lower)), dominant, se_raw


def compute_leg_speed_class_metrics(station, next_station, trains, existing_runtime, distance_km,
                                     mps_kmph, section_name, journey_index, correction_pools):
    subset = get_leg_subset(station, next_station, trains, journey_index)
    if subset.empty:
        return {
            "existing": _safe(existing_runtime), "raw": None, "raw_samples": 0, "accel": None, "decel": None,
            "net_brt": None, "round_ad": None, "accel_mean": None, "decel_mean": None,
            "low_confidence": True, "confidence": 0.0, "dominant": "N/A", "n_trains": 0, "n_samples": 0,
            "trains": [str(t) for t in trains],
        }

    fallback = resolve_correction_fallbacks(
        trains[0] if len(trains) == 1 else "__POOLED__", station, next_station,
        section_name, mps_kmph, correction_pools, distance_km,
    )
    result = decompose_leg_estimate(
        subset, distance_km=distance_km, mps_kmph=mps_kmph,
        accel_fallback=fallback["accel"], decel_fallback=fallback["decel"],
        accel_fallback_source=fallback["accel_source"], decel_fallback_source=fallback["decel_source"],
        se_accel_fallback=fallback["se_accel"], se_decel_fallback=fallback["se_decel"],
    )
    raw_mean, raw_samples, _dom, se_raw = compute_dominant_cluster_raw_brt(subset)
    dominant = result["dominant"]

    return {
        "existing": _safe(existing_runtime), "raw": _safe(raw_mean), "raw_samples": raw_samples, "_se_raw": se_raw,
        "accel": _safe(result["accel"]) if dominant in ("D-T", "D-A") else None,
        "decel": _safe(result["decel"]) if dominant in ("T-A", "D-A") else None,
        "accel_source": result["accel_source"] if dominant in ("D-T", "D-A") else None,
        "decel_source": result["decel_source"] if dominant in ("T-A", "D-A") else None,
        "_se_accel": result["se_accel"], "_se_decel": result["se_decel"],
        "net_brt": None, "round_ad": None, "accel_mean": None, "decel_mean": None,
        "low_confidence": bool(result["low_confidence"] or raw_samples < MIN_LEG_SAMPLES),
        "confidence": None, "dominant": dominant,
        "n_trains": int(subset["train"].nunique()), "n_samples": int(len(subset)),
        "trains": [str(t) for t in trains],
    }


def _build_one_leg(station, next_station, master_df, section_map, journey_index, correction_pools):
    leg_master = master_df[(master_df["STTNCODE"] == station) & (master_df["NEXT_STATION"] == next_station)].copy()
    block_set = f"{station}-{next_station}"
    section_name = section_map.get(block_set, "-")

    if leg_master.empty:
        return {"station": station, "next_station": next_station, "block_set": block_set,
                "section_name": section_name, "speed_classes": {}, "trains": []}

    speed_classes = {}
    for mps_val, grp in leg_master.groupby("MPS", dropna=True):
        class_trains = grp["TRAINNUMBER"].unique().tolist()
        existing_runtime = (grp["MANRUNTIME"] / 60.0).mean()
        distance_km = grp["MANINTRDIST"].dropna().mean()
        speed_classes[float(mps_val)] = compute_leg_speed_class_metrics(
            station, next_station, class_trains, existing_runtime, distance_km,
            mps_val, section_name, journey_index, correction_pools,
        )

    return {
        "station": station, "next_station": next_station, "block_set": block_set,
        "section_name": section_name, "speed_classes": speed_classes,
        "trains": leg_master["TRAINNUMBER"].unique().tolist(),
    }


def build_section_legs(section_name, master_df, section_map, journey_index, correction_pools):
    legs = master_df.dropna(subset=["NEXT_STATION"])[["STTNCODE", "NEXT_STATION", "SEQNUMBER"]].copy()
    legs["block_set"] = legs["STTNCODE"] + "-" + legs["NEXT_STATION"]
    legs["section_name"] = legs["block_set"].map(section_map)
    sec_legs = legs[legs["section_name"] == section_name]

    order = (
        sec_legs.groupby(["STTNCODE", "NEXT_STATION"])["SEQNUMBER"]
        .min().reset_index().sort_values("SEQNUMBER")
    )

    leg_rows = [
        _build_one_leg(row["STTNCODE"], row["NEXT_STATION"], master_df, section_map, journey_index, correction_pools)
        for _, row in order.iterrows()
    ]

    all_mps = sorted({mps for leg in leg_rows for mps in leg["speed_classes"].keys()})

    for mps in all_mps:
        accel_values, decel_values, accel_se_values, decel_se_values = [], [], [], []
        for leg in leg_rows:
            metrics = leg["speed_classes"].get(mps)
            if metrics is None:
                continue
            if metrics.get("accel") is not None and metrics["accel"] <= MAX_ACCEL_DECEL_MINUTES:
                accel_values.append(metrics["accel"])
                if pd.notna(metrics.get("_se_accel")):
                    accel_se_values.append(metrics["_se_accel"])
            if metrics.get("decel") is not None and metrics["decel"] <= MAX_ACCEL_DECEL_MINUTES:
                decel_values.append(metrics["decel"])
                if pd.notna(metrics.get("_se_decel")):
                    decel_se_values.append(metrics["_se_decel"])

        accelM = float(np.mean(accel_values)) if accel_values else np.nan
        decelM = float(np.mean(decel_values)) if decel_values else np.nan
        se_accelM = (float(np.std(accel_values, ddof=1) / np.sqrt(len(accel_values))) if len(accel_values) > 1
                     else (accel_se_values[0] if accel_se_values else np.inf))
        se_decelM = (float(np.std(decel_values, ddof=1) / np.sqrt(len(decel_values))) if len(decel_values) > 1
                     else (decel_se_values[0] if decel_se_values else np.inf))

        this_class_metrics = []
        for leg in leg_rows:
            metrics = leg["speed_classes"].get(mps)
            if metrics is None:
                continue
            metrics["accel_mean"], metrics["decel_mean"] = _safe(accelM), _safe(decelM)
            dominant, raw = metrics.get("dominant", "N/A"), metrics.get("raw")
            if raw is None:
                continue

            needs_accel, needs_decel = dominant in ("D-T", "D-A"), dominant in ("T-A", "D-A")
            accel_ok = metrics["accel"] is not None and pd.notna(metrics["accel"]) and metrics["accel"] > 0
            decel_ok = metrics["decel"] is not None and pd.notna(metrics["decel"]) and metrics["decel"] > 0
            a_use = (metrics["accel"] if accel_ok else accelM) if needs_accel else 0.0
            d_use = (metrics["decel"] if decel_ok else decelM) if needs_decel else 0.0
            a_use, d_use = (a_use if pd.notna(a_use) else 0.0), (d_use if pd.notna(d_use) else 0.0)
            se_a = (metrics["_se_accel"] if accel_ok else se_accelM) if needs_accel else 0.0
            se_d = (metrics["_se_decel"] if decel_ok else se_decelM) if needs_decel else 0.0
            se_a = se_a if pd.notna(se_a) else 0.0
            se_d = se_d if pd.notna(se_d) else 0.0

            metrics["_raw_net"] = max(float(raw) - a_use - d_use, 0.0)
            se_raw = metrics.get("_se_raw", np.inf)
            metrics["_se_net"] = np.sqrt(se_raw ** 2 + se_a ** 2 + se_d ** 2) if np.isfinite(se_raw) else np.inf

            if needs_accel and not accel_ok and pd.isna(accelM):
                metrics["low_confidence"] = True
            if needs_decel and not decel_ok and pd.isna(decelM):
                metrics["low_confidence"] = True
            this_class_metrics.append(metrics)

        for metrics in this_class_metrics:
            raw_net = metrics.get("_raw_net")
            if raw_net is None:
                continue
            metrics["net_brt"] = _safe(raw_net)
            metrics["round_ad"] = _safe(round_to_nearest_15_sec(raw_net))
            metrics["confidence"] = round(min(metrics.get("n_samples", 0) / (MIN_LEG_SAMPLES * 2), 1.0), 2)
            for k in ("_raw_net", "_se_net", "_se_raw", "_se_accel", "_se_decel"):
                metrics.pop(k, None)

    return leg_rows


def section_trains_summary(section_name, master_df, section_map):
    legs = master_df.dropna(subset=["NEXT_STATION"])[["STTNCODE", "NEXT_STATION", "TRAINNUMBER", "MPS"]].copy()
    legs["block_set"] = legs["STTNCODE"] + "-" + legs["NEXT_STATION"]
    legs["section_name"] = legs["block_set"].map(section_map)
    sec = legs[legs["section_name"] == section_name][["TRAINNUMBER", "MPS"]].drop_duplicates()
    sec = sec.sort_values(["MPS", "TRAINNUMBER"], na_position="last")
    return [
        {"train": r.TRAINNUMBER, "mps": _safe(r.MPS)}
        for r in sec.itertuples()
    ]


def compute_section_totals(leg_rows):
    speed_classes = sorted({mps for leg in leg_rows for mps in leg["speed_classes"].keys()})
    fields = ["existing", "raw", "accel", "decel", "accel_mean", "decel_mean", "net_brt", "round_ad"]
    totals = {mps: {f: 0.0 for f in fields} for mps in speed_classes}
    counts = {mps: {f: 0 for f in fields} for mps in speed_classes}

    for leg in leg_rows:
        for mps in speed_classes:
            metrics = leg["speed_classes"].get(mps)
            if metrics is None:
                continue
            skip_low_sample = metrics["n_samples"] < MIN_LEG_SAMPLES
            for field in fields:
                val = metrics.get(field)
                if field in ("round_ad", "existing", "net_brt") and skip_low_sample:
                    continue
                if val is not None and pd.notna(val):
                    totals[mps][field] += val
                    counts[mps][field] += 1

    variance_pct = {}
    for mps in speed_classes:
        existing_total, net_total = totals[mps]["existing"], totals[mps]["net_brt"]
        if counts[mps]["existing"] > 0 and counts[mps]["net_brt"] > 0 and existing_total > 0:
            variance_pct[mps] = (net_total - existing_total) / existing_total * 100.0
        else:
            variance_pct[mps] = None

    return {
        "speed_classes": speed_classes,
        "totals": {str(k): v for k, v in totals.items()},
        "counts": {str(k): v for k, v in counts.items()},
        "variance_pct": {str(k): _safe(v) for k, v in variance_pct.items()},
    }
