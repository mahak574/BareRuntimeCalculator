import logging

logger = logging.getLogger(__name__)

# --- STUBS FOR CONFLICT RESOLUTION ---
# In a real implementation, these would query the 'existing_schedule'
# and the layout/master data to determine actual conflicts.

def get_station_index(current_station: str, sequence: list) -> int:
    for i, node in enumerate(sequence):
        if isinstance(node, dict) and node.get("type") == "station" and node.get("code") == current_station:
            return i
        elif isinstance(node, str) and node == current_station:
            return i
    return -1

def get_next_station(current_station: str, sequence: list) -> str:
    """Returns the next station in the sequence. Returns None if at the end."""
    idx = get_station_index(current_station, sequence)
    if idx == -1: return None
    for i in range(idx + 1, len(sequence)):
        node = sequence[i]
        if isinstance(node, dict) and node.get("type") == "station":
            return node.get("code")
        elif isinstance(node, str): # fallback
            return node
    return None

def get_previous_station(current_station: str, sequence: list) -> str:
    """Returns the previous station in the sequence. Returns None if at the start."""
    idx = get_station_index(current_station, sequence)
    if idx == -1: return None
    for i in range(idx - 1, -1, -1):
        node = sequence[i]
        if isinstance(node, dict) and node.get("type") == "station":
            return node.get("code")
        elif isinstance(node, str):
            return node
    return None

def get_next_block(current_station: str, next_station: str, sequence: list) -> dict:
    """Identifies the block section node between current_station and next_station."""
    idx1 = get_station_index(current_station, sequence)
    idx2 = get_station_index(next_station, sequence)
    if idx1 != -1 and idx2 != -1 and idx1 < idx2:
        for i in range(idx1 + 1, idx2):
            node = sequence[i]
            if isinstance(node, dict) and node.get("type") == "block":
                return node
    return None

def get_halt_time(station: str) -> int:
    """Returns the halt time at the given station in minutes. Defaulting to 2 mins."""
    return 2

import math

def get_block_capacity(block: dict) -> int:
    """
    Calculates the capacity of a block section for Absolute Signalling.
    number_of_trains = ceil(X / 3.6) where X is distance in km.
    """
    if not block or not isinstance(block, dict):
        return 1
        
    distance_str = block.get("distance", "0")
    try:
        distance = float(distance_str) if distance_str else 0.0
    except ValueError:
        distance = 0.0
        
    if distance <= 0:
        return 1
        
    # Minimum train spacing = 3.6 km
    capacity = math.ceil(distance / 3.6)
    
    return max(1, capacity)

def is_block_conflict(block: dict, departure_time: int, existing_schedule: dict) -> bool:
    """
    Checks if there is a conflict in the block section at the given departure time.
    Stubbed to always return False for now.
    """
    # capacity = get_block_capacity(block)
    # TODO: Implement actual block conflict logic using existing_schedule and capacity
    return False

def is_station_conflict(station: str, arrival_time: int, existing_schedule: dict) -> bool:
    """
    Checks if there is a conflict at the station (e.g. all platforms full) at the given arrival time.
    Stubbed to always return False for now.
    """
    # TODO: Implement actual station conflict logic using existing_schedule
    return False

def is_path_acceptable(departure_time: int, original_start_time: int) -> bool:
    """
    Checks if the path is still acceptable after delaying the departure time.
    For example, if the train is delayed by more than 120 minutes, reject it.
    """
    MAX_DELAY_MINUTES = 120
    if departure_time - original_start_time > MAX_DELAY_MINUTES:
        return False
    return True


def find_conflict_free_path(source: str, destination: str, start_time: int, sequence: list, existing_schedule: dict = None):
    """
    Implementation of the flowchart algorithm to find a conflict-free path.
    """
    if existing_schedule is None:
        existing_schedule = {}

    current_station = source
    current_time = start_time
    path = []
    
    # Track the maximum allowed time for acceptability checks
    original_start_time = start_time
    
    while True:
        next_station = get_next_station(current_station, sequence)
        if not next_station:
            return {"status": "error", "message": "Destination unreachable or sequence invalid"}
            
        next_block = get_next_block(current_station, next_station, sequence)
        
        # Set Departure Time to Current Time Plus Halt
        departure_time = current_time + get_halt_time(current_station)
        
        # Conflict Resolution Loop
        while True:
            # 1. Is Block Conflict?
            if is_block_conflict(next_block, departure_time, existing_schedule):
                departure_time += 1
                if not is_path_acceptable(departure_time, original_start_time):
                    # Backtrack
                    if current_station == source:
                        return {"status": "rejected", "message": "Source reached during backtrack. Path rejected."}
                    current_station = get_previous_station(current_station, sequence)
                    # We would also pop the last path entry here
                    if path:
                        path.pop()
                    break # Break inner loop to re-evaluate from previous station
                continue # Re-evaluate block conflict with new time
            
            # 2. Is Next Station Conflict?
            if is_station_conflict(next_station, departure_time + 10, existing_schedule): # assuming 10 mins runtime
                departure_time += 1
                if not is_path_acceptable(departure_time, original_start_time):
                    # Backtrack
                    if current_station == source:
                        return {"status": "rejected", "message": "Source reached during backtrack. Path rejected."}
                    current_station = get_previous_station(current_station, sequence)
                    if path:
                        path.pop()
                    break # Break inner loop to re-evaluate from previous station
                continue # Re-evaluate block conflict with new time

            # No conflicts, Accept this leg
            # Calculate real travel time based on distance and speed limit
            # Default fallback: 10 mins if distance/speed missing
            runtime = 10 
            if next_block and isinstance(next_block, dict):
                distance_str = next_block.get("distance", "0")
                try:
                    distance = float(distance_str) if distance_str else 0.0
                except ValueError:
                    distance = 0.0
                
                # Try to get MPS (Maximum Permissible Speed) from lines if available, default to 110 kmph
                speed_kmph = 110.0
                lines = next_block.get("lines", [])
                if lines and len(lines) > 0:
                    # Look for a line that has a speed setting, or just use the first line's MPS if available
                    for line in lines:
                        mps = line.get("MANMPSSEC_I")
                        if mps:
                            try:
                                speed_kmph = float(mps)
                                break # Use first valid MPS found
                            except ValueError:
                                pass
                
                if distance > 0 and speed_kmph > 0:
                    # time in minutes = (distance / speed) * 60
                    runtime = int(round((distance / speed_kmph) * 60))
                    # Apply a minimum runtime of 1 minute just to be safe
                    runtime = max(1, runtime)

            arrival_time = departure_time + runtime
            
            path.append({
                "from": current_station,
                "to": next_station,
                "block": next_block.get("code") if next_block else f"{current_station}-{next_station}",
                "departure_time": departure_time,
                "arrival_time": arrival_time,
                "runtime_mins": runtime
            })
            
            current_station = next_station
            current_time = arrival_time
            
            # Destination Reached?
            if current_station == destination:
                return {"status": "accepted", "path": path}
            
            # Not reached, break inner loop to set next block section
            break
