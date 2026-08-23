import json
import os
import uuid
from pathlib import Path
from typing import List, Dict

from fastapi import WebSocket


class FishStorage:
    """
    Keeps track of scanned fish images on disk plus a small JSON index,
    so the aquarium remembers its fish across restarts.
    """

    def __init__(self, storage_dir: str):
        self.storage_dir = Path(storage_dir)
        self.storage_dir.mkdir(parents=True, exist_ok=True)
        self.index_path = self.storage_dir / "index.json"
        self._fish: List[Dict] = []
        self._load()

    def _load(self) -> None:
        if self.index_path.exists():
            try:
                self._fish = json.loads(self.index_path.read_text())
            except json.JSONDecodeError:
                self._fish = []

    def _save(self) -> None:
        self.index_path.write_text(json.dumps(self._fish, ensure_ascii=False, indent=2))

    def add_fish(self, png_bytes: bytes) -> Dict:
        fish_id = uuid.uuid4().hex
        filename = f"{fish_id}.png"
        (self.storage_dir / filename).write_bytes(png_bytes)

        entry = {"id": fish_id, "filename": filename, "url": f"/fish_storage/{filename}"}
        self._fish.append(entry)
        self._save()
        return entry

    def list_fish(self) -> List[Dict]:
        return list(self._fish)

    def remove_fish(self, fish_id: str) -> bool:
        entry = next((f for f in self._fish if f["id"] == fish_id), None)
        if entry is None:
            return False
        path = self.storage_dir / entry["filename"]
        if path.exists():
            os.remove(path)
        self._fish.remove(entry)
        self._save()
        return True


class BackgroundStore:
    """
    Keeps track of the aquarium's background gallery: the built-in reef
    artwork plus any number of custom images the user uploaded, all
    selectable, plus a lighting filter (day/dusk/night) that can be applied
    on top of whichever background is currently active - including custom
    ones. Shared with everyone viewing the tank.
    """

    FILTERS = {"none", "day", "dusk", "night"}

    def __init__(self, storage_dir: str):
        self.storage_dir = Path(storage_dir)
        self.backgrounds_dir = self.storage_dir / "backgrounds"
        self.backgrounds_dir.mkdir(parents=True, exist_ok=True)
        self.state_path = self.storage_dir / "background.json"
        self._state = {
            "base": {"type": "reef"},
            "filter": "none",
            "gallery": [],  # [{"id": ..., "filename": ...}]
        }
        self._load()

    def _load(self) -> None:
        if self.state_path.exists():
            try:
                loaded = json.loads(self.state_path.read_text())
                if isinstance(loaded, dict) and "base" in loaded and "gallery" in loaded:
                    self._state = loaded
            except json.JSONDecodeError:
                pass

    def _save(self) -> None:
        self.state_path.write_text(json.dumps(self._state, ensure_ascii=False, indent=2))

    def _public_state(self) -> Dict:
        state = json.loads(json.dumps(self._state))  # deep copy
        if state["base"].get("type") == "custom":
            state["base"]["url"] = f"/fish_storage/backgrounds/{state['base']['filename']}"
        state["gallery"] = [
            {"id": g["id"], "url": f"/fish_storage/backgrounds/{g['filename']}"}
            for g in state["gallery"]
        ]
        return state

    def get(self) -> Dict:
        return self._public_state()

    def add_custom(self, image_bytes: bytes) -> Dict:
        bg_id = uuid.uuid4().hex
        filename = f"{bg_id}.png"
        (self.backgrounds_dir / filename).write_bytes(image_bytes)
        self._state["gallery"].append({"id": bg_id, "filename": filename})
        self._state["base"] = {"type": "custom", "id": bg_id, "filename": filename}
        self._save()
        return self.get()

    def select_base(self, base_type: str, bg_id: str = None) -> Dict:
        if base_type == "reef":
            self._state["base"] = {"type": "reef"}
        elif base_type == "custom":
            entry = next((g for g in self._state["gallery"] if g["id"] == bg_id), None)
            if entry is None:
                raise ValueError("Фон не найден")
            self._state["base"] = {"type": "custom", "id": entry["id"], "filename": entry["filename"]}
        else:
            raise ValueError(f"Неизвестный тип фона: {base_type}")
        self._save()
        return self.get()

    def set_filter(self, filter_name: str) -> Dict:
        if filter_name not in self.FILTERS:
            raise ValueError(f"Неизвестный фильтр: {filter_name}")
        self._state["filter"] = filter_name
        self._save()
        return self.get()

    def delete_custom(self, bg_id: str) -> Dict:
        entry = next((g for g in self._state["gallery"] if g["id"] == bg_id), None)
        if entry is None:
            raise ValueError("Фон не найден")
        path = self.backgrounds_dir / entry["filename"]
        if path.exists():
            os.remove(path)
        self._state["gallery"].remove(entry)
        if self._state["base"].get("type") == "custom" and self._state["base"].get("id") == bg_id:
            self._state["base"] = {"type": "reef"}
        self._save()
        return self.get()


class ConnectionManager:
    """Broadcasts new-fish events to every connected browser tab."""

    def __init__(self):
        self._connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        self._connections.append(websocket)

    def disconnect(self, websocket: WebSocket) -> None:
        if websocket in self._connections:
            self._connections.remove(websocket)

    async def broadcast(self, message: dict) -> None:
        dead = []
        for connection in self._connections:
            try:
                await connection.send_json(message)
            except Exception:
                dead.append(connection)
        for connection in dead:
            self.disconnect(connection)
