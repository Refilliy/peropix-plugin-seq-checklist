"""Character-by-scene selections for PeroPix's sequential generation mode."""
from collections import Counter, defaultdict, deque
from contextlib import closing, contextmanager
from functools import lru_cache
from pathlib import Path
import json
import sqlite3

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, StrictBool
from plugins import host
import recordsdb
import nai
from workspace import RECORDS_NAME

from .identity import identify

router = APIRouter()
DATABASE = Path(__file__).resolve().parent / "_data" / "checklist.sqlite3"
# Temporary across workspaces for this running PeroPix backend.
checklist_enabled = True


class Mode(BaseModel):
    enabled: StrictBool


@router.get("/api/mode")
def mode():
    return {"enabled": checklist_enabled}


@router.post("/api/mode")
def set_mode(body: Mode):
    global checklist_enabled
    checklist_enabled = body.enabled
    return {"enabled": body.enabled}


def require_enabled():
    if not checklist_enabled:
        raise HTTPException(409, "체크리스트가 OFF입니다. ON으로 전환한 뒤 다시 시도해 주세요.")


class Scope(BaseModel):
    workspace: str
    tab: str
    group: str


class Change(BaseModel):
    character: str
    scene: str
    checked: StrictBool


class Marks(Scope):
    changes: list[Change]


class Pick(Scope):
    character: str
    scene: str
    file: str


class Order(Scope):
    files: list[str]


class Companion(Scope):
    characters: list[str]
    enabled: StrictBool


@contextmanager
def write_marks():
    DATABASE.parent.mkdir(exist_ok=True, parents=True)
    with closing(sqlite3.connect(DATABASE, timeout=10)) as conn, conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS marks (
                workspace TEXT NOT NULL, group_id TEXT NOT NULL, person TEXT NOT NULL,
                scene TEXT NOT NULL, take TEXT, PRIMARY KEY(workspace,group_id,person,scene),
                UNIQUE(workspace,group_id,scene,take)
            )
        """)
        conn.execute("""CREATE TABLE IF NOT EXISTS companions (
            workspace TEXT NOT NULL, group_id TEXT NOT NULL, person TEXT NOT NULL,
            PRIMARY KEY(workspace,group_id,person))""")
        conn.execute("""CREATE TABLE IF NOT EXISTS sorted_groups (
            workspace TEXT NOT NULL, group_id TEXT NOT NULL, PRIMARY KEY(workspace,group_id))""")
        yield conn


def read_marks(workspace, group):
    if not DATABASE.is_file():
        return []
    with write_marks() as conn:
        return conn.execute("SELECT person,scene,take FROM marks WHERE workspace=? AND group_id=?",
                            (workspace, group)).fetchall()


def active_marks(workspace, marks):
    # Keep the stored key through trash/undo. File existence can change without an index rewrite.
    if not any(take for _, _, take in marks):
        return marks
    store = host.tools.store
    _, keyed_files = workspace_index(store, workspace)
    active = []
    for person, scene, take in marks:
        if take:
            file = take.removeprefix("file:") if take.startswith("file:") else keyed_files.get(take.removeprefix("key:"))
            path = store.file_path(workspace, file) if file else None
            if not path or not path.is_file():
                continue
        active.append((person, scene, take))
    return active


def context(workspace, tab, group):
    spec = host.tools.store.load(workspace) or {}
    tabs = spec.get("tabs", [])
    groups = spec.get("sceneGroups", [])
    active = next((t for t in tabs if t.get("id") == tab), None)
    lane = next((g for g in groups if g.get("id") == group and g.get("kind") == "sceneGroup"
                 and (g.get("tabId") or spec.get("activeTab")) == tab), None)
    if active is None or lane is None:
        raise HTTPException(409, "탭과 씬 그룹이 저장된 뒤 새로고침해 주세요.")
    return active, lane, groups


def cells(lane, *, unlocked=False):
    cards = lane.get("cards")
    if cards is None:
        cards = [{"cells": lane.get("cells") or []}]
    return [c for card in cards for c in card.get("cells", [])
            if c.get("id") and not (unlocked and (card.get("locked") or c.get("locked")))]


def people(tab, *, enabled=False):
    return [c for c in (tab.get("prompt") or {}).get("chars", [])
            if c.get("id") and (not enabled or c.get("on", True))]


def labels(items):
    return [{"id": c["id"], "name": c.get("name") or ""} for c in items]


def companion_ids(workspace, group):
    fixed = []
    if DATABASE.is_file():
        with write_marks() as conn:
            fixed = [p for (p,) in conn.execute(
                "SELECT person FROM companions WHERE workspace=? AND group_id=?", (workspace, group))]
    return fixed


def manual_sort(workspace, group):
    if not DATABASE.is_file():
        return False
    with write_marks() as conn:
        return bool(conn.execute("SELECT 1 FROM sorted_groups WHERE workspace=? AND group_id=?",
                                 (workspace, group)).fetchone())


@router.get("/api/selection")
def selection(workspace: str, group: str, model: str = ""):
    if not checklist_enabled:
        return {"enabled": False}
    return {"enabled": True, **saved_selection(workspace, group, model)}


def saved_selection(workspace, group, model=""):
    fixed = companion_ids(workspace, group)
    limit = nai.caps(model)["max_characters"] if nai.uses_v4_prompt(model) else 0
    return {"checked": [(p, s) for p, s, _ in active_marks(workspace, read_marks(workspace, group))],
            "companions": fixed, "characterLimit": limit}


@router.post("/api/companion", dependencies=[Depends(require_enabled)])
def companion(body: Companion):
    active, _, _ = context(body.workspace, body.tab, body.group)
    enabled = {c["id"] for c in people(active, enabled=True)}
    with write_marks() as conn:
        scope = (body.workspace, body.group)
        keys = [(*scope, person) for person in set(body.characters)]
        if body.enabled:
            if set(body.characters) - {c["id"] for c in people(active)}:
                raise HTTPException(409, "캐릭터 구성이 바뀌었습니다. 새로고침해 주세요.")
            conn.executemany("INSERT OR IGNORE INTO companions VALUES(?,?,?)", keys)
            fixed = {p for (p,) in conn.execute("SELECT person FROM companions WHERE workspace=? AND group_id=?", scope)}
            if not enabled - fixed:
                raise HTTPException(409, "캐릭터 1로 생성할 인물을 한 명 이상 남겨 주세요.")
        else:
            conn.executemany("DELETE FROM companions WHERE workspace=? AND group_id=? AND person=?", keys)
    return {"ok": True}


@router.get("/api/board")
def board(workspace: str, tab: str, group: str):
    active, lane, _ = context(workspace, tab, group)
    return {"workspace": workspace, "tab": tab, "group": group,
            "tabName": active.get("name"), "groupName": lane.get("name"),
            "seqChars": (active.get("prompt") or {}).get("seqChars") is True,
            "characters": labels(people(active, enabled=True)),
            "allCharacters": [{"id": c["id"], "name": c.get("name") or "", "group": c.get("group")} for c in people(active)],
            "groups": labels((active.get("prompt") or {}).get("charGroups") or []),
            "scenes": labels(cells(lane, unlocked=True)),
            "autoPick": True, "enabled": checklist_enabled, **saved_selection(workspace, group)}


@router.post("/api/marks", dependencies=[Depends(require_enabled)])
def mark(body: Marks):
    active, lane, _ = context(body.workspace, body.tab, body.group)
    chars, scenes = {c["id"] for c in people(active)}, {s["id"] for s in cells(lane)}
    with write_marks() as conn:
        conn.execute("BEGIN IMMEDIATE")
        existing = conn.execute("SELECT person,scene,take FROM marks WHERE workspace=? AND group_id=?",
                                (body.workspace, body.group)).fetchall()
        dormant = {(p, s) for p, s, _ in set(existing) - set(active_marks(body.workspace, existing))}
        for change in body.changes:
            if change.character not in chars or change.scene not in scenes:
                raise HTTPException(409, "인물이나 씬이 바뀌었습니다. 표를 새로고침해 주세요.")
            key = (body.workspace, body.group, change.character, change.scene)
            if change.checked:
                if (change.character, change.scene) in dormant:
                    conn.execute("UPDATE marks SET take=NULL WHERE workspace=? AND group_id=? AND person=? AND scene=?", key)
                conn.execute("INSERT OR IGNORE INTO marks(workspace,group_id,person,scene) VALUES(?,?,?,?)", key)
            else:
                conn.execute("DELETE FROM marks WHERE workspace=? AND group_id=? AND person=? AND scene=?", key)
    return {"ok": True}


@lru_cache(maxsize=3)
def record_index(store, workspace, revision):
    # One index scan per file revision, even when several visible scenes request their order.
    files = {r["file"]: (n, r) for n, r in enumerate(store.records(workspace)) if r.get("file")}
    return files, {r["key"]: file for file, (_, r) in files.items() if r.get("key")}


def workspace_index(store, workspace):
    try:
        stat = (store.dir_of(workspace) / RECORDS_NAME).stat()
    except FileNotFoundError:
        return {}, {}
    return record_index(store, workspace, (stat.st_mtime_ns, stat.st_size))


def scene_records(workspace, lane, groups, files=None, scene=None):
    store = host.tools.store
    index, _ = workspace_index(store, workspace)
    scenes = cells(lane)
    scene_ids = {s["id"] for s in scenes}
    names = Counter(s.get("name") for s in scenes)
    by_name = {s.get("name"): s["id"] for s in scenes if names[s.get("name")] == 1}
    unique_group = sum(g.get("name") == lane.get("name") for g in groups) == 1
    result = []
    for file in (dict.fromkeys(files) if files is not None else index):
        entry = index.get(file)
        if not entry:
            continue
        ordinal, rec = entry
        if rec.get("scene_group_id"):
            if rec["scene_group_id"] != lane["id"]:
                continue
        elif not unique_group or rec.get("scene_group") != lane.get("name"):
            continue
        cell = rec.get("cell_id") or by_name.get(rec.get("cell"))
        if cell not in scene_ids or (scene and scene != cell):
            continue
        path = store.file_path(workspace, file)
        if path and path.is_file():
            result.append({"file": file, "scene": cell, "key": rec.get("key") or "", "source": rec.get("enhance_of"),
                           "ts": rec.get("ts") or "", "ordinal": ordinal, "path": path})
    result.sort(key=lambda r: (r["ts"], r["ordinal"]))
    return result


def take_key(row):
    # PeroPix's record key survives renumbering and renaming of the file.
    return "key:" + row["key"] if row["key"] else "file:" + row["file"]


def characterize(workspace, rows, characters, first_slot, trust_stamp=False):
    # Read just the prompt snapshot fields from the record DB; other fields can contain images.
    database = host.tools.store.dir_of(workspace) / recordsdb.NAME
    by_key = {r["key"]: r for r in rows if r["key"]}
    current_ids = {c["id"] for c in characters}
    if by_key and database.is_file():
        keys = list(by_key)
        with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as conn:
            for start in range(0, len(keys), 250):
                batch = keys[start:start + 250]
                sql = ("SELECT key, json_extract(data,'$.env.seqChecklist.character'), "
                       "CASE WHEN json_extract(data,'$.env.prompt.seqChars')=1 "
                       "AND json_type(data,'$.env.prompt.chars')='array' "
                       "AND json_extract(data,'$.env.seqChecklist.character') IS NULL "
                       "THEN json_extract(data,'$.env.prompt.chars') END "
                       "FROM rec WHERE key IN (" + ",".join("?" for _ in batch) + ")")
                for key, stamped, snapshot in conn.execute(sql, batch):
                    row = by_key[key]
                    if stamped:
                        row["character"] = (stamped if trust_stamp and stamped in current_ids else
                                            identify(row["path"], characters, stamped, first_slot=first_slot))
                    elif isinstance(snapshot, str):
                        # The user may have edited a character's tags since an earlier round.
                        previous = json.loads(snapshot)
                        enabled = [c for c in previous if isinstance(c, dict) and c.get("on", True)]
                        if enabled:
                            matched = identify(row["path"], enabled, first_slot=first_slot)
                            row["character"] = matched if matched in current_ids else None
    for row in rows:
        if "character" not in row:
            row["character"] = identify(row["path"], characters, first_slot=first_slot)


def pinned(rows, marks, scene):
    files = {take_key(row): row["file"] for row in rows}
    return {person: files[key] for person, cell, key in marks if cell == scene and key in files}


def ordered(rows, char_ids, picks):
    """Chosen take, otherwise latest known take per person. Unidentified takes keep time order."""
    reserved = set(picks.values())
    newest = {r["character"]: r["file"] for r in rows if r["character"] and r["file"] not in reserved}
    unknown = deque(r["file"] for r in rows if not r["character"] and r["file"] not in reserved)
    leading = []
    for person in char_ids:
        file = picks.get(person) or newest.get(person)
        if file is None and unknown:
            file = unknown.popleft()
        if file:
            leading.append(file)
    used = set(leading)
    return leading + [r["file"] for r in rows if r["file"] not in used]


def attribute_scene(workspace, lane, groups, rows, chars, marks, *, for_auto_pick=False):
    first_slot = for_auto_pick or manual_sort(workspace, lane["id"]) or bool(companion_ids(workspace, lane["id"]))
    characterize(workspace, rows, chars, first_slot, for_auto_pick)
    by_file = {row["file"]: row for row in rows}
    frontier = {r["source"] for r in rows if r["source"] and not r["character"]}
    seen = set()
    while frontier:
        sources = scene_records(workspace, lane, groups, files=frontier - by_file.keys())
        characterize(workspace, sources, chars, first_slot, for_auto_pick)
        by_file.update((r["file"], r) for r in sources)
        seen.update(frontier)
        frontier = {by_file[f]["source"] for f in frontier if f in by_file and by_file[f]["source"]} - seen
    pinned_keys = {(scene, key): person for person, scene, key in marks if key}
    for row in rows:
        source = row
        visited = {row["file"]}
        while not row["character"] and source["source"] in by_file and source["source"] not in visited:
            source = by_file[source["source"]]
            visited.add(source["file"])
            row["character"] = pinned_keys.get((source["scene"], take_key(source))) or source["character"]


@router.post("/api/resort", dependencies=[Depends(require_enabled)])
def resort(body: Scope):
    context(body.workspace, body.tab, body.group)
    with write_marks() as conn:
        conn.execute("INSERT OR IGNORE INTO sorted_groups VALUES(?,?)", (body.workspace, body.group))
    return {"ok": True}


@router.post("/api/order")
def order(body: Order):
    if not checklist_enabled:
        return {"enabled": False, "sceneOrders": {}}
    active, lane, groups = context(body.workspace, body.tab, body.group)
    if not (active.get("prompt") or {}).get("seqChars") and not manual_sort(body.workspace, body.group):
        return {"enabled": False, "sceneOrders": {}}
    chars = people(active)
    rows = scene_records(body.workspace, lane, groups, files=body.files)
    marks = read_marks(body.workspace, body.group)
    attribute_scene(body.workspace, lane, groups, rows, chars, marks)
    per_scene = defaultdict(list)
    for row in rows:
        per_scene[row["scene"]].append(row)
    fixed = set(companion_ids(body.workspace, body.group))
    char_ids = [c["id"] for c in chars if c["id"] not in fixed]
    return {"enabled": True, "sceneOrders": {
        scene: ordered(images, char_ids, pinned(images, marks, scene)) for scene, images in per_scene.items()
    }}


@router.get("/api/takes")
def takes(workspace: str, tab: str, group: str, scene: str):
    active, lane, groups = context(workspace, tab, group)
    rows = scene_records(workspace, lane, groups, scene=scene)
    attribute_scene(workspace, lane, groups, rows, people(active), read_marks(workspace, group))
    return {"takes": [{"file": r["file"], "character": r["character"]} for r in reversed(rows)],
            "picks": pinned(rows, read_marks(workspace, group), scene)}


@router.post("/api/auto-pick", dependencies=[Depends(require_enabled)])
def auto_pick(body: Scope):
    tab, group, groups = context(body.workspace, body.tab, body.group)
    scope = (body.workspace, body.group)
    chars = people(tab)
    scenes = {c["id"] for c in cells(group, unlocked=True)}
    rows = [r for r in scene_records(body.workspace, group, groups) if r["scene"] in scenes]
    marks = read_marks(*scope)
    attribute_scene(body.workspace, group, groups, rows, chars, marks, for_auto_pick=True)
    per_scene = defaultdict(list)
    for row in rows:
        per_scene[row["scene"]].append(row)
    count = inferred = 0
    with write_marks() as conn:
        conn.execute("BEGIN IMMEDIATE")
        current = conn.execute("SELECT person,scene,take FROM marks WHERE workspace=? AND group_id=?", scope).fetchall()
        if set(current) != set(marks):
            raise HTTPException(409, "대표 선택이 바뀌었습니다. 다시 눌러 주세요.")
        fixed = {p for (p,) in conn.execute("SELECT person FROM companions WHERE workspace=? AND group_id=?", scope)}
        people_ids = {c["id"] for c in people(tab, enabled=True)} - fixed
        checked = {(p, s) for p, s, _ in active_marks(body.workspace, current)}
        for scene, images in per_scene.items():
            picks = pinned(images, current, scene)
            reserved = set(picks.values())
            available = [r for r in images if r["file"] not in reserved]
            missing = people_ids - picks.keys()
            # Images are oldest first, so the most recent match wins.
            choices = {r["character"]: r for r in available if r["character"] in missing}
            remaining = missing - choices.keys()
            unchecked = {p for p in remaining if (p, scene) not in checked}
            last = remaining if len(remaining) == 1 else unchecked
            if len(last) == 1:
                unknown = next((r for r in reversed(available) if not r["character"]), None)
                if unknown:
                    choices[next(iter(last))] = unknown
                    inferred += 1
            for person, row in choices.items():
                conn.execute("""INSERT INTO marks(workspace,group_id,person,scene,take) VALUES(?,?,?,?,?)
                    ON CONFLICT(workspace,group_id,person,scene) DO UPDATE SET take=excluded.take""",
                             (*scope, person, scene, take_key(row)))
            count += len(choices)
    return {"ok": True, "assigned": count, "inferred": inferred}


@router.post("/api/pick", dependencies=[Depends(require_enabled)])
def pick(body: Pick):
    active, lane, groups = context(body.workspace, body.tab, body.group)
    if body.character not in {p["id"] for p in people(active)} or body.scene not in {s["id"] for s in cells(lane)}:
        raise HTTPException(409, "인물 또는 씬이 바뀌었습니다. 표를 새로고침해 주세요.")
    key = (body.workspace, body.group, body.character, body.scene)
    if body.file:
        rows = scene_records(body.workspace, lane, groups, files=[body.file], scene=body.scene)
        if not rows:
            raise HTTPException(409, "이 씬에서 이미지를 찾을 수 없습니다.")
        try:
            with write_marks() as conn:
                conn.execute("""INSERT INTO marks(workspace,group_id,person,scene,take) VALUES(?,?,?,?,?)
                    ON CONFLICT(workspace,group_id,person,scene) DO UPDATE SET take=excluded.take""",
                             (*key, take_key(rows[0])))
        except sqlite3.IntegrityError as exc:
            raise HTTPException(409, "다른 인물의 대표 이미지입니다. 기존 지정을 먼저 풀어 주세요.") from exc
    else:
        with write_marks() as conn:
            conn.execute("UPDATE marks SET take=NULL WHERE workspace=? AND group_id=? AND person=? AND scene=?", key)
    return {"ok": True}
