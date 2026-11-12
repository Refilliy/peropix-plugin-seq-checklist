(() => {
  "use strict";
  const installed = Symbol.for("peropix.seq-checklist.scene-order");
  // In PeroPix 3.7.12 this private comparator is used only for the scene row,
  // scene focus, and scene keyboard navigation. All three sort before slicing.
  const sceneComparator = "(e,t)=>e.ts===t.ts?e.file<t.file?1:e.file>t.file?-1:0:e.ts<t.ts?1:-1";
  const byGeneration = (a, b) => a.ts < b.ts ? -1 : a.ts > b.ts ? 1 :
    a.file < b.file ? -1 : a.file > b.file ? 1 : 0;

  window.peropix.registerExtension({
    name: "seq-checklist.scene-order",
    setup(api) {
      if (window[installed]) return;
      const base = api.backend.replace(/\/+$/, "");
      const backendOrigin = new URL(base).origin;
      const originalSort = Array.prototype.sort;
      const originalFetch = window.fetch.bind(window);
      let nativeComparator;
      let active;
      let repaintPending = false;

      function scope() {
        const { workspace, tab, sceneGroup: group } = api.state();
        if (!workspace || !tab || !group) return null;
        if (!active || active.workspace !== workspace || active.tab !== tab || active.group !== group) {
          if (active) clearTimeout(active.timer);
          active = { workspace, tab, group, rows: new Map(), rank: new Map(), enabled: false,
            revision: 0, running: false, timer: null, chars: null };
        }
        return active;
      }

      // The native virtual scroller only re-renders when its measured width or
      // scroll offset actually changes. Pulse its width by 1px for one frame;
      // React keeps ownership of the rows, their event handlers and spacers.
      function refreshRows() {
        if (repaintPending) return;
        repaintPending = true;
        requestAnimationFrame(() => {
          const lane = document.querySelector("[data-lane-scroll]");
          if (!lane || lane.clientWidth < 3) { repaintPending = false; return; }
          const prior = lane.style.getPropertyValue("max-width");
          const priority = lane.style.getPropertyPriority("max-width");
          const limit = Math.max(1, Math.floor(lane.getBoundingClientRect().width) - 1) + "px";
          lane.style.setProperty("max-width", limit, "important");
          lane.dispatchEvent(new Event("scroll"));
          requestAnimationFrame(() => {
            if (lane.style.getPropertyValue("max-width") === limit) {
              if (prior) lane.style.setProperty("max-width", prior, priority);
              else lane.style.removeProperty("max-width");
            }
            lane.dispatchEvent(new Event("scroll"));
            repaintPending = false;
          });
        });
      }

      function schedule(view, delay = 30) {
        if (view.timer || view.running) return;
        view.timer = setTimeout(async () => {
          view.timer = null;
          if (scope() !== view) return;
          const revision = view.revision;
          view.running = true;
          try {
            const files = new Set();
            for (const row of view.rows.values()) for (const file of row) files.add(file);
            const result = await originalFetch(base + "/plug/seq-checklist/api/order", {
              method: "POST", headers: {"content-type":"application/json"},
              body: JSON.stringify({workspace:view.workspace, tab:view.tab, group:view.group, files:[...files]})
            });
            if (!result.ok) throw new Error("order " + result.status);
            const {enabled, sceneOrders} = await result.json();
            if (scope() !== view || revision !== view.revision) return;
            const rank = new Map();
            for (const row of Object.values(sceneOrders || {})) {
              if (Array.isArray(row)) row.forEach((file, index) => rank.set(file, index));
            }
            const changed = view.enabled !== !!enabled || rank.size !== view.rank.size ||
              [...rank].some(([file, index]) => view.rank.get(file) !== index);
            view.enabled = !!enabled;
            view.rank = rank;
            if (changed) refreshRows();
          } catch (error) {
            if (view === active && !view.timer) {
              view.timer = setTimeout(() => {
                view.timer = null;
                if (scope() === view) schedule(view);
              }, 10000);
            }
          } finally {
            view.running = false;
            if (view === active && revision !== view.revision) schedule(view);
          }
        }, delay);
      }

      function invalidate(view) {
        if (!view) return;
        clearTimeout(view.timer);
        view.timer = null;
        view.revision++;
        schedule(view);
      }

      Array.prototype.sort = function (compare) {
        if (typeof compare !== "function" || (nativeComparator && compare !== nativeComparator) ||
            !this.length ||
            typeof this[0]?.file !== "string" || typeof this[0]?.ts !== "string") {
          return originalSort.call(this, compare);
        }
        if (compare !== nativeComparator) {
          if (Function.prototype.toString.call(compare) !== sceneComparator) {
            return originalSort.call(this, compare);
          }
          nativeComparator = compare;
        }
        const view = scope();
        if (!view || this.some(record => !record || typeof record.file !== "string" ||
            (record.scene_group_id && record.scene_group_id !== view.group))) {
          return originalSort.call(this, compare);
        }
        const first = this.find(record => record.cell_id) || this[0];
        const rowKey = first.cell_id || first.cell || "";
        const files = new Set(this.filter(record => !record.file.startsWith("preview:")).map(record => record.file));
        const previous = view.rows.get(rowKey);
        if (!previous || previous.size !== files.size || [...files].some(file => !previous.has(file))) {
          view.rows.set(rowKey, files);
          view.revision++;
          schedule(view);
        }
        if (!view.enabled) return originalSort.call(this, compare);
        return originalSort.call(this, (a, b) => {
          const ra = view.rank.get(a.file) ?? Infinity;
          const rb = view.rank.get(b.file) ?? Infinity;
          return ra === rb ? byGeneration(a,b) : ra < rb ? -1 : 1;
        });
      };

      window.addEventListener("message", event => {
        if (event.origin !== backendOrigin || event.data?.type !== "seq-checklist:refresh") return;
        const frames = document.querySelectorAll('iframe[data-plugin-canvas="seq-checklist"]');
        if (Array.from(frames).some(frame => event.source === frame.contentWindow)) invalidate(scope());
      });
      window.addEventListener("seq-checklist:detached-refresh", () => invalidate(scope()));

      // Character order is saved in the normal workspace PUT. Refresh after
      // a successful save so the backend reads the new canonical order.
      window.fetch = function (input, init) {
        const request = originalFetch(input, init);
        if ((init?.method || input?.method || "GET").toUpperCase() !== "PUT" || !active) return request;
        const view = active;
        const url = new URL(input?.url ?? input, location.href);
        if (url.href !== base + "/api/workspaces/" + encodeURIComponent(view.workspace)) return request;
        let signature;
        try {
          const spec = JSON.parse(init.body).spec;
          const tab = spec.tabs.find(tab => tab.id === view.tab);
          const group = spec.sceneGroups?.find(group => group.id === view.group);
          const prompt = tab?.prompt || {};
          // Old files can lack our id stamp. The server matches their saved
          // prompts, so edits to character text must invalidate the result too.
          signature = JSON.stringify([prompt.seqChars === true,
            (prompt.chars || []).map(character => [
              character.id, character.name, character.on,
              (character.prompt || []).map(block => [block.on, block.src,
                (block.tags || []).map(tag => [tag.t, tag.w, tag.g])])
            ]),
            (group?.cards || []).flatMap(card => (card.cells || []).map(cell => [cell.id, cell.name]))
          ]);
        } catch { /* Refresh when a host version sends the save as a Request. */ }
        request.then(response => {
          if (!response.ok || scope() !== view || signature && signature === view.chars) return;
          view.chars = signature;
          invalidate(view);
        }, () => {});
        return request;
      };
      api.addButton("generate.footer", {label:"인물별 정렬", async onClick() {
        const view = scope();
        if (!view) return api.toast("정렬할 씬 그룹을 먼저 열어 주세요.", "warn");
        try {
          const response = await originalFetch(base + "/plug/seq-checklist/api/resort", {
            method:"POST", headers:{"content-type":"application/json"},
            body:JSON.stringify({workspace:view.workspace, tab:view.tab, group:view.group})
          });
          if (!response.ok) throw Error("인물별 정렬 요청에 실패했습니다.");
          invalidate(view);
          api.toast("현재 씬 그룹에 인물별 정렬을 요청했습니다.");
        } catch (error) { api.toast(error.message, "warn"); }
      }});
      window[installed] = true;
      // The first native scene render may predate async extension loading.
      refreshRows();
    }
  });
})();
