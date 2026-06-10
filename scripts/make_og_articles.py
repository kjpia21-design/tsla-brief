#!/usr/bin/env python3
"""
TESLA Brief!ng — 기사별 OG 이미지 생성 (1200x630 PNG)
─────────────────────────────────────────────────────
data/cards.json ∪ archive.json ∪ archive-full.json (slug dedup) 의 모든 기사에 대해
assets/og/{slug}.png 생성. 카톡/X 공유 시 기사 헤드라인이 미리보기에 보이게 한다.

- 폰트: assets/fonts/Pretendard-{Bold,Regular}.otf (리포 번들 — CI 한글 안전)
- 증분: 이미 존재하는 PNG 는 건너뜀 (OG_FORCE=1 로 전체 재생성)
- 디자인: 다크 배경 + 카테고리 컬러 스트라이프/라벨 + 헤드라인(최대 2줄)
          + 하단 출처·날짜 + Tesla Brief!ng 워드마크
- build.mjs 가 빌드 시 이 스크립트를 호출하고 assets/ → dist/assets/ 복사로 배포.
"""
import json
import os
import re
import sys
from datetime import datetime, timezone, timedelta

from PIL import Image, ImageDraw, ImageFont, ImageFilter

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.path.join(BASE, "data")
OUT_DIR = os.path.join(BASE, "assets", "og")
FONT_B = os.path.join(BASE, "assets", "fonts", "Pretendard-Bold.otf")
FONT_R = os.path.join(BASE, "assets", "fonts", "Pretendard-Regular.otf")

SCALE = 2
BW, BH = 1200, 630
W, H = BW * SCALE, BH * SCALE
MARGIN = 80 * SCALE

BG = (10, 10, 11)        # #0A0A0B
INK = (244, 244, 245)    # #F4F4F5
SUB = (148, 148, 160)    # #9494A0
RED = (227, 25, 55)      # #E31937 (브랜드)

CAT = {
    "stock":   {"color": (227, 25, 55),   "label": "STOCK · 주가·실적"},
    "product": {"color": (27, 108, 255),  "label": "PRODUCT · 차량·에너지·옵티머스"},
    "fsd":     {"color": (34, 211, 238),  "label": "FSD · 자율·로보택시"},
    "musk":    {"color": (245, 158, 11),  "label": "ELON · 일론 소식"},
}

KST = timezone(timedelta(hours=9))


def F(path, size):
    return ImageFont.truetype(path, int(size * SCALE))


def load_cards():
    seen, items = set(), []
    for name in ("cards.json", "archive.json", "archive-full.json"):
        try:
            with open(os.path.join(DATA, name), encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError):
            continue
        rows = data["items"] if isinstance(data, dict) else data
        for c in rows or []:
            slug = (c or {}).get("slug")
            if not slug or slug in seen:
                continue
            seen.add(slug)
            items.append(c)
    return items


def kst_date(iso):
    try:
        d = datetime.fromisoformat((iso or "").replace("Z", "+00:00")).astimezone(KST)
        return f"{d.year}.{d.month:02d}.{d.day:02d}"
    except ValueError:
        return ""


def wrap2(draw, text, font, maxw):
    """어절 단위 2줄 래핑 — 넘치면 둘째 줄 끝 '…'. (제목은 짧아 대부분 2줄 내)"""
    words = text.split()
    lines, cur = [], ""
    for w in words:
        t = (cur + " " + w).strip()
        if draw.textlength(t, font=font) <= maxw or not cur:
            cur = t
        else:
            lines.append(cur)
            cur = w
            if len(lines) == 2:
                break
    if cur and len(lines) < 2:
        lines.append(cur)
    used = sum(len(l.split()) for l in lines)
    if used < len(words) and lines:
        last = lines[-1]
        while last and draw.textlength(last + "…", font=font) > maxw:
            last = last[:-1].rstrip()
        lines[-1] = last + "…"
    return lines[:2]


def render(card):
    cat = CAT.get(card.get("category"), CAT["stock"])
    img = Image.new("RGB", (W, H), BG)

    # 카테고리색 라디얼 글로우 (우상단, 은은하게)
    mask = Image.new("L", (W, H), 0)
    r = int(W * 0.30)
    ImageDraw.Draw(mask).ellipse([W - r, -r // 2, W + r, r + r // 2], fill=36)
    mask = mask.filter(ImageFilter.GaussianBlur(r * 0.5))
    img = Image.composite(Image.new("RGB", (W, H), cat["color"]), img, mask)

    draw = ImageDraw.Draw(img)

    # 상단 카테고리 스트라이프
    draw.rectangle([0, 0, W, 12 * SCALE], fill=cat["color"])

    # 카테고리 라벨 (도트 + 텍스트, letter-spacing)
    label_font = F(FONT_B, 24)
    lx, ly = MARGIN, 92 * SCALE
    dot = 7 * SCALE
    draw.ellipse([lx, ly - dot, lx + dot * 2, ly + dot], fill=cat["color"])
    tx = lx + dot * 2 + 14 * SCALE
    for ch in cat["label"]:
        draw.text((tx, ly), ch, font=label_font, fill=cat["color"], anchor="lm")
        tx += draw.textlength(ch, font=label_font) + 2 * SCALE

    # 헤드라인 (최대 2줄)
    title = re.sub(r"</?em>", "", card.get("title") or "").strip()
    head_font = F(FONT_B, 64)
    lines = wrap2(draw, title, head_font, W - MARGIN * 2)
    hy = 230 * SCALE
    for line in lines:
        draw.text((MARGIN, hy), line, font=head_font, fill=INK, anchor="lm")
        hy += int(64 * 1.34 * SCALE)

    # 하단 좌: 출처 · 날짜
    meta_font = F(FONT_R, 26)
    src = (card.get("sourceName") or "외신").strip()
    date = kst_date(card.get("pubDate"))
    meta = f"{src} · {date}" if date else src
    draw.text((MARGIN, H - 64 * SCALE), meta, font=meta_font, fill=SUB, anchor="lm")

    # 하단 우: 워드마크 Tesla(빨강) Brief!ng(잉크, ! 빨강)
    logo_font = F(FONT_B, 34)
    parts = [("Tesla ", RED), ("Brief", INK), ("!", RED), ("ng", INK)]
    total = sum(draw.textlength(t, font=logo_font) for t, _ in parts)
    x = W - MARGIN - total
    for t, color in parts:
        draw.text((x, H - 64 * SCALE), t, font=logo_font, fill=color, anchor="lm")
        x += draw.textlength(t, font=logo_font)

    return img.resize((BW, BH), Image.LANCZOS)


def main():
    if not (os.path.exists(FONT_B) and os.path.exists(FONT_R)):
        print(f"[og] 폰트 없음: {FONT_B} — 생성 건너뜀", file=sys.stderr)
        sys.exit(1)
    os.makedirs(OUT_DIR, exist_ok=True)
    force = os.environ.get("OG_FORCE") == "1"
    cards = load_cards()
    made = skipped = 0
    for c in cards:
        out = os.path.join(OUT_DIR, f"{c['slug']}.png")
        if not force and os.path.exists(out):
            skipped += 1
            continue
        render(c).save(out, optimize=True)
        made += 1
    print(f"[og] 기사 OG {made}건 생성 · {skipped}건 캐시 ({len(cards)} total)")


if __name__ == "__main__":
    main()
