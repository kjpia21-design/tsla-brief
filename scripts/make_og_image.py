#!/usr/bin/env python3
"""
TESLA Brief!ng — 사이트 OG 이미지 생성 (1200x630, PNG)
─────────────────────────────────────────────────────
assets/og-image.svg 디자인을 PIL 로 렌더(로고는 워드마크 Tesla Brief!ng).
SVG→PNG 변환 도구(rsvg/cairo/inkscape)가 로컬에 없어 네이티브 드로잉으로 대체.
의존성 0 원칙 유지 — Pillow 만 사용.

출력: assets/og-image.png  (2x 슈퍼샘플 후 1200x630 다운스케일 → 또렷)
재생성:  python3 scripts/make_og_image.py
빌드 시 build.mjs 가 assets/ → dist/assets/ 로 복사.
"""
import os
from PIL import Image, ImageDraw, ImageFont, ImageFilter

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # 프로젝트 루트
OUT = os.path.join(BASE_DIR, "assets", "og-image.png")

SCALE = 2
BW, BH = 1200, 630
W, H = BW * SCALE, BH * SCALE

BG   = (10, 10, 11)     # #0A0A0B
RED  = (227, 25, 55)    # #E31937
BLUE = (27, 108, 255)   # #1B6CFF
INK  = (244, 244, 245)  # #F4F4F5
COPY = (212, 212, 220)  # #D4D4DC
SUB  = (148, 148, 160)  # #9494A0
URLC = (184, 184, 192)  # #B8B8C0

ARIAL_B  = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
MENLO    = "/System/Library/Fonts/Menlo.ttc"          # index 1 = Bold
NANUM_EB = os.path.expanduser("~/Library/Fonts/NanumGothic-ExtraBold.ttf")


def F(path, size, index=0):
    return ImageFont.truetype(path, int(size * SCALE), index=index)


def main():
    img = Image.new("RGB", (W, H), BG)

    # ── 배경 라디얼 글로우 (우상단 빨강 / 좌상단 파랑) ──
    def glow(cx, cy, r, color, strength):
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).ellipse([cx - r, cy - r, cx + r, cy + r], fill=strength)
        mask = mask.filter(ImageFilter.GaussianBlur(r * 0.5))
        layer = Image.new("RGB", (W, H), color)
        return Image.composite(layer, img, mask)

    img = glow(W * 0.80, H * -0.02, W * 0.34, RED, 46)
    img = glow(W * 0.10, H * 0.12, W * 0.26, BLUE, 24)

    # ── LIVE 배지 (우상단) — 은은한 글로우 링 + 빨강 점 + 라벨 ──
    cx, cy = int(1130 * SCALE), int(60 * SCALE)
    ring = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(ring).ellipse(
        [cx - int(18 * SCALE), cy - int(18 * SCALE), cx + int(18 * SCALE), cy + int(18 * SCALE)],
        fill=(227, 25, 55, 64),
    )
    img = Image.alpha_composite(img.convert("RGBA"), ring).convert("RGB")
    draw = ImageDraw.Draw(img)
    dot = int(9 * SCALE)
    draw.ellipse([cx - dot, cy - dot, cx + dot, cy + dot], fill=RED)
    live_font = F(MENLO, 14, index=1)
    # letter-spacing 3 — 글자별 배치
    live, lsp = "LIVE", int(3 * SCALE)
    lw = sum(draw.textlength(ch, font=live_font) for ch in live) + lsp * (len(live) - 1)
    lx = int(1100 * SCALE) - lw
    for ch in live:
        draw.text((lx, cy), ch, font=live_font, fill=RED, anchor="lm")
        lx += draw.textlength(ch, font=live_font) + lsp

    # ── 워드마크 로고 (가운데): Tesla(빨강) Brief!ng(잉크, ! 빨강) ──
    logo_font = F(ARIAL_B, 90)
    w_tesla = draw.textlength("Tesla", font=logo_font)
    w_brief = draw.textlength("Brief", font=logo_font)
    w_excl  = draw.textlength("!", font=logo_font)
    w_ng    = draw.textlength("ng", font=logo_font)
    gap     = draw.textlength(" ", font=logo_font)
    logo_w = w_tesla + gap + w_brief + w_excl + w_ng
    x = (W - logo_w) / 2
    ly = int(252 * SCALE)
    draw.text((x, ly), "Tesla", font=logo_font, fill=RED, anchor="lm"); x += w_tesla + gap
    draw.text((x, ly), "Brief", font=logo_font, fill=INK, anchor="lm"); x += w_brief
    draw.text((x, ly), "!",     font=logo_font, fill=RED, anchor="lm"); x += w_excl
    draw.text((x, ly), "ng",    font=logo_font, fill=INK, anchor="lm")

    # ── 한국어 카피 (가운데) ──
    copy_font = F(NANUM_EB, 46)
    seg1, seg2 = "테슬라 뉴스를 ", "한눈에 빠르게"
    w1 = draw.textlength(seg1, font=copy_font)
    w2 = draw.textlength(seg2, font=copy_font)
    tx = (W - (w1 + w2)) / 2
    ty = int(408 * SCALE)
    draw.text((tx, ty), seg1, font=copy_font, fill=COPY, anchor="lm")
    draw.text((tx + w1, ty), seg2, font=copy_font, fill=RED, anchor="lm")

    # ── 부제 (가운데) ──
    sub_font = F(NANUM_EB, 20)
    draw.text((W / 2, int(470 * SCALE)), "SEC · 어닝 콜 · 머스크 발언 — 매일 한 통",
              font=sub_font, fill=SUB, anchor="mm")

    # ── URL (좌하단) ──
    url_font = F(MENLO, 20, index=1)
    draw.text((int(60 * SCALE), int(582 * SCALE)), "teslabriefing.com",
              font=url_font, fill=URLC, anchor="lm")

    # ── 카테고리 (우하단) ──
    cat_font = F(NANUM_EB, 15)
    draw.text((int(1140 * SCALE), int(582 * SCALE)),
              "Stock · Product · FSD/Robotaxi · 머스크 발언",
              font=cat_font, fill=SUB, anchor="rm")

    # 2x → 1200x630 다운스케일 (슈퍼샘플 안티앨리어싱)
    out = img.resize((BW, BH), Image.LANCZOS)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    out.save(OUT)
    print(f"OK → {OUT} ({BW}x{BH})")


if __name__ == "__main__":
    main()
