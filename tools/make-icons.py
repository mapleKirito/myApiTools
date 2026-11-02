#!/usr/bin/env python3
"""
生成应用图标（打包图标 + 运行期窗口/托盘图标）
---------------------------------------------------------------
用法：
    pip install pillow
    python tools/make-icons.py [源图路径]

默认源图是 build/icon-source.jpg。产物：
    build/icon.ico           Windows 打包（16/24/32/48/64/128/256 多尺寸）
    build/icon.icns          macOS 打包
    build/icon.png           Linux 打包（1024×1024）
    electron/assets/icon.png  BrowserWindow.icon
    electron/assets/tray.ico  Windows 托盘（多尺寸，系统按 DPI 挑一档）
    electron/assets/tray.png  macOS / Linux 托盘
    electron/assets/tray-16.png  备用小图

为什么单独搞个脚本：图标是二进制产物，纯靠手工会导致「下次想换图不知道当初怎么裁的」。
裁剪框（头部）与圆角比例都写死在这里，换图时改这两个常量即可。
"""

import os
import shutil
import sys

try:
    from PIL import Image, ImageDraw
except ImportError:
    sys.exit('缺少 Pillow，请先执行：pip install pillow')

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# 裁剪参数：以源图里「头部」为中心取正方形，再套圆角。
# 16~32px 的小图标如果直接缩整张插画，脸会糊成一团，所以必须裁到头部。
CROP_SIDE = 320
CROP_CENTER = (250, 185)
CORNER_RATIO = 0.18


def rounded(img, radius_ratio=CORNER_RATIO):
    """圆角 + 透明外角。先放大 4 倍再算遮罩，避免圆角边缘出现锯齿。"""
    size = img.size[0]
    scale = 4
    mask = Image.new('L', (size * scale, size * scale), 0)
    draw = ImageDraw.Draw(mask)
    r = int(size * scale * radius_ratio)
    draw.rounded_rectangle((0, 0, size * scale - 1, size * scale - 1), radius=r, fill=255)
    mask = mask.resize((size, size), Image.LANCZOS)
    out = img.convert('RGBA')
    out.putalpha(mask)
    return out


def main():
    src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, 'build', 'icon-source.jpg')
    if not os.path.exists(src):
        sys.exit('找不到源图：' + src)

    im = Image.open(src).convert('RGB')
    w, h = im.size
    cx, cy = CROP_CENTER
    half = CROP_SIDE // 2
    box = (max(0, cx - half), max(0, cy - half), min(w, cx + half), min(h, cy + half))
    crop = im.crop(box)

    master = rounded(crop.resize((1024, 1024), Image.LANCZOS))

    build_dir = os.path.join(ROOT, 'build')
    assets_dir = os.path.join(ROOT, 'electron', 'assets')
    os.makedirs(build_dir, exist_ok=True)
    os.makedirs(assets_dir, exist_ok=True)

    master.save(os.path.join(build_dir, 'icon.png'))
    master.save(os.path.join(build_dir, 'icon.ico'),
                sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    master.save(os.path.join(build_dir, 'icon.icns'))

    master.resize((256, 256), Image.LANCZOS).save(os.path.join(assets_dir, 'icon.png'))
    master.resize((32, 32), Image.LANCZOS).save(os.path.join(assets_dir, 'tray.png'))
    master.resize((16, 16), Image.LANCZOS).save(os.path.join(assets_dir, 'tray-16.png'))
    master.save(os.path.join(assets_dir, 'tray.ico'),
                sizes=[(16, 16), (20, 20), (24, 24), (32, 32), (40, 40), (48, 48), (64, 64)])

    # 源图留一份在仓库里，换图时不用再翻聊天记录
    if os.path.abspath(src) != os.path.abspath(os.path.join(build_dir, 'icon-source.jpg')):
        shutil.copyfile(src, os.path.join(build_dir, 'icon-source.jpg'))

    print('图标已生成：build/icon.{ico,icns,png} + electron/assets/{icon,tray}.*')


if __name__ == '__main__':
    main()
