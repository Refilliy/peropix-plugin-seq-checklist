(() => {
  "use strict";
  const id = "seq-checklist";
  window.peropix.registerExtension({
    name: id + ".mini",
    setup(api) {
      let panel, bar, frame, fold;
      let expanded = true, opener;
      const gap = 8;
      function place(x, y) {
        const rect = panel.getBoundingClientRect();
        panel.style.left = Math.max(0, Math.min(x, innerWidth - rect.width - gap)) + "px";
        panel.style.top = Math.max(0, Math.min(y, innerHeight - rect.height - gap)) + "px";
      }
      function clamp() {
        if (!panel.hidden) {
          const {left, top} = panel.getBoundingClientRect();
          place(left, top);
        }
      }
      function close() {
        panel.hidden = true;
        if (opener?.isConnected) opener.focus();
      }
      function expand(on) {
        expanded = on;
        panel.dataset.folded = String(!on);
        fold.textContent = on ? "접기" : "펼치기";
        fold.setAttribute("aria-expanded", String(on));
        clamp();
      }
      function create() {
        panel = document.createElement("section");
        panel.id = "seq-checklist-mini";
        panel.setAttribute("role", "dialog");
        panel.setAttribute("aria-label", "생성 체크리스트");
        const css = document.createElement("style");
        css.textContent = `
          #seq-checklist-mini {position:fixed; z-index:1000; box-sizing:border-box;
            width:min(450px,calc(100vw - 16px)); height:min(352px,calc(100vh - 16px));
            display:flex; flex-direction:column; background:var(--panel); color:var(--ink);
            border:1px solid var(--line); border-radius:8px; box-shadow:0 6px 26px #0004; overflow:hidden}
          #seq-checklist-mini[hidden]{display:none}
          #seq-checklist-mini[data-folded="true"]{height:auto;width:min(230px,calc(100vw - 16px))}
          #seq-checklist-mini[data-folded="true"] iframe{display:none}
          #seq-checklist-mini .mini-bar{display:flex;align-items:center;gap:5px;min-height:34px;
            padding:2px 6px 2px 10px;border-bottom:1px solid var(--line);user-select:none;
            touch-action:none;cursor:move;background:var(--panel)}
          #seq-checklist-mini .mini-bar strong{margin-right:auto;font-size:var(--text-sm)}
          #seq-checklist-mini button{font:inherit;font-size:var(--text-xs);cursor:pointer;padding:3px 6px}
          #seq-checklist-mini iframe{border:0;min-height:0;width:100%;flex:1;color-scheme:inherit}
        `;
        document.head.append(css);
        bar = document.createElement("div");
        bar.className = "mini-bar";
        const title = document.createElement("strong");
        title.textContent = "생성 체크리스트";
        fold = document.createElement("button");
        fold.type = "button";
        fold.onclick = () => expand(!expanded);
        const exit = document.createElement("button");
        exit.type = "button";
        exit.textContent = "닫기";
        exit.onclick = close;
        bar.append(title, fold, exit);
        frame = document.createElement("iframe");
        frame.title = "인물별 씬 체크리스트";
        // The host SDK identifies canvas messages by both iframe identity and plugin ID.
        frame.dataset.pluginCanvas = id;
        frame.src = api.backend.replace(/\/+$/, "") + api.plugin.web + "?view=mini";
        panel.append(bar, frame);
        document.body.append(panel);
        place(innerWidth - panel.offsetWidth - 20, 64);
        let drag;
        bar.onpointerdown = event => {
          if (event.button !== 0 || event.target.closest("button")) return;
          const rect = panel.getBoundingClientRect();
          drag = {id:event.pointerId, dx:event.clientX - rect.left, dy:event.clientY - rect.top};
          bar.setPointerCapture(event.pointerId);
          frame.style.pointerEvents = "none";
          event.preventDefault();
        };
        bar.onpointermove = event => {
          if (drag?.id === event.pointerId) place(event.clientX - drag.dx, event.clientY - drag.dy);
        };
        bar.onlostpointercapture = () => { drag = null; frame.style.pointerEvents = ""; };
        window.addEventListener("resize", clamp);
      }
      function showPanel() {
        opener = document.activeElement;
        if (!panel) create();
        panel.hidden = false;
        expand(true);
        fold.focus({preventScroll:true});
      }
      const label = "float-seq-checklist";
      const origin = new URL(api.backend).origin;
      let popup;
      const native = window.__TAURI_INTERNALS__;
      function windowCommand(name, args = {}) {
        return native.invoke("plugin:window|" + name, {label, ...args});
      }
      async function showWindow() {
        if (popup && !popup.closed) {
          popup.focus();
          if (native) await windowCommand("set_focus").catch(() => {});
          return;
        }
        let child;
        try {
          const x = Math.round(window.screenX + Math.max(0, window.outerWidth - 505));
          const y = Math.round(window.screenY + 60);
          // The desktop host recognizes about:blank#float-* as a native child window.
          child = window.open("about:blank#" + label, label,
            "popup=yes,width=480,height=420,left=" + x + ",top=" + y);
          if (!child) throw Error("새 창이 허용되지 않았습니다.");
          popup = child;
          const doc = child.document;
          doc.title = "생성 체크리스트";
          doc.documentElement.lang = "ko";
          const content = doc.createElement("iframe");
          content.title = doc.title;
          content.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0";
          const url = new URL(api.backend.replace(/\/+$/, "") + api.plugin.web);
          url.searchParams.set("view", "mini");
          url.searchParams.set("window", "detached");
          child.addEventListener("message", async event => {
            if (event.origin !== origin || event.source !== content.contentWindow) return;
            const msg = event.data;
            if (msg?.type === "seq-checklist:refresh") {
              window.dispatchEvent(new Event("seq-checklist:detached-refresh"));
              return;
            }
            if (msg?.type !== "peropix" || !msg.call) return;
            const reply = data => event.source.postMessage({type:"peropix", id:msg.id, ...data}, origin);
            try {
              let result;
              if (msg.call === "state") result = api.state();
              else if (msg.call === "theme") result = api.theme(msg.name);
              else if (msg.call === "action" && msg.name === "set_seq_chars") {
                const {workspace, tab, sceneGroup} = api.state();
                if (msg.args?.workspace !== workspace || msg.args.tab !== tab || msg.args.sceneGroup !== sceneGroup)
                  throw Error("현재 작업 탭이 바뀌었습니다. 다시 선택해 주세요.");
                result = await api.action("set_seq_chars", {workspace, tab, sceneGroup, on:true});
              } else throw Error("지원하지 않는 체크리스트 호출입니다.");
              reply({ok:true, result});
            } catch (error) { reply({ok:false, error:error.message}); }
          });
          content.src = url.href;
          doc.body.replaceChildren(content);
          if (native) {
            let ready = false;
            for (let i = 0; i < 100 && !child.closed; i++) {
              if ((await native.invoke("plugin:window|get_all_windows")).includes(label)) { ready = true; break; }
              await new Promise(resolve => setTimeout(resolve, 20));
            }
            if (!ready) throw Error("PeroPix에서 분리 창을 만들지 못했습니다.");
            try {
              await windowCommand("set_decorations", {value:true});
            } catch {
              const titlebar = doc.createElement("header");
              titlebar.textContent = "생성 체크리스트";
              titlebar.style.cssText = "position:fixed;inset:0 0 auto;height:32px;background:#25252c;color:white;font:14px/32px system-ui;padding:0 10px;cursor:move;user-select:none";
              titlebar.onpointerdown = event => {
                if (event.button === 0 && event.target === titlebar) windowCommand("start_dragging").catch(() => {});
              };
              const closeButton = doc.createElement("button");
              closeButton.textContent = "닫기";
              closeButton.style.float = "right";
              closeButton.onclick = () => windowCommand("close").catch(() => child.close());
              titlebar.append(closeButton);
              doc.body.append(titlebar);
              content.style.top = "32px";
              content.style.height = "calc(100% - 32px)";
            }
            await windowCommand("set_size", {value:{Logical:{width:480,height:420}}});
            await windowCommand("set_title", {value:"생성 체크리스트"}).catch(() => {});
            await windowCommand("show");
            await windowCommand("set_always_on_top", {value:true}).catch(() => {});
            await windowCommand("set_focus");
          }
          child.focus();
          if (panel) panel.hidden = true;
        } catch (error) {
          popup = null;
          if (child && !child.closed) child.close();
          if (native && child) await windowCommand("destroy").catch(() => {});
          showPanel();
          api.toast("독립 창을 열 수 없어 생성 화면 안에 열었습니다. " + error.message, "warn");
        }
      }
      window.addEventListener("pagehide", () => {
        if (popup && !popup.closed) popup.close();
      });
      window.addEventListener("message", event => {
        if (event.origin !== origin || event.data?.type !== "seq-checklist:detach") return;
        const frames = document.querySelectorAll('iframe[data-plugin-canvas="seq-checklist"]');
        if ([...frames].some(f => f.contentWindow === event.source)) showWindow();
      });
      api.addButton("generate.footer", {label:"생성 체크리스트", onClick:showPanel});
      api.addButton("generate.footer", {label:"체크리스트 새 창", onClick:showWindow});
    }
  });
})();
