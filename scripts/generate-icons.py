#!/usr/bin/env python3
"""
Deterministic multi-platform icon pipeline for TwinkleBot.
Crops the clean interior of `build/icon-source.jpg` well inside its outer border
(eliminating 100% of white margins, drop shadows, and JPEG edge halos), reconstructs
a seamless full-bleed square master via superellipse boundary continuation, and
generates synchronized macOS, Windows, Linux, Web, Landing, iOS, Android, and compact
macOS Template / color Status-Bar icons.
"""

from __future__ import annotations

import math
import shutil
import subprocess
import tempfile
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
SOURCE_JPG = ROOT / "build" / "icon-source.jpg"

# Calibrated sub-pixel geometry of the squircle inside build/icon-source.jpg (1024x1024):
# Outer border lies at R_outer = 345.5 (cx=511.5, cy=511.5, superellipse exponent p=4.9).
# Stepping inward to R_SAFE = 337.5 stays 8px inside the rim and >10px away from any
# white outer background pixel, guaranteeing zero white edge contamination.
SRC_CX = 511.5
SRC_CY = 511.5
SRC_R_SAFE = 337.5
SRC_EXP = 4.9


def extract_full_bleed_master(
    src_img: Image.Image,
    out_size: int = 1024,
    core_ratio: float = 1.0,
) -> Image.Image:
    """
    Reconstructs a seamless opaque RGB square of `out_size x out_size` from the safe
    interior of `src_img` with ZERO white borders or corner fringes.

    - `core_ratio = 1.0`: maps [-SRC_R_SAFE, +SRC_R_SAFE] directly to the full square,
      smoothly continuing edge colors into the 4 tiny corner triangles outside the squircle.
    - `core_ratio < 1.0`: maps the core artwork to the central `core_ratio` fraction of
      the square (e.g. 0.685 for Android 108dp Adaptive Icon safe zone, 0.805 for macOS
      824/1024 squircle, 0.90 for Android round icon) and smoothly extends boundary colors
      across the outer bleed margin.
    """
    rgb_src = src_img.convert("RGB")
    try:
        import numpy as np

        arr = np.asarray(rgb_src, dtype=np.float32)
        h_src, w_src, _ = arr.shape

        coords = (np.arange(out_size, dtype=np.float32) - (out_size - 1) / 2.0) / (
            (out_size - 1) / 2.0
        )
        ny, nx = np.meshgrid(coords, coords, indexing="ij")
        ux = nx / core_ratio
        uy = ny / core_ratio

        rho = (np.abs(ux) ** SRC_EXP + np.abs(uy) ** SRC_EXP) ** (1.0 / SRC_EXP)
        rho_safe = np.maximum(rho, 1e-6)

        # Inside rho <= 0.985: exact 1:1 linear sampling of the original artwork.
        # Outside rho > 0.985: clamp onto the clean interior rim so corners/bleed
        # carry pure saturated edge colors with zero white pixels.
        clamp_limit = 0.985
        scale = np.where(rho <= clamp_limit, 1.0, clamp_limit / rho_safe)
        sx = np.clip(SRC_CX + ux * scale * SRC_R_SAFE, 0.0, w_src - 1.001)
        sy = np.clip(SRC_CY + uy * scale * SRC_R_SAFE, 0.0, h_src - 1.001)

        # Bilinear interpolation
        x0 = np.floor(sx).astype(np.int32)
        y0 = np.floor(sy).astype(np.int32)
        x1 = np.minimum(x0 + 1, w_src - 1)
        y1 = np.minimum(y0 + 1, h_src - 1)
        wx = (sx - x0)[..., None]
        wy = (sy - y0)[..., None]

        c00 = arr[y0, x0]
        c10 = arr[y0, x1]
        c01 = arr[y1, x0]
        c11 = arr[y1, x1]
        sampled = (
            c00 * (1.0 - wx) * (1.0 - wy)
            + c10 * wx * (1.0 - wy)
            + c01 * (1.0 - wx) * wy
            + c11 * wx * wy
        )

        out_img = Image.fromarray(np.clip(np.round(sampled), 0, 255).astype(np.uint8), "RGB")

        # Softly diffuse only the extrapolated bleed zone (rho > 0.99) so corner gradients look silky
        blurred = out_img.filter(ImageFilter.GaussianBlur(radius=max(2.0, out_size * 0.014)))
        blend_t = np.clip((rho - 0.985) / 0.045, 0.0, 1.0)[..., None]
        sharp_arr = np.asarray(out_img, dtype=np.float32)
        blur_arr = np.asarray(blurred, dtype=np.float32)
        final_arr = sharp_arr * (1.0 - blend_t) + blur_arr * blend_t
        return Image.fromarray(np.clip(np.round(final_arr), 0, 255).astype(np.uint8), "RGB")

    except ImportError:
        # Pure-Pillow fallback if numpy is unavailable
        px_src = rgb_src.load()
        w_src, h_src = rgb_src.size
        work_sz = min(out_size, 512)
        out = Image.new("RGB", (work_sz, work_sz))
        px_out = out.load()
        half = (work_sz - 1) / 2.0
        for ty in range(work_sz):
            uy = ((ty - half) / half) / core_ratio
            uy_p = abs(uy) ** SRC_EXP
            for tx in range(work_sz):
                ux = ((tx - half) / half) / core_ratio
                rho = (abs(ux) ** SRC_EXP + uy_p) ** (1.0 / SRC_EXP)
                sc = 1.0 if rho <= 0.985 else 0.985 / max(rho, 1e-6)
                sx = int(round(max(0.0, min(w_src - 1.0, SRC_CX + ux * sc * SRC_R_SAFE))))
                sy = int(round(max(0.0, min(h_src - 1.0, SRC_CY + uy * sc * SRC_R_SAFE))))
                px_out[tx, ty] = px_src[sx, sy]
        return out if work_sz == out_size else out.resize((out_size, out_size), Image.Resampling.LANCZOS)


def make_squircle_mask(size: int, inset: float = 0.0, exp: float = 4.8) -> Image.Image:
    """4x supersampled Apple-style continuous-curvature superellipse alpha mask."""
    ss = 4
    ms = size * ss
    half = (ms - 1) / 2.0
    radius = (size / 2.0 - inset) * ss
    if radius <= 0:
        return Image.new("L", (size, size), 0)

    try:
        import numpy as np

        coords = np.abs(np.arange(ms, dtype=np.float32) - half) / radius
        dy, dx = np.meshgrid(coords, coords, indexing="ij")
        val = (dx ** exp + dy ** exp) ** (1.0 / exp)
        # Anti-aliased 1-supersampled-pixel ramp right at val == 1.0
        aa = 1.0 / max(radius, 1.0)
        alpha = np.clip((1.0 + aa * 0.5 - val) / aa, 0.0, 1.0) * 255.0
        mask_hi = Image.fromarray(np.round(alpha).astype(np.uint8), "L")
        return mask_hi.resize((size, size), Image.Resampling.LANCZOS)
    except ImportError:
        mask = Image.new("L", (ms, ms), 0)
        d = ImageDraw.Draw(mask)
        ins = int(round(inset * ss))
        r = int(round((size - 2 * inset) * 0.225 * ss))
        d.rounded_rectangle((ins, ins, ms - 1 - ins, ms - 1 - ins), radius=r, fill=255)
        return mask.resize((size, size), Image.Resampling.LANCZOS)


def apply_mask_zero_fringe(rgb_bleed: Image.Image, mask: Image.Image) -> Image.Image:
    """
    Combines an opaque color-extrapolated RGB image with an alpha mask using straight
    alpha (`putalpha`) so semi-transparent boundary pixels carry pure interior RGB
    colors with ZERO white or gray fringe on any background.
    """
    rgba = rgb_bleed.convert("RGBA")
    rgba.putalpha(mask)
    return rgba


def build_macos_squircle_icon(src_img: Image.Image, size: int = 1024) -> Image.Image:
    """
    Apple HIG macOS app icon: 824x824 squircle inside 1024x1024 transparent RGBA canvas,
    with soft ambient drop shadow and zero white border.
    """
    inset = size * (100.0 / 1024.0)
    core_ratio = (size - 2.0 * inset) / size  # 824 / 1024 = 0.8046875
    bleed_rgb = extract_full_bleed_master(src_img, out_size=size, core_ratio=core_ratio)
    mask = make_squircle_mask(size, inset=inset, exp=4.8)

    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))

    # Subtle ambient drop shadow (pure black alpha, never white)
    shadow_mask = ImageChops.offset(mask, 0, int(round(size * 0.012)))
    shadow_mask = shadow_mask.filter(ImageFilter.GaussianBlur(radius=max(1.0, size * 0.018)))
    shadow_alpha = shadow_mask.point(lambda a: int(round(a * 0.24)))
    shadow_layer = Image.new("RGBA", (size, size), (12, 14, 24, 255))
    shadow_layer.putalpha(shadow_alpha)

    clipped = apply_mask_zero_fringe(bleed_rgb, mask)
    out = Image.alpha_composite(out, shadow_layer)
    out = Image.alpha_composite(out, clipped)
    return out


def build_tight_squircle_icon(
    src_img: Image.Image,
    size: int,
    inset_ratio: float = 0.015,
) -> Image.Image:
    """Tight borderless squircle for Web favicons, Windows taskbar ICO, and system tray."""
    inset = size * inset_ratio
    core_ratio = max(0.5, (size - 2.0 * inset) / size)
    bleed_rgb = extract_full_bleed_master(src_img, out_size=max(size, 256), core_ratio=core_ratio)
    if bleed_rgb.size != (size, size):
        bleed_rgb = bleed_rgb.resize((size, size), Image.Resampling.LANCZOS)
    mask = make_squircle_mask(size, inset=inset, exp=4.8)
    return apply_mask_zero_fringe(bleed_rgb, mask)


def draw_four_point_star(
    draw: ImageDraw.ImageDraw,
    cx: float,
    cy: float,
    outer_r: float,
    waist_r: float,
    fill: int,
) -> None:
    pts: list[tuple[float, float]] = []
    steps = 18
    for q in range(4):
        a0 = q * (math.pi / 2.0)
        a1 = (q + 1) * (math.pi / 2.0)
        p0 = (cx + outer_r * math.cos(a0), cy + outer_r * math.sin(a0))
        pmid = (
            cx + waist_r * math.cos(a0 + math.pi / 4.0),
            cy + waist_r * math.sin(a0 + math.pi / 4.0),
        )
        p2 = (cx + outer_r * math.cos(a1), cy + outer_r * math.sin(a1))
        for s in range(steps):
            t = s / steps
            omt = 1.0 - t
            x = omt * omt * p0[0] + 2 * omt * t * pmid[0] + t * t * p2[0]
            y = omt * omt * p0[1] + 2 * omt * t * pmid[1] + t * t * p2[1]
            pts.append((x, y))
    draw.polygon(pts, fill=fill)


def build_macos_tray_template(px_size: int) -> Image.Image:
    """
    macOS Menu Bar Template Icon (`20x20` & `40x40` @2x):
    - Calibrated ~17.5pt x 17.5pt (`35x35px` @2x) optical glyph footprint inside a
      20pt x 20pt (`40x40px` @2x) canvas so top/bottom visual bounds align 1:1 with
      native macOS status-bar icons (Wi-Fi, Control Center, OrbStack, ChatGPT, Claude).
    - Synchronized with the 3D TwinkleBot icon composition: tilted (-12.5deg) Astro-Visor
      Bot (rounded helmet + side ear-pods + ball antenna + cutout visor + capsule eyes)
      paired with a crisp upper-right 4-point Twinkle star.
    - Pure #000000 RGB + calibrated alpha channel for `setTemplateImage(true)`.
    """
    ss = 12
    W = px_size * ss
    u = W / 64.0

    # 1. Draw upright Astro-Visor Bot on high-res layer, then tilt +12.5deg CCW
    bot_layer = Image.new("L", (W, W), 0)
    bd = ImageDraw.Draw(bot_layer)
    bcx, bcy = W * 0.50, W * 0.54

    # Side ear-pods
    bd.rounded_rectangle(
        (bcx - 25.5 * u, bcy - 5.0 * u, bcx - 19.2 * u, bcy + 7.8 * u),
        radius=3.1 * u,
        fill=255,
    )
    bd.rounded_rectangle(
        (bcx + 19.2 * u, bcy - 5.0 * u, bcx + 25.5 * u, bcy + 7.8 * u),
        radius=3.1 * u,
        fill=255,
    )
    # Antenna stem & top ball
    bd.rectangle((bcx - 2.4 * u, bcy - 24.8 * u, bcx + 2.4 * u, bcy - 17.0 * u), fill=255)
    bd.ellipse((bcx - 5.3 * u, bcy - 33.0 * u, bcx + 5.3 * u, bcy - 22.4 * u), fill=255)
    # Main helmet dome
    bd.rounded_rectangle(
        (bcx - 21.4 * u, bcy - 18.4 * u, bcx + 21.4 * u, bcy + 19.2 * u),
        radius=13.0 * u,
        fill=255,
    )

    # Cutout visor window (alpha = 0)
    bd.rounded_rectangle(
        (bcx - 15.2 * u, bcy - 7.6 * u, bcx + 15.2 * u, bcy + 9.4 * u),
        radius=8.0 * u,
        fill=0,
    )
    # Solid capsule eyes inside visor (alpha = 255)
    bd.rounded_rectangle(
        (bcx - 9.3 * u, bcy - 4.0 * u, bcx - 3.8 * u, bcy + 5.6 * u),
        radius=2.7 * u,
        fill=255,
    )
    bd.rounded_rectangle(
        (bcx + 3.8 * u, bcy - 4.0 * u, bcx + 9.3 * u, bcy + 5.6 * u),
        radius=2.7 * u,
        fill=255,
    )

    tilted_bot = bot_layer.rotate(12.5, resample=Image.Resampling.BICUBIC, center=(bcx, bcy))
    alpha = ImageChops.offset(tilted_bot, int(round(-2.8 * u)), int(round(3.2 * u)))

    # 2. Add upper-right 4-point Twinkle star tucked above tilted shoulder
    ad = ImageDraw.Draw(alpha)
    draw_four_point_star(ad, W * 0.80, W * 0.20, outer_r=8.2 * u, waist_r=2.25 * u, fill=255)

    alpha_out = alpha.resize((px_size, px_size), Image.Resampling.LANCZOS)
    out = Image.new("RGBA", (px_size, px_size), (0, 0, 0, 255))
    out.putalpha(alpha_out)
    return out


def build_color_tray_icon(src_img: Image.Image, px_size: int) -> Image.Image:
    """
    Colored status-bar / system-tray icon (`20x20` & `40x40` @2x) for Win/Linux
    with zero white border.
    """
    return build_tight_squircle_icon(src_img, px_size, inset_ratio=0.06)


def generate_all() -> None:
    if not SOURCE_JPG.exists():
        raise FileNotFoundError(f"Missing master icon artwork: {SOURCE_JPG}")

    src_img = Image.open(SOURCE_JPG).convert("RGB")
    build_dir = ROOT / "build"
    build_dir.mkdir(parents=True, exist_ok=True)

    # 1. macOS 1024x1024 Squircle PNG + 10-frame .icns
    mac_1024 = build_macos_squircle_icon(src_img, 1024)
    mac_icon_png = build_dir / "icon.png"
    mac_1024.save(mac_icon_png, format="PNG")
    print(f"[icons] wrote {mac_icon_png.relative_to(ROOT)} (1024x1024 RGBA, zero white fringe)")

    if shutil.which("iconutil"):
        with tempfile.TemporaryDirectory() as tmp:
            iconset = Path(tmp) / "icon.iconset"
            iconset.mkdir()
            icns_specs = [
                ("icon_16x16.png", 16),
                ("icon_16x16@2x.png", 32),
                ("icon_32x32.png", 32),
                ("icon_32x32@2x.png", 64),
                ("icon_128x128.png", 128),
                ("icon_128x128@2x.png", 256),
                ("icon_256x256.png", 256),
                ("icon_256x256@2x.png", 512),
                ("icon_512x512.png", 512),
                ("icon_512x512@2x.png", 1024),
            ]
            for name, sz in icns_specs:
                frame = mac_1024 if sz == 1024 else mac_1024.resize((sz, sz), Image.Resampling.LANCZOS)
                frame.save(iconset / name, format="PNG")
            icns_out = build_dir / "icon.icns"
            subprocess.run(["iconutil", "-c", "icns", str(iconset), "-o", str(icns_out)], check=True)
            print(f"[icons] wrote {icns_out.relative_to(ROOT)} (10-frame macOS iconset)")

    # 2. Windows multi-frame .ico (tight squircle, zero white edge)
    win_512 = build_tight_squircle_icon(src_img, 512, inset_ratio=0.015)
    ico_out = build_dir / "icon.ico"
    win_512.save(
        ico_out,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(f"[icons] wrote {ico_out.relative_to(ROOT)} (multi-size ICO)")

    # 3. Status-Bar / Tray icons (20pt / 40px@2x aligned to macOS menu bar neighbor height)
    for sz, suffix in [(20, ""), (40, "@2x")]:
        tpl = build_macos_tray_template(sz)
        tpl.save(build_dir / f"trayIconTemplate{suffix}.png", format="PNG")

        col = build_color_tray_icon(src_img, sz)
        col.save(build_dir / f"trayIcon{suffix}.png", format="PNG")
    print("[icons] wrote 20x20 / 40x40@2x build/trayIconTemplate & build/trayIcon")

    # 4. Web & Landing 256x256 icons (tight squircle, zero white edge)
    web_256 = win_512.resize((256, 256), Image.Resampling.LANCZOS)
    for target_rel in ["public/icon.png", "landing/icon.png"]:
        out_p = ROOT / target_rel
        out_p.parent.mkdir(parents=True, exist_ok=True)
        web_256.save(out_p, format="PNG")
        print(f"[icons] wrote {target_rel} (256x256 RGBA)")

    # 5. iOS AppIcon (1024x1024 full-bleed opaque RGB without alpha channel or white corners)
    ios_icon_path = ROOT / "ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png"
    if ios_icon_path.parent.exists():
        ios_rgb = extract_full_bleed_master(src_img, out_size=1024, core_ratio=1.0)
        ios_rgb.save(ios_icon_path, format="PNG")
        print(f"[icons] wrote {ios_icon_path.relative_to(ROOT)} (1024x1024 full-bleed opaque RGB)")

    # 6. Android Adaptive (108dp safe-zone aware) & Legacy (squircle + round) mipmap icons
    android_res = ROOT / "android/app/src/main/res"
    if android_res.exists():
        # Adaptive 108dp foreground: central 68.5% (~74dp) holds the full icon composition,
        # outer 17dp bleed ring smoothly extends edge colors for parallax & OEM masks
        adaptive_master = extract_full_bleed_master(src_img, out_size=864, core_ratio=0.685).convert(
            "RGBA"
        )
        # Round master: 0.91 core_ratio keeps top-right 4-point star & antenna comfortably inside circle
        round_bleed_master = extract_full_bleed_master(src_img, out_size=512, core_ratio=0.91)

        densities = [
            ("mipmap-mdpi", 48, 108),
            ("mipmap-hdpi", 72, 162),
            ("mipmap-xhdpi", 96, 216),
            ("mipmap-xxhdpi", 144, 324),
            ("mipmap-xxxhdpi", 192, 432),
        ]
        for folder, legacy_px, fg_px in densities:
            d_dir = android_res / folder
            d_dir.mkdir(parents=True, exist_ok=True)

            # Adaptive foreground (RGBA PNG)
            fg_img = adaptive_master.resize((fg_px, fg_px), Image.Resampling.LANCZOS)
            fg_img.save(d_dir / "ic_launcher_foreground.png", format="PNG")

            # Legacy squircle launcher icon (zero white fringe)
            sq_out = build_tight_squircle_icon(src_img, legacy_px, inset_ratio=0.03)
            sq_out.save(d_dir / "ic_launcher.png", format="PNG")

            # Legacy round launcher icon (zero white fringe)
            rd_rgb = round_bleed_master.resize((legacy_px, legacy_px), Image.Resampling.LANCZOS)
            rd_mask_hi = Image.new("L", (legacy_px * 4, legacy_px * 4), 0)
            rdraw = ImageDraw.Draw(rd_mask_hi)
            ins = int(round(legacy_px * 4 * 0.025))
            rdraw.ellipse((ins, ins, legacy_px * 4 - 1 - ins, legacy_px * 4 - 1 - ins), fill=255)
            rd_mask = rd_mask_hi.resize((legacy_px, legacy_px), Image.Resampling.LANCZOS)
            rd_out = apply_mask_zero_fringe(rd_rgb, rd_mask)
            rd_out.save(d_dir / "ic_launcher_round.png", format="PNG")

        print("[icons] wrote 15 Android mipmap PNGs across mdpi..xxxhdpi")


if __name__ == "__main__":
    generate_all()
