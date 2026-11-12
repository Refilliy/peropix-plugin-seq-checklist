(() => {
  "use strict";

  const installed = Symbol.for("peropix.seq-checklist.queue-adapter");
  const validId = value => typeof value === "string" && value.trim().length > 0;
  const isEnhancement = item => item && typeof item === "object" && (
    "enhance_from" in item || "enhance_b64" in item ||
    "enhance_of" in item || "enhance_scale" in item
  );

  function sequentialItem(item) {
    const prompt = item?.env?.prompt;
    if (prompt?.seqChars !== true || item.env.comic || isEnhancement(item)) return false;
    return true;
  }

  function selections(data) {
    if (!Array.isArray(data?.checked)) throw new Error();
    const byCharacter = new Map();
    for (const pair of data.checked) {
      if (!Array.isArray(pair) || pair.length !== 2 || !pair.every(validId)) throw new Error();
      const [character, scene] = pair;
      if (!byCharacter.has(character)) byCharacter.set(character, new Set());
      byCharacter.get(character).add(scene);
    }
    return byCharacter;
  }

  const join = parts => parts.filter(Boolean).reduce((a,b) => a ? a + (/,\s*$/.test(a) ? " " : ", ") + b : b, "");

  function blockText(blocks = []) {
    return join(blocks.filter(block => block.on).map(block => {
      const groups = [];
      for (const tag of block.tags || []) {
        if (!tag.t?.trim()) continue;
        const weight = tag.w == null ? 1 : Math.round(tag.w * 100) / 100;
        const last = groups[groups.length - 1];
        if (tag.g && last && weight !== 1 && last.weight === weight) last.tags.push(tag.t);
        else groups.push({weight, tags: [tag.t]});
      }
      return groups.map(({weight, tags}) => {
        const text = tags.join(", ");
        return weight === 1 ? text : String(weight) + "::" + text + (/[-.\d]$/.test(text) ? " ::" : "::");
      }).join(", ");
    }));
  }

  function wildcardPools(content) {
    const pools = new Map();
    let pool;
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.replace(/(^|\s)\/\/.*$/, "").trim();
      const header = /^#([a-z0-9_]+)$/i.exec(line);
      if (header) {
        const key = header[1].toLowerCase();
        if (!pools.has(key)) pools.set(key, []);
        pool = pools.get(key);
      } else if (line && pool) {
        const value = line.replace(/[\s,]+$/, "");
        if (value) pool.push(value);
      }
    }
    return pools;
  }

  function expand(text, pools, depth = 0) {
    if (!text || depth > 20) return text;
    const draw = list => expand(list[Math.floor(Math.random() * list.length)], pools, depth + 1);
    return text.replace(/(?<![a-z0-9_])#([a-z0-9_]+)/gi, (match, name) => {
      const options = pools.get(name.toLowerCase());
      return options?.length ? draw(options) : match;
    }).replace(/\|\|([\s\S]*?)\|\|/g, (_, options) => draw(options.split("|")))
      .replace(/\{([^{}]*\|[^{}]*)\}/g, (_, options) => draw(options.split("|")));
  }

  function groupedItem(item, primary, fixed, pools, coordinates) {
    const prompt = item.env.prompt;
    const cards = prompt.chars || [];
    const partners = cards.filter(c => fixed.has(c.id));
    const first = cards.find(c => c.id === primary);
    if (!first || partners.length !== fixed.size) throw Error("동반 목록의 캐릭터가 탭에 없습니다. 목록을 갱신해 주세요.");
    const roster = [first, ...partners];
    const main = [prompt.styleOn === false ? "" : blockText(prompt.base)];
    const positives = roster.map(c => [blockText(c.prompt)]);
    const cell = item.env.cell || {};
    for (const [index, line] of [cell, ...(cell.lines || [])].entries()) {
      const value = blockText(line.blocks);
      const dest = line.dest || "base";
      const slot = /^#(\d+)$/.exec(dest);
      if (dest === "all") positives.forEach(parts => parts.push(value));
      else if (slot && positives[Number(slot[1]) - 1]) positives[Number(slot[1]) - 1].push(value);
      else if (dest === "base" || index === 0) main.push(value);
    }
    const characters = roster.map((c, i) => ({
      id:c.id, prompt:expand(join(positives[i]), pools), uc:expand(blockText(c.uc), pools),
      center:c.center, use_coord:coordinates
    }));
    if (characters.some(c => !c.prompt.trim())) throw Error("캐릭터 프롬프트가 비어 있습니다. 주인공과 동반 캐릭터의 태그를 확인해 주세요.");
    return {...item, prompt:expand(join(main), pools), characters,
      env:{...item.env, seqChecklist:{character:primary, companions:partners.map(c => c.id)}}};
  }

  window.peropix.registerExtension({
    name: "seq-checklist.queue",
    setup(api) {
      if (window[installed]) return;
      const previousFetch = window.fetch.bind(window);
      const base = api.backend.replace(/\/+$/, "");
      const queue = new URL(base + "/api/generate/queue");
      const selection = new URL(base + "/plug/seq-checklist/api/selection");
      const notify = (message, kind) => {
        // A UI failure after queue acceptance must never trigger a submission retry.
        try { api.toast(message, kind); } catch {}
      };
      const stop = message => {
        notify(message, "warn");
        throw new Error(message);
      };

      window.fetch = async function (input, init) {
        const method = init?.method ?? input?.method ?? "GET";
        if (method.toUpperCase() !== "POST") return previousFetch(input, init);
        const url = new URL(input?.url ?? input, window.location.href);
        if (url.origin !== queue.origin || url.pathname !== queue.pathname) {
          return previousFetch(input, init);
        }

        // This version of PeroPix sends a JSON string. A Request object may also
        // arrive when another extension wraps fetch; keep its headers and signal.
        let payload;
        if (typeof init?.body === "string") {
          try { payload = JSON.parse(init.body); } catch { return previousFetch(input, init); }
        } else {
          const request = new Request(input, init);
          input = request;
          init = undefined;
          try { payload = await request.clone().json(); } catch { return previousFetch(request); }
        }
        if (!Array.isArray(payload?.items) || !payload.items.some(sequentialItem) ||
            isEnhancement(payload.base)) return previousFetch(input, init);

        const workspace = payload.base?.workspace;
        const group = payload.base?.scene_group_id;
        if (!validId(workspace) || !validId(group)) {
          stop("워크스페이스 또는 씬 그룹을 확인할 수 없어 순차생성을 중단했습니다.");
        }
        const lookup = new URL(selection);
        lookup.searchParams.set("workspace", workspace);
        lookup.searchParams.set("group", group);
        lookup.searchParams.set("model", payload.base.model || "");
        const signal = init?.signal ?? input?.signal;
        let checked, fixed, limit;
        try {
          const response = await previousFetch(lookup.href, { method: "GET", cache: "no-store", signal });
          if (!response.ok) throw new Error();
          const settings = await response.json();
          checked = selections(settings);
          if (!Array.isArray(settings.companions) || !settings.companions.every(validId)) throw new Error();
          fixed = new Set(settings.companions);
          limit = settings.characterLimit;
        } catch (error) {
          if (signal?.aborted) throw error;
          stop("체크 목록을 읽을 수 없어 순차생성을 중단했습니다. 체크리스트를 다시 열어 확인해 주세요.");
        }

        let pools;
        if (fixed.size) {
          if (!Number.isInteger(limit) || fixed.size + 1 > limit) stop("동반 캐릭터를 포함한 인원수가 현재 모델의 캐릭터 한도를 넘습니다.");
        }
        const kept = [];
        let omitted = 0;
        let paired = 0;
        for (const item of payload.items) {
          if (!sequentialItem(item)) {
            kept.push(item);
            continue;
          }
          const character = Array.isArray(item.characters) && item.characters.length === 1
            ? item.characters[0]?.id : null;
          if (!validId(character) || !validId(item.cell_id)) {
            const baseOnly = item.characters?.length === 0 && !item.env.prompt.chars?.some(c => c.on);
            if (fixed.size || (checked.size && !baseOnly)) {
              stop("캐릭터 또는 씬 ID를 확인할 수 없어 체크한 조합을 적용하지 못했습니다. 순차생성을 중단했습니다.");
            }
            kept.push(item);
          } else if (fixed.has(character) || checked.get(character)?.has(item.cell_id)) {
            omitted++;
          } else if (fixed.size) {
            if (!pools) {
              const res = await previousFetch(base + "/api/wildcards", {signal, cache:"no-store"});
              if (!res.ok) stop("캐릭터 프롬프트의 와일드카드 목록을 읽지 못했습니다.");
              pools = wildcardPools((await res.json()).content || "");
            }
            try {
              kept.push(groupedItem(item, character, fixed, pools, !!payload.base.use_coords));
            } catch (error) { stop(error.message); }
            paired++;
          } else {
            kept.push({ ...item, env: { ...item.env, seqChecklist: { character } } });
          }
        }
        // The host interprets an empty list as a request for the base image.
        if (!kept.length) stop("체크한 조합을 제외하면 생성할 이미지가 없습니다.");
        const result = await previousFetch(input, {
          ...init,
          body: JSON.stringify({ ...payload, items: kept })
        });
        if (result.ok && (omitted > 0 || paired > 0)) {
          const rounds = Math.max(1, Number(payload.count) || 1);
          notify(paired ? `동반 캐릭터 ${fixed.size}명과 함께 ${kept.length * rounds}장을 생성 대기열에 추가했습니다.`
            : `생성 대기열에 ${kept.length * rounds}장을 추가했습니다. 체크한 ${omitted * rounds}장은 제외했습니다.`);
        }
        return result;
      };
      window[installed] = true;
    }
  });
})();
