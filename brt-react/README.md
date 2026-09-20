# 🚆 Bare Runtime (BRT) Calculator

A comprehensive web application designed for advanced railway operations analysis. The BRT Calculator leverages a fast backend built on **Python / FastAPI** combined with a highly dynamic **React** frontend to crunch complex locomotive data, analyze transit delays, and visualize physical station layouts in real-time.

## 🚀 Key Features

The application is structured into distinct modules, separated by intuitive tabs in the UI:

### 1. Train Wise BRT
Deep dive into the operational performance of specific trains. 
- Input a train number to instantly calculate its Bare Runtime across various journey legs.
- Identify historical delays, view net runtime estimates, and compare existing runtimes with algorithmically corrected baselines.
- Explore interactive statistical charts detailing journey efficiency.

### 2. Section Wise BRT
Analyze railway traffic and capacity on a per-section basis.
- Enter a specific block section (e.g., between two major junctions) to see comprehensive traffic data.
- Analyze transit density across different speed classes (e.g., Express, Freight).
- Easily spot operational bottlenecks and calculate expected traversal times across the block.

### 3. Station Layout
A powerful visualization engine that graphically reconstructs the physical railway infrastructure.
- **Dynamic Infrastructure Rendering:** Instantly draws tracks, Up/Down platforms, and inter-station distances using raw Excel master data.
- **Directional Routing:** Select routes (e.g., *Bina to Kota* or *Kota to Bina*) to see perfectly mirrored layout computations.
- **Animated Turnouts:** Visualizes complex sending (blue) and receiving (emerald) turnouts with beautifully animated flow indicators, intelligently binding station lines to their corresponding block section lines.

### 4. Master Data Explorer
A built-in data viewer allowing administrators to inspect the raw `Master.xlsx` dataset (Routes, Layouts, and Connections) natively in the browser without leaving the dashboard.

## 🛠️ Tech Stack

- **Frontend:** React, Vanilla CSS (Glassmorphism + Modern SVG Animations), Vite
- **Backend:** Python, FastAPI, Pandas
- **Data Integration:** Excel (`.xlsx`) via standard `pandas` reading.

## ⚙️ How to Run

1. **Start the Backend:**
   Navigate to the `backend` directory and run the FastAPI server:
   ```bash
   cd backend
   uvicorn app.main:app --reload --port 8000
   ```

2. **Start the Frontend:**
   Navigate to the `frontend` directory and run the Vite development server:
   ```bash
   cd frontend
   npm run dev
   ```

3. Open your browser and navigate to `http://localhost:5173`.
