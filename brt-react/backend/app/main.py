from fastapi import FastAPI, HTTPException, Query, UploadFile, File
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from pydantic import BaseModel
from typing import Optional
import os
import shutil
import pandas as pd
import json

from . import core

app = FastAPI(title="BRT Calculator API")

from fastapi.responses import JSONResponse
from fastapi.requests import Request
import traceback
@app.exception_handler(Exception)
async def global_exception_handler(request: Request, exc: Exception):
    with open("error.log", "a") as f:
        f.write(f"Exception on {request.url}: {exc}\n")
        f.write(traceback.format_exc() + "\n")
    return JSONResponse(status_code=500, content={"message": str(exc)})


app.add_middleware(GZipMiddleware, minimum_size=500)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  
    allow_methods=["*"],
    allow_headers=["*"],
)

import traceback
def get_loaded():
    try:
        return core.load_and_process_data()
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=f"Data file not found: {e}")
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception:
        print(traceback.format_exc())
        raise



@app.post("/api/reload")
def reload_data():
    core.clear_cache()
    removed = core.clear_local_cache_files()
    data = get_loaded()
    return {"reloaded": True, "removed_cache_files": removed, "load_time_sec": data["load_time_sec"]}

@app.post("/api/upload-data")
async def upload_data(
    movement_file: Optional[UploadFile] = File(None),
    master_file: Optional[UploadFile] = File(None),
    route_file: Optional[UploadFile] = File(None),
    schedule_file: Optional[UploadFile] = File(None),
):
    if movement_file is None and master_file is None and route_file is None and schedule_file is None:
        raise HTTPException(status_code=400, detail="Provide at least one file to upload.")

    saved = []
    try:
        if movement_file is not None:
            ext = os.path.splitext(movement_file.filename)[1].lower()
            dest = os.path.join(core.DATA_DIR, core.MOVEMENT_FILE)
            if ext in [".xlsx", ".xls"]:
                df = pd.read_excel(movement_file.file)
                df.to_csv(dest, index=False)
            else:
                with open(dest, "wb") as f:
                    shutil.copyfileobj(movement_file.file, f)
            saved.append(core.MOVEMENT_FILE)
            
        if master_file is not None:
            ext = os.path.splitext(master_file.filename)[1].lower()
            dest = os.path.join(core.DATA_DIR, core.MASTER_FILE)
            if ext == ".csv":
                df = pd.read_csv(master_file.file)
                df.to_excel(dest, index=False, sheet_name="Sheet1")
            else:
                with open(dest, "wb") as f:
                    shutil.copyfileobj(master_file.file, f)
            saved.append(core.MASTER_FILE)
            
        if route_file is not None:
            ext = os.path.splitext(route_file.filename)[1].lower()
            dest = os.path.join(core.DATA_DIR, core.ROUTE_FILE)
            if ext == ".csv":
                df = pd.read_csv(route_file.file)
                df.to_excel(dest, index=False, sheet_name="Sheet1")
            else:
                with open(dest, "wb") as f:
                    shutil.copyfileobj(route_file.file, f)
            saved.append(core.ROUTE_FILE)

        if schedule_file is not None:
            ext = os.path.splitext(schedule_file.filename)[1].lower()
            dest = os.path.join(core.DATA_DIR, core.SCHEDULE_FILE)
            if ext == ".csv":
                df = pd.read_csv(schedule_file.file)
                df.to_excel(dest, index=False, sheet_name="Sheet1")
            else:
                with open(dest, "wb") as f:
                    shutil.copyfileobj(schedule_file.file, f)
            saved.append(core.SCHEDULE_FILE)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save uploaded file(s): {e}")

    core.clear_cache()
    core.clear_local_cache_files()
    data = get_loaded()

    return {
        "uploaded": saved,
        "reloaded": True,
        "load_time_sec": data["load_time_sec"],
        "trains": int(data["master"]["TRAINNUMBER"].dropna().nunique()),
    }

@app.get("/api/trains")
def list_trains():
    data = get_loaded()
    trains = sorted(data["master"]["TRAINNUMBER"].dropna().unique().tolist(), key=lambda x: int(x))
    return {"trains": trains}

@app.get("/api/sections")
def list_sections():
    data = get_loaded()
    sections = core.get_available_sections(data["master"], data["section_map"])
    return {"sections": sections}

@app.get("/api/chart-bounds")
def chart_bounds():
    data = get_loaded()
    return core.sanitize_json(data["chart_bounds"])

from fastapi.responses import FileResponse, Response

@app.get("/api/layout/data")
def layout_data():
    route_file_path = os.path.join(core.DATA_DIR, core.ROUTE_FILE)
    schedule_file_path = os.path.join(core.DATA_DIR, core.SCHEDULE_FILE)
    layout_cache_path = os.path.join(core.DATA_DIR, f"{core.ROUTE_FILE}_layout_cache.json")
    
    if os.path.exists(layout_cache_path) and os.path.exists(route_file_path):
        route_time = os.path.getmtime(route_file_path)
        sched_time = os.path.getmtime(schedule_file_path) if os.path.exists(schedule_file_path) else 0
        cache_time = os.path.getmtime(layout_cache_path)
        if cache_time > route_time and cache_time > sched_time:
            return FileResponse(layout_cache_path, media_type="application/json")

    try:
        route_xl = pd.ExcelFile(route_file_path)
        sched_xl = pd.ExcelFile(schedule_file_path) if os.path.exists(schedule_file_path) else None
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
        
    route_sheets = route_xl.sheet_names
    sched_sheets = sched_xl.sheet_names if sched_xl else []
    has_platform = "Platform" in route_sheets or "Platform" in sched_sheets
    has_platfrom = "Platfrom" in route_sheets or "Platfrom" in sched_sheets
    platform_sheet_name = "Platform" if has_platform else ("Platfrom" if has_platfrom else None)
    
    target_route_sheets = ["RouteInfo", "StationLine", "BlockSctn", "BlockSctnLine", "Connections"]
    if platform_sheet_name:
        target_route_sheets.append(platform_sheet_name)
        
    if "Stations" in route_sheets or "Stations" in sched_sheets:
        target_route_sheets.append("Stations")
    elif "Station" in route_sheets or "Station" in sched_sheets:
        target_route_sheets.append("Station")

    data = {}
    
    for sheet in target_route_sheets:
        if sheet in route_sheets:
            df = pd.read_excel(route_xl, sheet_name=sheet)
        elif sheet in sched_sheets:
            df = pd.read_excel(sched_xl, sheet_name=sheet)
        else:
            df = None

        key = "Platform" if sheet in ["Platform", "Platfrom"] else sheet
        if df is not None:
            df = df.fillna("")
            data[key] = df.to_dict(orient="records")
        else:
            data[key] = []
            
    available = [s if s not in ["Platform", "Platfrom"] else "Platform" for s in target_route_sheets if s in route_sheets or s in sched_sheets]

    if sched_xl and "Schedule" in sched_xl.sheet_names:
        df = pd.read_excel(sched_xl, sheet_name="Schedule")
        df = df.fillna("")
        data["Schedule"] = df.to_dict(orient="records")
        available.append("Schedule")
    else:
        # Fallback to route_xl if it contains Schedule (backwards compat)
        if "Schedule" in route_sheets:
            df = pd.read_excel(route_xl, sheet_name="Schedule")
            df = df.fillna("")
            data["Schedule"] = df.to_dict(orient="records")
            available.append("Schedule")
        else:
            data["Schedule"] = []

    result = {"sheets": data, "available": available}
    result = core.sanitize_json(result)

    json_str = json.dumps(result)
    try:
        with open(layout_cache_path, "w", encoding="utf-8") as f:
            f.write(json_str)
    except Exception:
        pass

    return Response(content=json_str, media_type="application/json")

@app.get("/api/health")
def health():
    """
    Returns a sorted list of all unique train numbers present in the master dataset.
    Used by the Train-Wise BRT tab dropdown.
    """
    data = get_loaded()
    trains = sorted(data["master"]["TRAINNUMBER"].dropna().unique().tolist(), key=lambda x: int(x))
    return {"trains": trains}


@app.get("/api/sections")
def list_sections():
    """
    Returns a list of all block sections available in the master dataset.
    Used by the Section-Wise BRT tab dropdown.
    """
    data = get_loaded()
    sections = core.get_available_sections(data["master"], data["section_map"])
    return {"sections": sections}

@app.get("/api/chart-bounds")
def chart_bounds():
    """
    Returns the minimum and maximum graphical bounds for scatter plots.
    """
    data = get_loaded()
    bounds = core.get_chart_bounds(data["master"])
    return bounds

@app.get("/api/train/{train_no}")
def train_wise_brt(train_no: str):
    data = get_loaded()
    leg_rows, error = core.build_route_legs(
        train_no, data["master"], data["journey_index"], data["section_map"], data["correction_pools"],
    )
    if error:
        raise HTTPException(status_code=404, detail=error)

    usable = [
        leg for leg in leg_rows
        if leg.get("existing_runtime") is not None
        and leg.get("net_brt") is not None
        and leg.get("samples", 0) >= core.MIN_LEG_SAMPLES
    ]
    existing_sum = sum(leg["existing_runtime"] for leg in usable)
    rounded_sum = sum(leg["rounded_estimate"] for leg in usable if leg.get("rounded_estimate") is not None)
    net_terms = [leg["net_brt"] for leg in usable if leg.get("net_brt") is not None]
    net_sum = sum(net_terms) if net_terms else None

    variance_pct = None
    if usable and existing_sum > 0 and net_sum is not None:
        variance_pct = (net_sum - existing_sum) / existing_sum * 100.0

    return core.sanitize_json({
        "train": train_no,
        "legs": leg_rows,
        "totals": {
            "existing_sum": existing_sum if usable else None,
            "net_sum": net_sum,
            "rounded_sum": rounded_sum if usable else None,
            "variance_pct": variance_pct,
        },
    })


@app.get("/api/train/{train_no}/leg-chart")
def train_leg_chart(train_no: str, station: str, next_station: str):
    data = get_loaded()
    chart = core.get_train_leg_chart_data(station, next_station, train_no, data["journey_index"])
    return core.sanitize_json(chart)


@app.get("/api/section/{section_name}")
def section_wise_brt(section_name: str):
    try:
        data = get_loaded()
        leg_rows = core.build_section_legs(
            section_name, data["master"], data["section_map"], data["journey_index"], data["correction_pools"],
        )
        if not leg_rows:
            raise HTTPException(status_code=404, detail=f"No block sections found for '{section_name}'.")

        trains_summary = core.section_trains_summary(section_name, data["master"], data["section_map"])
        totals = core.compute_section_totals(leg_rows)

        for leg in leg_rows:
            leg["speed_classes"] = {str(k): v for k, v in leg["speed_classes"].items()}

        return core.sanitize_json({
            "section": section_name,
            "trains_summary": trains_summary,
            "legs": leg_rows,
            "speed_classes": [str(s) for s in totals["speed_classes"]],
            "totals": totals["totals"],
            "counts": totals["counts"],
            "variance_pct": totals["variance_pct"],
        })
    except Exception:
        print(traceback.format_exc())
        raise


@app.get("/api/section-leg-chart")
def section_leg_chart(station: str, next_station: str, trains: str = Query(..., description="comma-separated train numbers")):
    data = get_loaded()
    train_list = trains.split(",")
    subset = core.get_leg_subset(station, next_station, train_list, data["journey_index"])
    result = core.compute_section_leg_chart_data(subset)
    return core.sanitize_json(result)

from .scheduler import find_conflict_free_path

class SimulationRequest(BaseModel):
    source: str
    destination: str
    start_time: int
    sequence: list = []
    
@app.post("/api/simulate-path")
def simulate_path(req: SimulationRequest):
    data = get_loaded()
    
    source = req.source.strip().upper()
    destination = req.destination.strip().upper()
    
    if req.sequence and len(req.sequence) > 0:
        sequence = req.sequence
    else:
        # Fallback to hacky stub if no sequence provided
        try:
            master = data["master"]
            first_train = master['TRAINNUMBER'].dropna().unique()[0]
            train_data = master[master['TRAINNUMBER'] == first_train].sort_values('SEQNUMBER')
            sequence = train_data['STTNCODE'].tolist()
            if source not in sequence:
                sequence.insert(0, source)
            if destination not in sequence:
                sequence.append(destination)
        except Exception:
            sequence = [{"type": "station", "code": source}, {"type": "station", "code": destination}]
        
    result = find_conflict_free_path(source, destination, req.start_time, sequence)
    return core.sanitize_json(result)

