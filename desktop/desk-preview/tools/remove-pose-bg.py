# -*- coding: utf-8 -*-
"""把 mainPage 白底书桌动作图抠成透明(保留人物+书桌+道具)。

需在 WSL comfyui 环境跑(用 onnxruntime + isnet-anime)。
与立绘包同一路线: 纯白底生成 -> isnet 分割 -> 色距兜底救回书桌 -> 离体符号恢复 -> 按采样底色去边。
用法: python remove-pose-bg.py [动作名 ...]   (默认全部 6 个)
输入: mainPage/<动作>/pose-<动作>.png (白底选定图)
输出: mainPage/<动作>/pose-<动作>-transparent.png
"""
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path("/mnt/e/tmp/testWorkSpace/materailPhoto/mainPage")
MODEL = "/mnt/e/tmp/testWorkSpace/materailPhoto/_models/isnet-anime.onnx"
ACTIONS = ["chatting", "reading", "writing", "tea", "sharing", "night"]


def bg_color(img: Image.Image) -> np.ndarray:
    # 顶边整条取中位数: 人物头顶不贴边, 底角可能是书桌等前景
    a = np.array(img)
    m = max(8, a.shape[0] // 50)
    return np.median(a[:m].reshape(-1, 3), axis=0)


def restore_symbols(img: Image.Image, mask: Image.Image) -> Image.Image:
    # 同立绘包: 抠图模型会丢掉闪光/热气等离体符号, 非白色小连通域恢复为不透明
    ary = np.array(img)
    h, w = ary.shape[:2]
    nonwhite = (ary.min(axis=2) < 245).astype(np.uint8)
    n, labels, stats, centroids = cv2.connectedComponentsWithStats(nonwhite, 8)
    model_bin = np.array(mask) > 128
    overlap = np.bincount(labels[model_bin], minlength=n)
    overlap[0] = 0
    main = int(overlap.argmax())
    out = np.array(mask)
    for lbl in range(1, n):
        if lbl == main:
            continue
        area = stats[lbl, cv2.CC_STAT_AREA]
        if 15 <= area <= 8000 and centroids[lbl][1] < 0.45 * h:
            out[labels == lbl] = 255
    return Image.fromarray(out, mode="L")


def process(src: Path, dst: Path, session: ort.InferenceSession) -> None:
    # 复刻 rembg isnet-anime 的前后处理: /max-0.5, 输出 min-max 归一化成 alpha
    img = Image.open(src).convert("RGB")
    bg = bg_color(img)
    im = img.resize((1024, 1024), Image.LANCZOS)
    ary = np.array(im).astype(np.float32)
    ary = ary / np.max(ary) - 0.5
    ary = ary.transpose(2, 0, 1)[None]
    pred = np.squeeze(session.run(None, {session.get_inputs()[0].name: ary})[0])
    pred = (pred - pred.min()) / (pred.max() - pred.min())
    mask = np.array(Image.fromarray((pred * 255).astype(np.uint8), mode="L").resize(
        img.size, Image.LANCZOS)).astype(np.float32) / 255.0
    # 色距兜底: isnet 有时把深色书桌当背景删掉。与边框连通的近底色区域仍按 isnet
    # (白信封等近白色前景由 isnet 保住), 其余近底色以外的像素强制为前景
    rgb = np.array(img).astype(np.float32)
    dist = np.sqrt(((rgb - bg) ** 2).sum(axis=2))
    n, labels = cv2.connectedComponents((dist < 40).astype(np.uint8), connectivity=4)
    border = np.unique(np.concatenate([labels[0], labels[-1], labels[:, 0], labels[:, -1]]))
    flood_bg = np.isin(labels, border[border != 0])
    color_alpha = np.clip((dist - 12) / 28, 0.0, 1.0)
    mask = np.where(flood_bg, mask, np.maximum(mask, color_alpha))
    mask = restore_symbols(img, Image.fromarray((mask * 255).astype(np.uint8), mode="L"))
    # 按采样底色去边: C'=(C-(1-a)*bg)/a
    a = np.array(mask).astype(np.float32)[..., None] / 255.0
    defringed = np.clip((rgb - (1.0 - a) * bg) / np.maximum(a, 1e-6), 0, 255)
    defringed = np.where(a > 0, defringed, rgb)
    out = np.dstack([defringed.astype(np.uint8), np.array(mask)])
    Image.fromarray(out, mode="RGBA").save(dst)


def main() -> int:
    actions = sys.argv[1:] or ACTIONS
    session = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
    for act in actions:
        src = ROOT / act / f"pose-{act}.png"
        if not src.exists():
            print(f"跳过(无选定图): {src}")
            continue
        dst = ROOT / act / f"pose-{act}-transparent.png"
        process(src, dst, session)
        print(f"{act} -> {dst}")
    return 0


if __name__ == "__main__":
    sys.exit(main())