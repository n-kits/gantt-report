"""
Подбор палитры цветов исполнителей (EXEC_PALETTE в js/model.js).

Цель: максимизировать минимальное ΔE2000 между любыми двумя цветами палитры
при ограничениях:
  * контраст ≥ 4.5:1 на фоне строки (#FAF8F3) и подсветки (#EFE9DC) — читаемый жирный текст;
  * светлота L* ≥ 30 — без «почти чёрных», неразличимых мелким текстом;
  * насыщенность 25 ≤ C* ≤ 70 — без серых и без кислотных цветов;
  * ΔE ≥ 20 до цветов статусов (зелёный «в срок», красный «нарушен»).
Алгоритм: сетка sRGB → фильтр → farthest-point + локальный поиск заменами
(40 случайных стартов) → жадный порядок, чтобы первые N цветов были максимально различимы.

Запуск: python tools/palette.py  (нужен numpy)
"""
import itertools
import numpy as np

BGS = ['#FAF8F3', '#EFE9DC']          # фон колонки и подсветка строки
AVOID = ['#2E7D4F', '#B42318']         # статусы «в срок» / «нарушен»
AVOID_MIN = 20.0                       # минимальный ΔE до статусных цветов
L_MIN, C_MIN, C_MAX = 30, 25, 70
N = 16
rng = np.random.default_rng(1)


def hex2rgb(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)]) / 255


def lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def lum(rgb):
    r, g, b = lin(rgb).T
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def lab(rgb):
    r, g, b = lin(rgb).T
    x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047
    y = 0.2126 * r + 0.7152 * g + 0.0722 * b
    z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883
    f = lambda t: np.where(t > 0.008856, np.cbrt(t), 7.787 * t + 16 / 116)
    return np.stack([116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))], -1)


def de2000(A, B):
    """ΔE2000 между всеми строками A (n,3) и B (m,3) → (n,m)."""
    L1, a1, b1 = [A[:, i][:, None] for i in range(3)]
    L2, a2, b2 = [B[:, i][None, :] for i in range(3)]
    C1 = np.hypot(a1, b1); C2 = np.hypot(a2, b2); Cb = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)))
    a1p = (1 + G) * a1; a2p = (1 + G) * a2
    C1p = np.hypot(a1p, b1); C2p = np.hypot(a2p, b2)
    h1 = np.degrees(np.arctan2(b1, a1p)) % 360; h2 = np.degrees(np.arctan2(b2, a2p)) % 360
    dL = L2 - L1; dC = C2p - C1p
    dh = h2 - h1
    dh = np.where(dh > 180, dh - 360, np.where(dh < -180, dh + 360, dh))
    dh = np.where(C1p * C2p == 0, 0, dh)
    dH = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dh / 2))
    Lb = (L1 + L2) / 2; Cbp = (C1p + C2p) / 2
    hb = np.where(np.abs(h1 - h2) <= 180, (h1 + h2) / 2, (h1 + h2 + 360) / 2)
    hb = np.where(C1p * C2p == 0, h1 + h2, hb)
    T = (1 - 0.17 * np.cos(np.radians(hb - 30)) + 0.24 * np.cos(np.radians(2 * hb))
         + 0.32 * np.cos(np.radians(3 * hb + 6)) - 0.20 * np.cos(np.radians(4 * hb - 63)))
    SL = 1 + 0.015 * (Lb - 50) ** 2 / np.sqrt(20 + (Lb - 50) ** 2)
    SC = 1 + 0.045 * Cbp; SH = 1 + 0.015 * Cbp * T
    dt = 30 * np.exp(-((hb - 275) / 25) ** 2)
    RC = 2 * np.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7)); RT = -np.sin(np.radians(2 * dt)) * RC
    return np.sqrt((dL / SL) ** 2 + (dC / SC) ** 2 + (dH / SH) ** 2 + RT * (dC / SC) * (dH / SH))


def contrast(l1, l2):
    hi, lo = np.maximum(l1, l2), np.minimum(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


# --- кандидаты: сетка sRGB, фильтр по контрасту и расстоянию до статусов ----
lv = np.arange(0, 256, 8)
grid = np.array(list(itertools.product(lv, lv, lv))) / 255
L = lum(grid)
ok = np.ones(len(grid), bool)
for bg in BGS:
    ok &= contrast(L, lum(hex2rgb(bg)[None])[0]) >= 4.5
cand = grid[ok]
LAB = lab(cand)
avoid_lab = lab(np.array([hex2rgb(h) for h in AVOID]))
ok2 = de2000(LAB, avoid_lab).min(1) >= AVOID_MIN
chroma = np.hypot(LAB[:, 1], LAB[:, 2])
ok2 &= (LAB[:, 0] >= L_MIN) & (chroma >= C_MIN) & (chroma <= C_MAX)
cand, LAB = cand[ok2], LAB[ok2]
print('кандидатов:', len(cand))


def score(idx):
    D = de2000(LAB[idx], LAB[idx]); np.fill_diagonal(D, 1e9)
    return D.min()


def optimize(seed):
    # farthest-point старт + локальный поиск заменами
    idx = [seed]
    dmin = de2000(LAB, LAB[[seed]])[:, 0]
    while len(idx) < N:
        j = int(dmin.argmax()); idx.append(j)
        dmin = np.minimum(dmin, de2000(LAB, LAB[[j]])[:, 0])
    best = score(idx)
    improved = True
    while improved:
        improved = False
        for k in range(N):
            rest = idx[:k] + idx[k + 1:]
            Dr = de2000(LAB, LAB[rest]).min(1)            # до остальных 15
            Rr = de2000(LAB[rest], LAB[rest]); np.fill_diagonal(Rr, 1e9)
            base = Rr.min()
            val = np.minimum(Dr, base)
            j = int(val.argmax())
            if val[j] > best + 1e-6:
                idx[k] = j; best = val[j]; improved = True
    return best, idx


results = [optimize(int(s)) for s in rng.choice(len(cand), 40, replace=False)]
best, idx = max(results, key=lambda r: r[0])
print('min ΔE2000 внутри палитры: %.1f' % best)

# порядок: жадно, чтобы каждый следующий был максимально далёк от уже выбранных
P = LAB[idx]
D = de2000(P, P)
i0, j0 = np.unravel_index(D.argmax(), D.shape)
order = [int(i0), int(j0)]
while len(order) < N:
    rest = [k for k in range(N) if k not in order]
    order.append(max(rest, key=lambda k: D[k, order].min()))

hexes = ['#%02X%02X%02X' % tuple((cand[idx[k]] * 255).round().astype(int)) for k in order]
Lb = [lum(hex2rgb(b)[None])[0] for b in BGS]
for n, h in enumerate(hexes, 1):
    c = hex2rgb(h)[None]
    k = order[n - 1]
    others = [order[m] for m in range(N) if m != n - 1]
    print(f'{n:2} {h}  L*={lab(c)[0,0]:4.1f}  контраст {contrast(lum(c)[0], Lb[0]):.1f}/{contrast(lum(c)[0], Lb[1]):.1f}'
          f'  ближайший ΔE={D[k, others].min():.1f}  до статусов ΔE={de2000(lab(c), avoid_lab).min():.1f}')
for n in (4, 8, 12, 16):
    sub = [order[m] for m in range(n)]
    Ds = D[np.ix_(sub, sub)].copy(); np.fill_diagonal(Ds, 1e9)
    print(f'первые {n}: min ΔE = {Ds.min():.1f}')

print('JS:', hexes)
