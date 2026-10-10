#!/usr/bin/env python3
"""种子色 → MD3 色调板（tones）→ CSS 令牌。
MD3 的 tone 就是 CIELAB 的 L*，所以每个 tone 取 L*=T、保持种子色相、
二分色度到 sRGB 色域边界，就能得到一条不会溢出的色调梯。
"""
import sys

# ── sRGB ⇄ CIELAB(D65) ────────────────────────────────────────────
def to_lin(c):
    c /= 255
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

def to_gam(c):
    c = max(0.0, min(1.0, c))
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055

# sRGB(D65) → XYZ
M = ((0.4123908, 0.3575843, 0.1804808),
     (0.2126390, 0.7151687, 0.0721923),
     (0.0193308, 0.1191948, 0.9505322))
MINV = ((3.2409699, -1.5373832, -0.4986108),
        (-0.9692436, 1.8759675, 0.0415551),
        (0.0556301, -0.2039770, 1.0569715))
WP = (0.95047, 1.0, 1.08883)

def f(t):
    return t ** (1 / 3) if t > 216 / 24389 else (841 / 108) * t + 4 / 29

def fi(t):
    return t ** 3 if t > 6 / 29 else (t - 4 / 29) * 108 / 841

def hex_to_lab(h):
    r, g, b = (int(h[i:i + 2], 16) for i in (1, 3, 5))
    r, g, b = to_lin(r), to_lin(g), to_lin(b)
    X = sum(M[0][i] * v for i, v in enumerate((r, g, b)))
    Y = sum(M[1][i] * v for i, v in enumerate((r, g, b)))
    Z = sum(M[2][i] * v for i, v in enumerate((r, g, b)))
    fx, fy, fz = f(X / WP[0]), f(Y / WP[1]), f(Z / WP[2])
    return 116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)

def lab_to_rgb(L, a, b):
    """返回 (hex, 是否在色域内)。"""
    fy = (L + 16) / 116
    fx, fz = fy + a / 500, fy - b / 200
    X, Y, Z = WP[0] * fi(fx), WP[1] * fi(fy), WP[2] * fi(fz)
    lin = [sum(MINV[i][j] * v for j, v in enumerate((X, Y, Z))) for i in range(3)]
    ok = all(-1e-4 <= v <= 1 + 1e-4 for v in lin)
    srgb = [round(to_gam(v) * 255) for v in lin]
    return "#%02x%02x%02x" % tuple(srgb), ok

def tone(L, hue_a, hue_b, cmax):
    """在 L*=L、给定色相方向上，二分出最大的不溢出彩度。"""
    n = (hue_a ** 2 + hue_b ** 2) ** .5 or 1.0
    ua, ub = hue_a / n, hue_b / n
    lo, hi = 0.0, cmax
    for _ in range(24):
        mid = (lo + hi) / 2
        if lab_to_rgb(L, ua * mid, ub * mid)[1]:
            lo = mid
        else:
            hi = mid
    return lab_to_rgb(L, ua * lo, ub * lo)[0]

TONES = [0, 4, 6, 10, 12, 17, 20, 22, 24, 30, 40, 50, 60, 70, 80, 87, 90, 92, 94, 95, 96, 98, 99, 100]

def palette(seed, chroma=None, hue_shift=0.0, cap=None):
    L, a, b = hex_to_lab(seed)
    n = (a * a + b * b) ** .5 or 1.0
    a, b = a / n, b / n              # 单位色相方向
    ang = hue_shift * 3.14159265 / 180
    a, b = a * (1 if not hue_shift else 1), b
    if hue_shift:
        a, b = (a * __import__('math').cos(ang) - b * __import__('math').sin(ang),
                a * __import__('math').sin(ang) + b * __import__('math').cos(ang))
    C = chroma if chroma is not None else (a * a + b * b) ** .5 * 0 + (cap or 70)
    if cap:
        C = min(C, cap)
    return {t: tone(t, a, b, C) for t in TONES}

SEED = "#0ab84a"
L, sa, sb = hex_to_lab(SEED)
Cseed = (sa * sa + sb * sb) ** .5
import os
CAP = float(os.environ.get("CAP", "42"))     # 色度上限≈HCT 36-40，别做成霓虹
TERH = float(os.environ.get("TERH", "70"))   # tertiary 色相旋转
P = palette(SEED, chroma=CAP)                          # primary：种子本色相
S = palette(SEED, chroma=CAP * 0.34)                   # secondary：同色相低彩
T = palette(SEED, chroma=CAP * 0.55, hue_shift=TERH)   # tertiary：转色相
N = palette(SEED, cap=2.5)                             # neutral：近中性
NV = palette(SEED, cap=6.0)                            # neutral-variant：微冷灰
E = {t: v for t, v in [(10, "#410002"), (20, "#690005"), (30, "#93000a"), (40, "#ba1a1a"),
                       (80, "#ffb4ab"), (90, "#ffdad6"), (100, "#ffffff")]}   # MD3 基线红，不随种子变

LIGHT = [
    ("primary", P[40]), ("on-primary", P[100]), ("primary-container", P[90]),
    ("on-primary-container", P[10]), ("primary-fixed", P[90]), ("on-primary-fixed", P[10]),
    ("primary-fixed-dim", P[80]),
    ("secondary", S[40]), ("on-secondary", S[100]), ("secondary-container", S[90]),
    ("on-secondary-container", S[10]),
    ("tertiary", T[40]), ("on-tertiary", T[100]), ("tertiary-container", T[90]),
    ("on-tertiary-container", T[10]),
    ("error", E[40]), ("on-error", E[100]), ("error-container", E[90]),
    ("on-error-container", E[10]),
    ("background", N[99]), ("on-background", N[10]),
    ("surface", N[98]), ("on-surface", N[10]),
    ("surface-variant", NV[90]), ("on-surface-variant", NV[30]),
    ("surface-dim", N[87]), ("surface-bright", N[98]),
    ("surface-container-lowest", N[100]), ("surface-container-low", N[96]),
    ("surface-container", N[94]), ("surface-container-high", N[92]),
    ("surface-container-highest", N[90]),
    ("outline", NV[50]), ("outline-variant", NV[80]),
    ("inverse-surface", N[20]), ("inverse-on-surface", N[95]), ("inverse-primary", P[80]),
    ("scrim", N[0]), ("shadow", N[0]),
    ("route", "#0ab84a"),
]
DARK = [
    ("primary", P[80]), ("on-primary", P[20]), ("primary-container", P[30]),
    ("on-primary-container", P[90]), ("primary-fixed", P[90]), ("on-primary-fixed", P[10]),
    ("primary-fixed-dim", P[80]),
    ("secondary", S[80]), ("on-secondary", S[20]), ("secondary-container", S[30]),
    ("on-secondary-container", S[90]),
    ("tertiary", T[80]), ("on-tertiary", T[20]), ("tertiary-container", T[30]),
    ("on-tertiary-container", T[90]),
    ("error", E[80]), ("on-error", E[20]), ("error-container", E[30]),
    ("on-error-container", E[90]),
    ("background", N[6]), ("on-background", N[90]),
    ("surface", N[6]), ("on-surface", N[90]),
    ("surface-variant", NV[30]), ("on-surface-variant", NV[80]),
    ("surface-dim", N[6]), ("surface-bright", N[24]),
    ("surface-container-lowest", N[4]), ("surface-container-low", N[10]),
    ("surface-container", N[12]), ("surface-container-high", N[17]),
    ("surface-container-highest", N[22]),
    ("outline", NV[60]), ("outline-variant", NV[30]),
    ("inverse-surface", N[90]), ("inverse-on-surface", N[20]), ("inverse-primary", P[40]),
    ("scrim", N[0]), ("shadow", N[0]),
    ("route", P[80]),
]

def block(name, rows):
    print(f"/* {name} */")
    for k, v in rows:
        print(f"  --md-sys-color-{k}: {v};")
    print()

if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--all":
        print(f"/* 种子 {SEED} | Lab L*={L:.1f} C={Cseed:.1f} → 色度上限 {CAP} */")
        print("/* route = 品牌自定义色角色：只画走向条轴线，不承载文字 */")
        print()
        block("亮色方案", LIGHT)
        block("暗色方案", DARK)
    else:
        for t in TONES:
            print(t, P[t], S[t], T[t], N[t], NV[t], E[t])
