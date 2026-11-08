# -*- coding: utf-8 -*-
"""按 ART-GENERATION-GUIDE.md 调用 WSL ComfyUI (miaomiaoRealskin_anima11) 生成樱的 6 个书桌动作图。

用法:
  python generate-sakura-poses.py chatting --count 2
  python generate-sakura-poses.py all --count 2
  python generate-sakura-poses.py reading --seed 12345 --tag fix1

快速抽卡模式: 832x1216 / 28 steps / cfg 5.5 / euler_ancestral / normal,
SaveImage 直连 VAEDecode(节点8), 跳过 13~20 放大链。
输出: E:\\tmp\\testWorkSpace\\materailPhoto\\mainPage\\<pose>\\<pose>_s<seed>[_tag].png (+ 同名 .json 记录提示词与 seed)
"""
import argparse
import json
import random
import sys
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

BASE_URL = "http://127.0.0.1:8188"
OUT_ROOT = Path(r"E:\tmp\testWorkSpace\materailPhoto\mainPage")
# 远程生成时设为服务器 ComfyUI output 下的临时文件夹名, 图片经 /view 复制回本地后由 SSH 删除该目录
REMOTE_TMP = ""

# 负面提示词: 指南通用版, 不改动
NEGATIVE = (
    "lowres, (bad), text, error, extra, missing, worst quality, jpeg artifacts, "
    "low quality, watermark, unfinished, displeasing, oldest, early, signature, "
    "artistic error, username, bad feet, scan, high saturation, abstract, "
    "english text, shiny hair, mutated hands, malformed hands, extra fingers, "
    "bad anatomy, cluttered background, complex room background, furniture in background"
)

# 角色核心标签沿用参考图 wsl-connector_00065_.png 的正面示例, 仅按动作替换姿态/场景部分
CHAR_CORE = (
    "score_9, score_7, very aesthetic, masterpiece, best quality, ultra-detailed, "
    "fair_skin, high contrast, 1girl, solo, long pink hair, curly hair, wavy hair, "
    "hair down, big round eyes, pink eyes, blush, white soft dress, frills"
)
# 背景用纯白底(原 pastel 奶油底抠图发边严重), 其余受光/桌面标签不动
DAY_SCENE = (
    "sitting at wooden desk, upper body, sunlight from left, soft rim light, "
    "simple white background, clean white background, soft lighting"
)

POSES = {
    "chatting": (
        "gentle smile, closed mouth smile, head tilt, finger to cheek, "
        "one elbow resting on wooden desk, open notebook on desk, "
        "looking at viewer, eye contact, sparkle"
    ),
    "reading": (
        "reading a book, looking down at book, eyes cast down, head down, "
        "both hands resting on open book pages, open hardcover book on wooden desk, "
        "leaning forward slightly, peaceful expression, closed mouth, lowered eyelashes"
    ),
    "writing": (
        "head down, looking down at paper, eyes cast down, focused on writing, "
        "writing on letter paper, holding fountain pen, open notebook on wooden desk, "
        "one hand pressing paper, leaning over desk, focused expression, cute slight pout"
    ),
    "tea": (
        "serene expression, gentle smile, holding a white ceramic teacup with both hands near chin, "
        "steaming teacup, subtle steam, elbows resting on wooden desk, "
        "looking to the side, looking left"
    ),
    "sharing": (
        "happy smile, parted lips, sparkling eyes, excited expression, "
        "holding a wax-sealed envelope letter in hands above wooden desk, "
        "showing letter to viewer, looking at viewer, eye contact, sparkle"
    ),
    "night": (
        "sleepy gentle smile, half-closed eyes, soft gaze, oversized pale pink knitted cardigan, "
        "resting head on arms on wooden desk, leaning on desk, open book beside arm, "
        "looking at viewer, warm amber lamplight from lower left, face softly lit by lamplight, "
        "faint cool moonlight rim light from left, "
        "simple white background, clean white background"
    ),
}


def positive_for(pose: str) -> str:
    if pose == "night":
        return f"{CHAR_CORE}, {POSES[pose]}"
    return f"{CHAR_CORE}, {POSES[pose]}, {DAY_SCENE}"


def build_workflow(pose: str, seed: int) -> dict:
    return {
        "3": {
            "class_type": "KSampler",
            "inputs": {
                "seed": seed, "steps": 28, "cfg": 5.5,
                "sampler_name": "euler_ancestral", "scheduler": "normal", "denoise": 1.0,
                "model": ["4", 0], "positive": ["6", 0],
                "negative": ["7", 0], "latent_image": ["5", 0],
            },
        },
        "4": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "miaomiaoRealskin_anima11.safetensors", "weight_dtype": "default"}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {
            "width": 832, "height": 1216, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {
            "text": positive_for(pose), "clip": ["14", 0]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {
            "text": NEGATIVE, "clip": ["14", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["15", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {
            "filename_prefix": f"{REMOTE_TMP}/{pose}" if REMOTE_TMP else f"sakura/{pose}",
            "images": ["8", 0]}},
        "14": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "miaomiaoRealskin_anima11_txt.safetensors",
            "type": "qwen_image", "device": "default"}},
        "15": {"class_type": "VAELoader", "inputs": {
            "vae_name": "qwenImage_qwenImageVAE.safetensors"}},
    }


def api_post(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        BASE_URL + path, data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_get(path: str) -> dict:
    with urllib.request.urlopen(BASE_URL + path, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_result(prompt_id: str, timeout_s: int = 900) -> dict:
    start = time.time()
    while time.time() - start < timeout_s:
        hist = api_get(f"/history/{prompt_id}")
        if prompt_id in hist:
            entry = hist[prompt_id]
            status = entry.get("status", {})
            if status.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI 执行错误: {json.dumps(status, ensure_ascii=False)[:2000]}")
            if entry.get("outputs"):
                return entry
        time.sleep(2)
    raise TimeoutError(f"等待超时: {prompt_id}")


def generate_one(pose: str, seed: int, tag: str) -> Path:
    wf = build_workflow(pose, seed)
    submit = api_post("/prompt", {"prompt": wf, "client_id": str(uuid.uuid4())})
    prompt_id = submit["prompt_id"]
    print(f"[{pose}] seed={seed} 已提交 prompt_id={prompt_id}", flush=True)
    t0 = time.time()
    entry = wait_result(prompt_id)
    images = entry["outputs"].get("9", {}).get("images", [])
    if not images:
        raise RuntimeError(f"无输出图片: {json.dumps(entry['outputs'])[:500]}")
    info = images[0]
    query = urllib.parse.urlencode({
        "filename": info["filename"], "subfolder": info.get("subfolder", ""), "type": info["type"]})
    out_dir = OUT_ROOT / pose
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{pose}_s{seed}" + (f"_{tag}" if tag else "")
    out_path = out_dir / f"{stem}.png"
    with urllib.request.urlopen(BASE_URL + "/view?" + query, timeout=60) as resp:
        out_path.write_bytes(resp.read())
    meta = {
        "pose": pose, "seed": seed, "positive": positive_for(pose), "negative": NEGATIVE,
        "workflow": "fast-832x1216-28steps-cfg5.5-euler_ancestral-normal",
        "prompt_id": prompt_id, "tag": tag, "base_url": BASE_URL, "remote_tmp": REMOTE_TMP,
    }
    out_path.with_suffix(".json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[{pose}] 完成 耗时{time.time()-t0:.0f}s -> {out_path}", flush=True)
    return out_path


def main() -> int:
    global BASE_URL, REMOTE_TMP
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("pose", choices=[*POSES.keys(), "all"])
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--seed", type=int, default=None, help="固定起始 seed, 之后递增")
    parser.add_argument("--tag", default="", help="文件名后缀标记, 如 fix1")
    parser.add_argument("--base-url", default=BASE_URL, help="ComfyUI 地址, 如 http://192.168.5.3:18188")
    parser.add_argument("--remote-tmp", default="", help="服务器 output 下临时文件夹名, 如 sakura_tmp_20261108")
    args = parser.parse_args()

    BASE_URL = args.base_url.rstrip("/")
    REMOTE_TMP = args.remote_tmp.strip("/")

    poses = list(POSES.keys()) if args.pose == "all" else [args.pose]
    base_seed = args.seed if args.seed is not None else random.randint(1, 2**53)
    failures = []
    for pose in poses:
        for i in range(args.count):
            seed = base_seed + i
            try:
                generate_one(pose, seed, args.tag)
            except Exception as exc:
                print(f"[{pose}] seed={seed} 失败: {exc}", flush=True)
                failures.append((pose, seed, str(exc)))
    if failures:
        print(f"共 {len(failures)} 个失败", flush=True)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())