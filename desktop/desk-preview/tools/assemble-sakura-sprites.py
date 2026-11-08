# -*- coding: utf-8 -*-
"""把选定的樱立绘候选组装成 AnimaVN 风格立绘包(需在 WSL comfyui 环境跑, 用 cv2 算 face_scan)。

用法(WSL):
  /home/yang/miniforge3/envs/comfyui/bin/python assemble-sakura-sprites.py \
      smile=smile_s900100 love=love_s900100 worried=worried_s900100 ...

每个参数是 expr=候选文件名(不含扩展名), 从 candidates/<expr>/<stem>.png(+.json) 读取。
输出: characterPhoto/sprites/<index>.png(isnet-anime 去白底成透明 RGBA) 与 characterPhoto/sprites.json
sprites.json 结构对齐 AnimaVN: file/label/aliases/description/effect/face_scan。
"""
import json
import re
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path("/mnt/e/tmp/testWorkSpace/materailPhoto/characterPhoto")
CAND = ROOT / "candidates"
OUT = ROOT / "sprites"
CASCADE = "/mnt/e/tmp/testWorkSpace/AnimaVN-main/AnimaBackend/app/assets/lbpcascade_animeface.xml"
MODEL = "/mnt/e/tmp/testWorkSpace/materailPhoto/_models/isnet-anime.onnx"

# 仰头大笑等级联检不出的姿势, 人工标定的脸框(像素, 基于 832x1216)
MANUAL_FACE = {"laugh": (350, 100, 200, 180)}


def face_scan(png_path: Path, expr: str) -> dict:
    img = cv2.imread(str(png_path))
    h, w = img.shape[:2]
    if expr in MANUAL_FACE:
        fx, fy, fw, fh = MANUAL_FACE[expr]
        return {"width": w, "height": h,
                "face": {"x": round(fx / w, 4), "y": round(fy / h, 4),
                         "w": round(fw / w, 4), "h": round(fh / h, 4)}}
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    casc = cv2.CascadeClassifier(CASCADE)
    faces = casc.detectMultiScale(cv2.equalizeHist(gray), scaleFactor=1.05,
                                  minNeighbors=3, minSize=(60, 60))
    if not len(faces):
        faces = casc.detectMultiScale(gray, scaleFactor=1.03,
                                      minNeighbors=2, minSize=(50, 50))
    if len(faces):
        # 取面积最大的人脸框
        fx, fy, fw, fh = max(faces.tolist(), key=lambda b: b[2] * b[3])
        face = {"x": round(fx / w, 4), "y": round(fy / h, 4),
                "w": round(fw / w, 4), "h": round(fh / h, 4)}
    else:
        face = None
    return {"width": w, "height": h, "face": face}


def restore_symbols(img: Image.Image, mask: Image.Image) -> Image.Image:
    # 抠图模型会丢掉问号/汗滴等离体符号: 原图中非白色且不与主体相连的小连通域恢复为不透明
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


def remove_bg(png_path: Path, session: ort.InferenceSession) -> None:
    # 复刻 rembg isnet-anime 的前后处理: /max-0.5, 输出 min-max 归一化成 alpha
    img = Image.open(png_path).convert("RGB")
    im = img.resize((1024, 1024), Image.LANCZOS)
    ary = np.array(im).astype(np.float32)
    ary = ary / np.max(ary) - 0.5
    ary = ary.transpose(2, 0, 1)[None]
    pred = np.squeeze(session.run(None, {session.get_inputs()[0].name: ary})[0])
    pred = (pred - pred.min()) / (pred.max() - pred.min())
    mask = Image.fromarray((pred * 255).astype(np.uint8), mode="L").resize(
        img.size, Image.LANCZOS)
    mask = restore_symbols(img, mask)
    rgba = img.convert("RGBA")
    rgba.putalpha(mask)
    # 去白边: 半透明边缘像素按 C=(C-(1-a)*255)/a 去掉白底贡献
    a = np.array(mask).astype(np.float32)[..., None] / 255.0
    rgb = np.array(img).astype(np.float32)
    defringed = np.clip((rgb - 255.0 * (1.0 - a)) / np.maximum(a, 1e-6), 0, 255)
    defringed = np.where(a > 0, defringed, rgb)
    rgba = Image.fromarray(
        np.dstack([defringed.astype(np.uint8), np.array(mask)]), mode="RGBA")
    rgba.save(png_path)


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    session = ort.InferenceSession(MODEL, providers=["CPUExecutionProvider"])
    entries = []
    for arg in sys.argv[1:]:
        expr, stem = re.split(r"[=:]", arg, maxsplit=1)
        src_png = CAND / expr / f"{stem}.png"
        src_json = CAND / expr / f"{stem}.json"
        if not src_png.exists() or not src_json.exists():
            print(f"缺少候选: {src_png} / {src_json}")
            return 1
        meta = json.loads(src_json.read_text(encoding="utf-8"))
        index = meta["index"]
        dst_png = OUT / f"{index}.png"
        shutil.copyfile(src_png, dst_png)
        entry = {
            "file": f"{index}.png",
            "label": meta["label"],
            "aliases": meta["aliases"],
            "description": meta["description"],
            "effect": meta["effect"],
            "face_scan": face_scan(dst_png, expr),
        }
        remove_bg(dst_png, session)
        entries.append((index, entry))
        print(f"{index} {meta['label']} <- {stem}  face={entry['face_scan']['face']}")
    entries.sort(key=lambda t: t[0])
    sprites = [e for _, e in entries]
    (ROOT / "sprites.json").write_text(
        json.dumps(sprites, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已写 {ROOT / 'sprites.json'} 共 {len(sprites)} 张")
    return 0


if __name__ == "__main__":
    sys.exit(main())