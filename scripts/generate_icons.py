#!/usr/bin/env python3
"""generate_icons.py — 用 Pillow 绘制应用图标与托盘模板图标（默认机器人"小V"风格）。"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "build"
(OUT / "icons").mkdir(parents=True, exist_ok=True)

MINT = (127, 216, 201, 255)
SHADE = (79, 179, 161, 255)
FACE = (18, 35, 43, 255)
EYE = (126, 240, 255, 255)
ACCENT = (255, 138, 122, 255)
GLOW = (159, 242, 255, 160)

# ---------- 应用图标 1024x1024 ----------
S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 天线
d.line([(512, 150), (512, 246)], fill=SHADE, width=38)

# 天线灯球光晕（模糊层）
glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
gd = ImageDraw.Draw(glow)
gd.ellipse([512 - 105, 150 - 105, 512 + 105, 150 + 105], fill=GLOW)
glow = glow.filter(ImageFilter.GaussianBlur(46))
img.alpha_composite(glow)
d.ellipse([512 - 60, 150 - 60, 512 + 60, 150 + 60], fill=ACCENT)

# 头部（圆角矩形 + 深色描边）
d.rounded_rectangle([122, 232, 902, 858], radius=196, fill=MINT, outline=SHADE, width=30)

# 脸屏
d.rounded_rectangle([232, 342, 792, 642], radius=112, fill=FACE)

# 眼睛（胶囊 + 高光）
for cx in (398, 626):
    d.rounded_rectangle([cx - 46, 420, cx + 46, 562], radius=46, fill=EYE)
    d.ellipse([cx - 24, 440, cx + 0, 464], fill=(255, 255, 255, 220))

# 微笑
d.arc([450, 548, 574, 662], start=25, end=155, fill=EYE, width=24)

# 腮红
for cx in (300, 724):
    d.ellipse([cx - 34, 566, cx + 34, 610], fill=(255, 138, 122, 140))

img.save(OUT / "icon.png")
img.save(OUT / "icons" / "icon.png")

# ---------- 托盘模板图标 22x22（黑形 + 透明镂空，macOS template image） ----------
T = 22
mask = Image.new("L", (T, T), 0)
md = ImageDraw.Draw(mask)
md.line([(11, 4), (11, 7)], fill=255, width=2)          # 天线杆
md.ellipse([9, 0, 13, 4], fill=255)                     # 灯球
md.rounded_rectangle([3, 7, 19, 20], radius=5, fill=255)  # 头
md.rounded_rectangle([7, 11, 9, 14], radius=1, fill=0)    # 左眼镂空
md.rounded_rectangle([13, 11, 15, 14], radius=1, fill=0)  # 右眼镂空
tray = Image.new("RGBA", (T, T), (0, 0, 0, 255))
tray.putalpha(mask)
tray.save(OUT / "icons" / "trayTemplate.png")

# 44x44 @2x 版本
tray2x = tray.resize((44, 44), Image.LANCZOS)
tray2x.save(OUT / "icons" / "trayTemplate@2x.png")

print(f"icons written to {OUT}")
