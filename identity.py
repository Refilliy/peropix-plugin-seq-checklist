"""Identify a single character using the generation metadata of an existing image."""
from __future__ import annotations

from collections import Counter
from functools import lru_cache
from pathlib import Path
import re
import unicodedata

import meta  # PeroPix's bundled PNG, WebP, JPEG, and stealth metadata reader.


def _captions(raw: dict, first_slot=False) -> tuple[bool, str]:
    """Return presence of generation metadata and a lone positive character caption."""
    if not isinstance(raw, dict) or not raw or raw.get("_comfyui"):
        return False, ""
    ppx = raw.get("peropix")
    v4 = raw.get("v4_prompt")
    caption = v4.get("caption") if isinstance(v4, dict) else None
    has_metadata = (
        (isinstance(ppx, dict) and bool(ppx)) or (isinstance(caption, dict) and bool(caption))
        or isinstance(raw.get("characterPrompts"), list)
        or isinstance(raw.get("characters"), list)
        or (isinstance(raw.get("prompt"), str) and
            any(k in raw for k in ("seed", "steps", "nai_model", "request_type", "sampler")))
    )
    # V5 uses the same v4_prompt.caption layout as V4. Older PeroPix versions
    # also wrote character_prompts or the internal characters representation.
    sources = (
        (ppx.get("character_prompts") if isinstance(ppx, dict) else None, "prompt"),
        (caption.get("char_captions") if isinstance(caption, dict) else None, "char_caption"),
        (raw.get("characterPrompts"), "prompt"),
        (raw.get("characters"), "prompt"),
    )
    for value, field in sources:
        if not isinstance(value, list) or not value:
            continue
        if len(value) != 1 and not first_slot:
            return has_metadata, ""
        text = value[0]
        if isinstance(text, dict):
            text = text.get(field)
        return has_metadata, text if isinstance(text, str) else ""
    return has_metadata, ""


@lru_cache(maxsize=2048)
def _image_caption(path: Path, size: int, mtime_ns: int, first_slot: bool) -> tuple[bool, str]:
    # read_raw tries text and EXIF first. It looks for the alpha signature only
    # when those sources are empty. Cache just the caption, never pixel bytes.
    return _captions(meta.read_raw(path.read_bytes(), stealth=True), first_slot)


_WEIGHT = re.compile(r"(?<![^\s,])[-+]?(?:\d+(?:\.\d+)?|\.\d+)\s*::")


def _tokens(text: str) -> tuple[str, ...]:
    text = _WEIGHT.sub("", unicodedata.normalize("NFKC", text)).replace("::", "")
    text = text.replace("_", " ").casefold()
    return tuple(token for part in re.split(r"[,\n]", text)
                 if (token := " ".join(part.split())))


def _character_tokens(character: dict) -> tuple[str, ...]:
    prompt = character.get("prompt")
    if isinstance(prompt, str):
        return _tokens(prompt)
    words = []
    for block in prompt if isinstance(prompt, list) else []:
        if not isinstance(block, dict) or block.get("on") is False:
            continue
        tags = block.get("tags")
        if isinstance(tags, str):
            words.append(tags)
        elif isinstance(tags, list):
            for tag in tags:
                value = tag.get("t") if isinstance(tag, dict) else tag
                if isinstance(value, str):
                    words.append(value)
    return _tokens(", ".join(words))


def identify(path: Path, characters: list[dict], stamped: str | None = None, *, first_slot=False) -> str | None:
    """Find one current character, or leave the image in chronological order."""
    try:
        path = Path(path)
        stat = path.stat()
        has_metadata, caption = _image_caption(path, stat.st_size, stat.st_mtime_ns, first_slot)
    except (OSError, ValueError):
        return None
    if not has_metadata:
        return None
    cards = [
        c for c in characters
        if isinstance(c, dict) and isinstance(c.get("id"), str) and c["id"]
    ]
    if stamped and any(c["id"] == stamped for c in cards):
        return stamped
    actual = _tokens(caption)
    if not actual:
        return None
    full = Counter(actual)
    signatures = {}
    matches = set()
    for card in cards:
        expected = _character_tokens(card)
        if not expected:
            continue
        signatures[card["id"]] = expected
        # Native scene tags follow the whole character prompt. An unordered
        # match is safe only when the entire caption has the same token counts.
        if (actual[:len(expected)] == expected or
                (len(actual) == len(expected) and Counter(expected) == full)):
            matches.add(card["id"])
    if len(matches) != 1:
        return None
    match = next(iter(matches))
    expected = signatures[match]
    if len(actual) > len(expected):
        # A short generic prefix shared by an entire second candidate (e.g.
        # "1girl") cannot identify an image with additional scene tags.
        signature = Counter(expected)
        if any(signature <= Counter(other) for cid, other in signatures.items() if cid != match):
            return None
    return match
