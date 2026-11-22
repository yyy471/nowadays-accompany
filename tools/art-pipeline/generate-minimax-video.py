# -*- coding: utf-8 -*-
"""用局域网 ComfyUI 的 MiniMax H3 把首帧图生成带音频视频, 分两段做 4x-UltraSharp 超分。

低配约束 (4080S 16G / WSL 15.8G): 分块 FF + 低显存注意力 + TE-Speed 缓存加速
-> res_multistep/simple 20 步 -> 分块 VAE 解码 -> 先存原生视频;
第二段单独加载视频做 4x 超分降采样(默认 2x), 避免 H3 模型占显存时超分 OOM。

用法:
  python generate-minimax-video.py --image <首帧图> [--name sakura_test]
         [--width 768 --height 1152 --length 124 --steps 20] [--scale 2] [--seed 42]
         [--prompt "..."] [--base-url http://192.168.5.3:18190]
输出: E:\\tmp\\testWorkSpace\\desktopWsl\\minimax\\<name>.mp4 (及 <name>_native.mp4)
"""
import argparse
import json
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

BASE_URL = "http://192.168.5.3:18188"
OUT_DIR = Path(r"E:\tmp\testWorkSpace\desktopWsl\minimax")
INPUT_NAME = "sakura_first.png"

UNET = "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
CLIP = "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors"
VAE_VIDEO = "minimax_h3_video_vae_fp16.safetensors"
VAE_AUDIO = "minimax_h3_audio_vae_fp32.safetensors"
UPSCALE = "RealESRGAN_x2plus.pth"

DEFAULT_PROMPT = """Soft pastel anime illustration, cozy bedroom in warm morning sunlight. A gentle teenage girl with long wavy pink hair, white frilled dress with a pink ribbon at the waist, stands facing the camera with her hands relaxed at her sides.

Storyboard:
[0s-1.5s] Medium shot: she breathes softly, her chest rises and falls gently, she blinks naturally, a few strands of hair sway in a gentle window breeze. Camera slowly pushes in.
[1.5s-3.5s] The camera continues a slow dolly-in toward her face; she tilts her head slightly and gives a shy warm smile, her eyes stay on the viewer, sunlight shifts softly across her hair.
[3.5s-5s] She gently clasps her hands in front of her waist, smiling; warm dust motes drift in the light, shallow depth of field, stable character identity.

Camera: slow dolly-in, subtle handheld micro-movement, 35mm lens look, shallow depth of field, no cuts, no morphing.
Audio: quiet morning room tone, soft piano melody, faint birdsong outside the window."""


def upload_file(path: Path, name: str) -> None:
    boundary = "----sakura" + uuid.uuid4().hex
    body = b""
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"image\"; "
             f"filename=\"{name}\"\r\nContent-Type: application/octet-stream\r\n\r\n").encode()
    body += path.read_bytes() + b"\r\n"
    body += (f"--{boundary}\r\nContent-Disposition: form-data; name=\"overwrite\"\r\n\r\n"
             f"true\r\n").encode()
    body += f"--{boundary}--\r\n".encode()
    req = urllib.request.Request(
        BASE_URL + "/upload/image", data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    urllib.request.urlopen(req, timeout=600).read()


def build_gen_workflow(a: argparse.Namespace) -> dict:
    return {
        "1": {"class_type": "LoadImage", "inputs": {"image": INPUT_NAME}},
        "2": {"class_type": "ImageScale", "inputs": {
            "image": ["1", 0], "upscale_method": "lanczos",
            "width": a.width, "height": a.height, "crop": "center"}},
        "3": {"class_type": "UNETLoader", "inputs": {"unet_name": UNET, "weight_dtype": "default"}},
        "4": {"class_type": "MiniMaxChunkFeedForward", "inputs": {
            "model": ["3", 0], "chunks": 2, "seq_threshold": 4096}},
        "5": {"class_type": "MiniMaxLowVRAMAttention", "inputs": {"model": ["4", 0], "head_chunks": 4}},
        "6": {"class_type": "TESpeedMiniMaxH3", "inputs": {
            "model": ["5", 0], "processing_control_value": 0.12,
            "processing_percent_1": 0.1, "processing_percent_2": 0.9, "mcs": 2,
            "device": "auto", "cache_depth": 0.75}},
        "7": {"class_type": "CLIPLoader", "inputs": {"clip_name": a.clip, "type": "minimax", "device": "default"}},
        "8": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_VIDEO}},
        "9": {"class_type": "VAELoader", "inputs": {"vae_name": VAE_AUDIO}},
        "10": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {
            "clip": ["7", 0], "vae": ["8", 0], "prompt": a.prompt,
            "width": a.width, "height": a.height, "length": a.length,
            "first_frame": ["2", 0]}},
        "11": {"class_type": "BasicGuider", "inputs": {"model": ["6", 0], "conditioning": ["10", 0]}},
        "12": {"class_type": "BasicScheduler", "inputs": {
            "model": ["6", 0], "scheduler": "simple", "steps": a.steps, "denoise": 1.0}},
        "13": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
        "14": {"class_type": "RandomNoise", "inputs": {"noise_seed": a.seed}},
        "15": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["14", 0], "guider": ["11", 0], "sampler": ["13", 0],
            "sigmas": ["12", 0], "latent_image": ["10", 1]}},
        "16": {"class_type": "VAEDecodeTiled", "inputs": {
            "samples": ["15", 0], "vae": ["8", 0], "tile_size": 512,
            "overlap": 64, "temporal_size": 16, "temporal_overlap": 4}},
        # 音频 VAE 不支持分块解码(VAEDecodeAudioTiled 形状不匹配), 用普通解码
        "17": {"class_type": "VAEDecodeAudio", "inputs": {
            "samples": ["15", 0], "vae": ["9", 0]}},
        "20": {"class_type": "CreateVideo", "inputs": {
            "images": ["16", 0], "fps": 24, "audio": ["17", 0]}},
        "21": {"class_type": "SaveVideo", "inputs": {
            "video": ["20", 0], "filename_prefix": f"video/{a.name}_native", "format": "auto"}},
    }


def build_upscale_workflow(a: argparse.Namespace) -> dict:
    native = f"{a.name}_native.mp4"
    return {
        "30": {"class_type": "LoadVideo", "inputs": {"file": native}},
        "31": {"class_type": "GetVideoComponents", "inputs": {"video": ["30", 0]}},
        "32": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": a.upscale_model}},
        "33": {"class_type": "ImageUpscaleWithModelBatched", "inputs": {
            "upscale_model": ["32", 0], "images": ["31", 0], "per_batch": 8,
            # 2x 模型放大后按 scale/2 降采样, 默认得到 2 倍分辨率
            "downscale_ratio": a.scale / 2.0, "downscale_method": "lanczos",
            "precision": "float16"}},
        "34": {"class_type": "CreateVideo", "inputs": {
            "images": ["33", 0], "fps": ["31", 2], "audio": ["31", 1]}},
        "35": {"class_type": "SaveVideo", "inputs": {
            "video": ["34", 0], "filename_prefix": f"video/{a.name}", "format": "auto"}},
    }


def api(path, payload=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(
        BASE_URL + path, data=data, method="POST" if data else "GET",
        headers={"Content-Type": "application/json"} if data else {})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def run_workflow(wf: dict, save_node: str, timeout_s: int) -> dict:
    pid = api("/prompt", {"prompt": wf, "client_id": str(uuid.uuid4())})["prompt_id"]
    print(f"已提交 prompt_id={pid}", flush=True)
    t0 = time.time()
    while True:
        hist = api(f"/history/{pid}")
        if pid in hist:
            entry = hist[pid]
            if entry.get("status", {}).get("status_str") == "error":
                raise RuntimeError(json.dumps(entry["status"], ensure_ascii=False)[:3000])
            if entry.get("outputs"):
                outs = entry["outputs"].get(save_node, {})
                items = outs.get("images") or outs.get("videos") or []
                if items:
                    print(f"完成 {time.time()-t0:.0f}s", flush=True)
                    return items[0]
        if time.time() - t0 > timeout_s:
            raise TimeoutError("等待超时")
        time.sleep(5)


def download(info: dict, dst: Path) -> None:
    q = urllib.parse.urlencode({"filename": info["filename"],
                                "subfolder": info.get("subfolder", ""), "type": info["type"]})
    with urllib.request.urlopen(BASE_URL + "/view?" + q, timeout=600) as resp:
        dst.write_bytes(resp.read())


def main() -> int:
    global BASE_URL
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--image", default=None, help="首帧图(生成模式必填)")
    p.add_argument("--upscale-video", default=None, help="直接超分已有视频, 跳过生成")
    p.add_argument("--name", default="sakura_h3")
    p.add_argument("--prompt", default=DEFAULT_PROMPT)
    p.add_argument("--width", type=int, default=768)
    p.add_argument("--height", type=int, default=1152)
    p.add_argument("--length", type=int, default=124)
    p.add_argument("--steps", type=int, default=20)
    p.add_argument("--scale", type=float, default=2.0)
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--clip", default=CLIP)
    p.add_argument("--upscale-model", default=UPSCALE)
    p.add_argument("--upscale-only", action="store_true", help="跳过生成, 只对已有原生视频超分")
    p.add_argument("--base-url", default=BASE_URL)
    a = p.parse_args()

    BASE_URL = a.base_url.rstrip("/")
    OUT_DIR.mkdir(parents=True, exist_ok=True)

    native_path = OUT_DIR / f"{a.name}_native.mp4"
    if a.upscale_video:
        upload_file(Path(a.upscale_video), f"{a.name}_native.mp4")
        print(f"输入视频已上传: {a.upscale_video}", flush=True)
    elif a.upscale_only:
        if not native_path.exists():
            raise SystemExit(f"缺少原生视频: {native_path}")
        print(f"仅超分: {native_path}", flush=True)
    else:
        if not a.image:
            raise SystemExit("生成模式需要 --image")
        upload_file(Path(a.image), INPUT_NAME)
        print("首帧已上传", flush=True)

        native_info = run_workflow(build_gen_workflow(a), "21", timeout_s=3600)
        download(native_info, native_path)
        print(f"原生视频 -> {native_path}", flush=True)

    if a.scale > 1.0:
        if not a.upscale_video:
            upload_file(native_path, f"{a.name}_native.mp4")
        print("开始超分", flush=True)
        final_info = run_workflow(build_upscale_workflow(a), "35", timeout_s=1800)
        final_path = OUT_DIR / f"{a.name}.mp4"
        download(final_info, final_path)
        print(f"超分完成 -> {final_path}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())