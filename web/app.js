"use strict";

const byId = id => document.getElementById(id);
const mini = new URLSearchParams(location.search).get("view") === "mini";
const detached = new URLSearchParams(location.search).get("window") === "detached";
const restartNotice = "실행 중인 PeroPix 백엔드에 동반 선택 저장 기능이 없습니다. 작업을 저장하고 PeroPix를 완전히 종료한 뒤 다시 열어 주세요.";
document.documentElement.classList.toggle("mini", mini);
let visible = !mini || detached;
const head = byId("head");
const rows = byId("rows");
const matrix = byId("matrix");
const remaining = byId("remaining");
const excluded = byId("excluded");
const markAll = byId("markAll");
const clearAll = byId("clearAll");
const statusLine = byId("status");
const picker = byId("picker");
const takeList = byId("takeList");

let activeScope = null;
let board = null;
let checkboxes = new Map();
let checked = new Set();
let structure = "";
let lastRead = 0;
let loading = false;
let saving = false;
let revision = 0;
let picking = null;

function pairKey(character, scene) {
  return JSON.stringify([character, scene]);
}

function status(text, isError = false) {
  if (statusLine.textContent !== text) statusLine.textContent = text;
  statusLine.dataset.error = String(isError);
}

function notifySceneOrder() {
  if (window.parent !== window) window.parent.postMessage({type: "seq-checklist:refresh"}, "*");
}

function closePicker() {
  picking = null;
  if (picker.open) picker.close();
}

function showNotice(text) {
  const notice = byId("notice");
  notice.textContent = text;
  notice.hidden = !text;
}

function clearBoard(message) {
  closePicker();
  board = null;
  structure = "";
  checkboxes.clear();
  checked.clear();
  head.replaceChildren();
  rows.replaceChildren();
  byId("companions").hidden = true;
  byId("mode").hidden = true;
  byId("resort").hidden = true;
  for (const id of ["summary", "matrix", "actions"]) byId(id).hidden = true;
  byId("scope").textContent = activeScope?.workspace || "";
  showNotice(message);
}

async function request(path, init = {}) {
  const response = await fetch(path, {cache: "no-store", ...init});
  const body = await response.json();
  if (!response.ok || body.ok === false) {
    if (response.status === 404 && /\/api\/(companion|resort)$/.test(path)) throw new Error(restartNotice);
    const detail = typeof body.detail === "string" ? body.detail : body.error;
    throw new Error(detail || ("요청 오류 " + response.status));
  }
  return body;
}

function makeHeading(text, scope) {
  const th = document.createElement("th");
  th.scope = scope;
  th.textContent = text;
  return th;
}

function buildMatrix(data) {
  const focusedKey = document.activeElement?.dataset?.pair;
  const headerRow = document.createElement("tr");
  headerRow.append(makeHeading("캐릭터 / 씬", "col"));
  for (const [index, scene] of data.scenes.entries()) {
    headerRow.append(makeHeading(scene.name || ("씬 " + (index + 1)), "col"));
  }
  const fragment = document.createDocumentFragment();
  checkboxes = new Map();
  for (const [index, character] of data.characters.entries()) {
    if (data.companions?.includes(character.id)) continue;
    const row = document.createElement("tr");
    const name = character.name || ("캐릭터 " + (index + 1));
    const heading = makeHeading("", "row");
    const label = document.createElement("label");
    label.title = name + "의 모든 씬 체크 또는 해제";
    const rowToggle = document.createElement("input");
    rowToggle.type = "checkbox";
    rowToggle.setAttribute("aria-label", label.title);
    rowToggle.addEventListener("change", () => markVisible(rowToggle.checked, character.id));
    label.append(rowToggle, document.createTextNode(name));
    heading.append(label);
    row.append(heading);
    for (const [sceneIndex, scene] of data.scenes.entries()) {
      const key = pairKey(character.id, scene.id);
      const cell = row.insertCell();
      const controls = document.createElement("div");
      controls.className = "cell-controls";
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.pair = key;
      const pairName = name + " · " + (scene.name || ("씬 " + (sceneIndex + 1)));
      input.setAttribute("aria-label", pairName + " 건너뛰기");
      input.addEventListener("change", () => {
        save([{character: character.id, scene: scene.id, checked: input.checked}]);
      });
      label.append(input);
      const choose = document.createElement("button");
      choose.type = "button";
      choose.textContent = "대표";
      choose.setAttribute("aria-label", pairName + " 대표 이미지 선택");
      choose.setAttribute("aria-haspopup", "dialog");
      choose.addEventListener("click", () => openPicker(character.id, scene.id, pairName));
      controls.append(label, choose);
      cell.append(controls);
      checkboxes.set(key, input);
    }
    fragment.append(row);
  }
  head.replaceChildren(headerRow);
  rows.replaceChildren(fragment);
  if (focusedKey) checkboxes.get(focusedKey)?.focus({preventScroll: true});
}

function paintMarks() {
  const locked = saving || board?.enabled === false;
  let marked = 0;
  for (const row of rows.rows) {
    const rowToggle = row.querySelector("th input");
    const cells = row.querySelectorAll("td input[data-pair]");
    let rowCount = 0;
    for (const input of cells) {
      input.checked = checked.has(input.dataset.pair);
      input.disabled = locked;
      if (input.checked) rowCount++;
    }
    rowToggle.checked = cells.length > 0 && rowCount === cells.length;
    rowToggle.indeterminate = rowCount > 0 && rowCount < cells.length;
    rowToggle.disabled = locked || !cells.length;
    marked += rowCount;
  }
  remaining.textContent = "한 바퀴에 남은 조합 " + (checkboxes.size - marked) + "개";
  excluded.textContent = "건너뜀 " + marked + " / 전체 " + checkboxes.size;
  markAll.disabled = locked || marked === checkboxes.size;
  clearAll.disabled = locked || marked === 0;
  byId("resort").disabled = saving;
  byId("mode").disabled = saving;
  byId("autoPick").disabled = locked;
  for (const input of byId("companionChoices").querySelectorAll("input")) input.disabled = locked;
  for (const button of rows.querySelectorAll("button")) button.disabled = locked;
}

function buildCompanions(data) {
  const fixed = new Set(data.companions || []);
  const members = [...(data.allCharacters || data.characters)];
  for (const id of fixed) if (!members.some(c => c.id === id)) members.push({id, name:"삭제된 캐릭터 " + id});
  const names = new Map((data.groups || []).map(g => [g.id, g.name]));
  const groups = new Map();
  for (const card of members) {
    const key = card.group || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(card);
  }
  const choices = byId("companionChoices");
  choices.replaceChildren();
  const add = (parent, label, ids) => {
    const wrap = document.createElement("label");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = ids.every(id => fixed.has(id));
    input.indeterminate = !input.checked && ids.some(id => fixed.has(id));
    input.onchange = () => save([], {characters:ids, enabled:input.checked});
    wrap.append(input, document.createTextNode(label));
    parent.append(wrap);
  };
  for (const [key, cards] of groups) {
    const box = document.createElement("fieldset");
    const title = document.createElement("legend");
    if (key) add(title, (names.get(key) || key) + " 전체 (" + cards.length + "명)", cards.map(c => c.id));
    else title.textContent = "그룹 없음";
    box.append(title);
    cards.forEach(c => add(box, c.name || c.id, [c.id]));
    choices.append(box);
  }
  byId("companionTitle").textContent = "동반 캐릭터 선택 · " + fixed.size + "명";
  byId("companions").hidden = !members.length || !Array.isArray(data.companions);
}

function render(data) {
  board = data;
  if (data.enabled === false && picking) closePicker();
  const scopeLabel = [activeScope.workspace, data.tabName || data.tab, data.groupName || data.group].filter(Boolean);
  byId("scope").textContent = scopeLabel.join(" › ");
  const nextStructure = JSON.stringify([data.characters, data.scenes, data.allCharacters, data.groups, data.companions]);
  if (structure !== nextStructure) {
    structure = nextStructure;
    buildMatrix(data);
    buildCompanions(data);
    if (picking && !checkboxes.has(pairKey(picking.character, picking.scene))) closePicker();
  }
  checked = new Set(data.checked.map(pair => pairKey(pair[0], pair[1])));
  paintMarks();
  const empty = !checkboxes.size;
  byId("resort").hidden = !Array.isArray(data.companions);
  const mode = byId("mode");
  mode.hidden = typeof data.enabled !== "boolean";
  mode.textContent = "체크리스트 " + (data.enabled ? "ON" : "OFF");
  mode.setAttribute("aria-pressed", String(!!data.enabled));
  byId("autoPick").hidden = !data.autoPick || empty;
  for (const id of ["summary", "matrix", "actions"]) byId(id).hidden = empty;
  byId("summary").hidden = empty || data.enabled === false;
  if (data.enabled === false) showNotice("후편집 모드입니다. 모든 탭에서 기본 생성 요청을 사용하며 기존 인물별 정렬은 유지합니다. 버튼을 다시 누르면 기존 체크와 동반 설정을 적용합니다.");
  else if (!Array.isArray(data.companions)) showNotice(restartNotice);
  else if (!data.characters.length) showNotice("탭에서 생성할 캐릭터를 켜면 여기에 표시됩니다.");
  else if (!data.scenes.length) showNotice("씬 그룹에 잠금이 풀린 씬이 생기면 여기에 표시됩니다.");
  else if (!data.seqChars) showNotice("이 탭에서 캐릭터 순차 생성을 켜면 체크한 조합을 건너뜁니다.");
  else showNotice("");
}

async function refresh(force = false) {
  if (saving || loading || document.hidden || !visible) return;
  loading = true;
  const started = revision;
  try {
    if (!window.peropix?.inApp) {
      clearBoard("PeroPix의 플러그인 화면에서 체크리스트를 열어 주세요.");
      return;
    }
    const state = await peropix.state();
    if (revision !== started) return;
    const scope = {workspace: state.workspace, tab: state.tab, group: state.sceneGroup};
    if (!scope.workspace || !scope.tab || !scope.group) {
      activeScope = null;
      clearBoard("체크할 워크스페이스와 씬 그룹을 열어 주세요.");
      status("");
      return;
    }
    const same = activeScope?.workspace === scope.workspace && activeScope.tab === scope.tab && activeScope.group === scope.group;
    if (!same) {
      activeScope = scope;
      clearBoard("조합을 불러오는 중…");
      status("");
    }
    if (!force && same && board && Date.now() - lastRead < 4500) return;
    const data = await request("../api/board?" + new URLSearchParams(scope));
    if (revision !== started) return;
    render(data);
    lastRead = Date.now();
    if (!same || force || statusLine.dataset.error === "true" && !statusLine.dataset.saveError) status("");
  } catch (error) {
    if (revision === started) {
      clearBoard("조합을 불러올 수 없습니다.");
      status(error.message, true);
    }
  } finally {
    loading = false;
  }
}

async function save(changes, companion = null) {
  if (!board || saving || (!changes.length && !companion)) return;
  const scope = {...activeScope};
  saving = true;
  revision++;
  for (const change of changes) {
    const key = pairKey(change.character, change.scene);
    if (change.checked) checked.add(key);
    else checked.delete(key);
  }
  paintMarks();
  status("저장 중…");
  delete statusLine.dataset.saveError;
  try {
    await request(companion ? "../api/companion" : "../api/marks", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...scope, ...(companion || {changes})}),
    });
    if (companion) {
      structure = "";
      if (companion.enabled && !board.seqChars && board.enabled !== false) {
        const result = await peropix.action("set_seq_chars", {on:true, workspace:scope.workspace, tab:scope.tab, sceneGroup:scope.group});
        if (!result?.ok) throw Error("동반 선택은 저장했습니다. 탭에서 캐릭터 순차 생성을 켜 주세요.");
      }
    }
    notifySceneOrder();
    status(companion ? "동반 캐릭터를 저장했습니다." : "체크 상태를 저장했습니다.");
  } catch (error) {
    clearBoard("저장된 체크 상태를 다시 확인하는 중…");
    status("저장 결과를 확인해 주세요. " + error.message, true);
    statusLine.dataset.saveError = "true";
  } finally {
    saving = false;
    lastRead = 0;
    if (board) paintMarks();
    refresh();
  }
}

function markVisible(value, characterId = null) {
  if (!board || saving || board.enabled === false) return;
  const changes = [];
  for (const character of board.characters) {
    if (characterId !== null && character.id !== characterId) continue;
    if (board.companions?.includes(character.id)) continue;
    for (const scene of board.scenes) {
      if (checked.has(pairKey(character.id, scene.id)) !== value) {
        changes.push({character: character.id, scene: scene.id, checked: value});
      }
    }
  }
  save(changes);
}

function thumbnailUrl(workspace, file) {
  const parts = [workspace, ...file.split("/")];
  return "../../../api/thumb/" + parts.map(encodeURIComponent).join("/");
}

function pickerStatus(text, error = false) {
  byId("takeStatus").textContent = text;
  byId("takeStatus").dataset.error = String(error);
}

function pickerButtons() {
  const locked = saving || !picking?.ready;
  byId("unpick").disabled = locked || !picking.fixed;
  byId("usePick").disabled = locked || !picking.selected ||
    (picking.fixed === picking.selected && checked.has(pairKey(picking.character, picking.scene)));
}

function showTakes(target, data) {
  const takes = data.takes;
  target.fixed = data.picks?.[target.character] || "";
  const automatic = takes.find(take => take.character === target.character)?.file;
  target.selected = takes.some(t => t.file === target.fixed) ? target.fixed : (automatic || "");
  target.ready = true;
  const nameOf = new Map(board.characters.map(c => [c.id, c.name]));
  const fragment = document.createDocumentFragment();
  const leading = [target.fixed, automatic].filter(Boolean);
  const rank = file => leading.includes(file) ? leading.indexOf(file) : leading.length;
  for (const take of takes.slice().sort((a, b) => rank(a.file) - rank(b.file))) {
    const label = document.createElement("label");
    label.title = take.file;
    const image = document.createElement("img");
    image.loading = "lazy";
    image.alt = "";
    image.src = thumbnailUrl(target.scope.workspace, take.file);
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = "representative";
    radio.checked = take.file === target.selected;
    radio.addEventListener("change", () => {
      if (picking === target && radio.checked) {
        target.selected = take.file;
        pickerButtons();
      }
    });
    const name = document.createElement("span");
    name.className = "take-file";
    name.textContent = take.file.split("/").pop();
    const note = document.createElement("span");
    note.className = "take-state";
    if (take.file === target.fixed) note.textContent = "고정한 대표";
    else if (take.file === automatic) note.textContent = "자동 후보 · 최신";
    else if (take.character === target.character) note.textContent = "이 캐릭터";
    else note.textContent = nameOf.get(take.character) || (take.character ? "다른 캐릭터" : "캐릭터 미확인");
    label.append(image, radio, name, note);
    fragment.append(label);
  }
  takeList.replaceChildren(fragment);
  pickerStatus(takes.length ? "이 씬에 저장된 이미지 " + takes.length + "장" : "이 씬에 저장된 이미지가 없습니다.");
  pickerButtons();
}

async function openPicker(character, scene, label) {
  if (saving || !board) return;
  const target = {scope: {...activeScope}, character, scene, ready: false, selected: "", fixed: ""};
  picking = target;
  byId("pickerScope").textContent = label;
  takeList.replaceChildren();
  pickerStatus("이미지를 불러오는 중…");
  pickerButtons();
  if (!picker.open) picker.showModal();
  try {
    const qs = new URLSearchParams({...target.scope, scene});
    const data = await request("../api/takes?" + qs);
    if (picking === target) showTakes(target, data);
  } catch (error) {
    if (picking === target) pickerStatus("이미지를 불러올 수 없습니다. " + error.message, true);
  }
}

async function savePick(file) {
  const target = picking;
  if (!target?.ready || saving) return;
  saving = true;
  revision++;
  pickerButtons();
  paintMarks();
  pickerStatus("저장 중…");
  try {
    await request("../api/pick", {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({...target.scope, character: target.character, scene: target.scene, file}),
    });
    if (file) checked.add(pairKey(target.character, target.scene));
    notifySceneOrder();
    closePicker();
    status(file ? "대표 이미지를 고정하고 조합을 체크했습니다." : "이 조합의 대표 이미지를 자동으로 선택합니다.");
  } catch (error) {
    if (picking === target) pickerStatus("대표 이미지를 저장할 수 없습니다. " + error.message, true);
    else status("대표 이미지를 저장할 수 없습니다. " + error.message, true);
  } finally {
    saving = false;
    pickerButtons();
    if (board) paintMarks();
    lastRead = 0;
    refresh();
  }
}

picker.addEventListener("cancel", () => { picking = null; });
byId("closePicker").addEventListener("click", closePicker);
byId("unpick").addEventListener("click", () => savePick(""));
byId("usePick").addEventListener("click", () => {
  if (picking?.selected) savePick(picking.selected);
});
markAll.addEventListener("click", () => markVisible(true));
clearAll.addEventListener("click", () => markVisible(false));
byId("mode").addEventListener("click", async () => {
  if (!board || saving) return;
  saving = true;
  revision++;
  paintMarks();
  try {
    const {enabled} = await request("../api/mode", {method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify({enabled:!board.enabled})});
    render({...board, enabled});
    window.parent.postMessage({type:"seq-checklist:mode-changed"}, "*");
  } catch (error) { status(error.message, true); }
  finally {
    saving = false;
    paintMarks();
    lastRead = 0;
  }
});
byId("autoPick").addEventListener("click", async () => {
  if (!activeScope || saving) return;
  saving = true;
  revision++;
  paintMarks();
  status("씬별로 대표 이미지를 찾는 중…");
  try {
    const result = await request("../api/auto-pick", {method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify(activeScope)});
    notifySceneOrder();
    status(result.assigned ? "대표 " + result.assigned + "장을 지정했습니다." +
      (result.inferred ? " 남은 인물로 배정한 이미지 " + result.inferred + "장." : "") : "새로 지정할 대표 이미지가 없습니다.");
  } catch (error) { status(error.message, true); statusLine.dataset.saveError = "true"; }
  finally {
    saving = false;
    paintMarks();
    lastRead = 0;
    refresh();
  }
});
byId("resort").addEventListener("click", async () => {
  if (!activeScope || saving) return;
  try {
    await request("../api/resort", {method:"POST", headers:{"Content-Type":"application/json"},
      body:JSON.stringify(activeScope)});
    notifySceneOrder();
    status("현재 씬 그룹에 인물별 정렬을 적용했습니다.");
  } catch (error) { status(error.message, true); }
});
byId("refresh").addEventListener("click", () => {
  notifySceneOrder();
  refresh(true);
});
byId("detach").hidden = detached || !window.peropix?.inApp;
byId("detach").onclick = () => {
  window.parent.postMessage({type:"seq-checklist:detach"}, "*");
};
document.addEventListener("visibilitychange", () => refresh(true));
window.addEventListener("message", event => {
  if (event.source === window.parent && event.data?.type === "seq-checklist:reload-mode") refresh(true);
});
window.addEventListener("focus", () => refresh(true));
setInterval(() => refresh(), 1500);
if (mini && !detached) {
  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) refresh(true);
  }).observe(document.documentElement);
}
refresh(true);
