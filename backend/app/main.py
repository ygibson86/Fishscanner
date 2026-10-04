import io
import os
from typing import Optional

import cv2
import numpy as np
from fastapi import FastAPI, UploadFile, File, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from PIL import Image

from pydantic import BaseModel

from .scanner import FishScanner
from .storage import FishStorage, BackgroundStore, ConnectionManager

STORAGE_DIR = os.environ.get("FISH_STORAGE_DIR", "/data/fish_storage")
STATIC_DIR = os.path.join(os.path.dirname(__file__), "..", "static")

app = FastAPI(title="FishScanner Aquarium")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

scanner = FishScanner()
storage = FishStorage(STORAGE_DIR)
background_store = BackgroundStore(STORAGE_DIR)
manager = ConnectionManager()


class BackgroundSelect(BaseModel):
    type: str  # "reef" | "custom"
    id: Optional[str] = None


class FilterSelect(BaseModel):
    filter: str  # "none" | "day" | "dusk" | "night"


app.mount("/assets", StaticFiles(directory=os.path.join(STATIC_DIR, "assets")), name="assets")
app.mount("/icons", StaticFiles(directory=os.path.join(STATIC_DIR, "icons")), name="icons")
app.mount("/fish_storage", StaticFiles(directory=STORAGE_DIR), name="fish_storage")


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/app.js")
async def app_js():
    return FileResponse(os.path.join(STATIC_DIR, "app.js"), media_type="application/javascript")


@app.get("/style.css")
async def style_css():
    return FileResponse(os.path.join(STATIC_DIR, "style.css"), media_type="text/css")


@app.get("/manifest.json")
async def manifest():
    return FileResponse(os.path.join(STATIC_DIR, "manifest.json"), media_type="application/manifest+json")


@app.get("/service-worker.js")
async def service_worker():
    return FileResponse(os.path.join(STATIC_DIR, "service-worker.js"), media_type="application/javascript")


@app.get("/favicon.ico")
async def favicon():
    return FileResponse(os.path.join(STATIC_DIR, "favicon.ico"), media_type="image/x-icon")


@app.get("/api/health")
async def health():
    return {"status": "ok"}


@app.get("/api/fish")
async def list_fish():
    return storage.list_fish()


@app.post("/api/fish")
async def upload_fish(photo: UploadFile = File(...)):
    contents = await photo.read()

    try:
        pil_image = Image.open(io.BytesIO(contents)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Не удалось прочитать изображение")

    frame_rgb = np.array(pil_image)
    frame_bgr = cv2.cvtColor(frame_rgb, cv2.COLOR_RGB2BGR)

    try:
        scanned_rgba = scanner.scan(frame_bgr)
    except Exception as exc:
        raise HTTPException(status_code=422, detail=f"Не удалось распознать рыбку: {exc}")

    # Encode as PNG with transparency
    result_image = Image.fromarray(scanned_rgba, mode="RGBA")
    buffer = io.BytesIO()
    result_image.save(buffer, format="PNG")
    png_bytes = buffer.getvalue()

    entry = storage.add_fish(png_bytes)
    await manager.broadcast({"type": "new_fish", "fish": entry})

    return JSONResponse(entry)


@app.delete("/api/fish/{fish_id}")
async def delete_fish(fish_id: str):
    ok = storage.remove_fish(fish_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Рыбка не найдена")
    await manager.broadcast({"type": "removed_fish", "id": fish_id})
    return {"status": "deleted"}


@app.get("/api/background")
async def get_background():
    return background_store.get()


@app.post("/api/background/custom")
async def upload_background_custom(photo: UploadFile = File(...)):
    contents = await photo.read()
    try:
        pil_image = Image.open(io.BytesIO(contents)).convert("RGB")
    except Exception:
        raise HTTPException(status_code=400, detail="Не удалось прочитать изображение")

    buffer = io.BytesIO()
    pil_image.save(buffer, format="PNG")
    state = background_store.add_custom(buffer.getvalue())
    await manager.broadcast({"type": "background_changed", "background": state})
    return state


@app.post("/api/background/select")
async def select_background(payload: BackgroundSelect):
    try:
        state = background_store.select_base(payload.type, payload.id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    await manager.broadcast({"type": "background_changed", "background": state})
    return state


@app.post("/api/background/filter")
async def select_background_filter(payload: FilterSelect):
    try:
        state = background_store.set_filter(payload.filter)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    await manager.broadcast({"type": "background_changed", "background": state})
    return state


@app.delete("/api/background/custom/{bg_id}")
async def delete_background_custom(bg_id: str):
    try:
        state = background_store.delete_custom(bg_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
    await manager.broadcast({"type": "background_changed", "background": state})
    return state


@app.websocket("/ws/aquarium")
async def aquarium_ws(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        while True:
            # We don't expect messages from the browser, just keep the socket open
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

