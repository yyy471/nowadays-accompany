# -*- coding: utf-8 -*-
"""为樱生成全身立绘表情差分包(参照 AnimaVN deepseek-chan 立绘包)。

用法:
  python generate-sakura-sprites.py smile --count 2
  python generate-sakura-sprites.py all --count 2
  python generate-sakura-sprites.py shy --seed 900100 --tag fix1 --height 1344

全身立绘: 头到鞋居中站立, 干净白底(便于后续抠成透明), miaomiao 柔光粉白画风与书桌樱一致。
快速抽卡: 28 steps / cfg 5.5 / euler_ancestral / normal, SaveImage 直连 VAEDecode。
输出: E:\\tmp\\testWorkSpace\\materailPhoto\\characterPhoto\\candidates\\<expr>\\<expr>_s<seed>[_tag].png (+ .json)
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
OUT_ROOT = Path(r"E:\tmp\testWorkSpace\materailPhoto\characterPhoto\candidates")
# 远程生成时设为服务器 ComfyUI output 下的临时文件夹名, 图片经 /view 复制回本地后由 SSH 删除该目录
REMOTE_TMP = ""

NEGATIVE = (
    "lowres, (bad), text, error, extra, missing, worst quality, jpeg artifacts, "
    "low quality, watermark, unfinished, displeasing, oldest, early, signature, "
    "artistic error, username, bad feet, scan, high saturation, abstract, "
    "english text, shiny hair, mutated hands, malformed hands, extra fingers, "
    "bad anatomy, cluttered background, complex room background, furniture in background"
)

# 角色与服装锁定(全身版): 与书桌樱同一形象, 白裙延伸到全身便于差分一致
CHAR_CORE = (
    "score_9, score_7, very aesthetic, masterpiece, best quality, ultra-detailed, "
    "fair_skin, 1girl, solo, long pink hair, curly hair, wavy hair, hair down, "
    "big round eyes, pink eyes, blush, white soft frilled dress, sleeveless, "
    "frill shoulder straps, pink ribbon at waist, knee-length frilled skirt, "
    "white ankle socks, pink mary jane shoes"
)
BODY_SCENE = (
    "full body, standing, head to toe, simple white background, clean background, "
    "soft lighting, looking at viewer"
)

# 24 个表情差分, 对齐 AnimaVN 立绘包的 label/aliases/description/effect 结构
# effect 词表: motion=hop/hop2/shake/shiver/closer/back/sink;
# bubble=exclaim/surprise/question/heart/shy/angry/steam/upset/sweat/tear/sad/sigh/bulb; sound=emo-*/cartoon-1/2
EXPRESSIONS = {
    "smile": {
        "index": "00", "label": "微笑",
        "aliases": ["smile", "说话", "默认", "平静", "normal", "calm", "温柔", "gentle", "安心"],
        "description": "温柔的微笑，默认表情；平常说话、没什么特别情绪时用",
        "effect": None,
        "pose": "gentle smile, closed mouth smile, hands clasped in front, head tilt",
    },
    "love": {
        "index": "01", "label": "喜爱",
        "aliases": ["开心", "happy", "喜欢", "心动", "星星眼", "崇拜", "憧憬", "love"],
        "description": "眼睛冒星星、张嘴笑，真心高兴、满脸喜欢和憧憬",
        "effect": {"motion": "hop", "bubble": "heart", "sound": "emo-heart"},
        "pose": "sparkling eyes, starry eyes, happy open mouth smile, both hands clasped near chest, excited, sparkle",
    },
    "worried": {
        "index": "02", "label": "担心",
        "aliases": ["worried", "害怕", "不安", "忧郁", "失落", "失望"],
        "description": "皱着眉看着你，担心、不安",
        "effect": {"motion": "hop", "bubble": None, "sound": "emo-question"},
        "pose": "worried expression, furrowed brow, slight frown, hands held near chest, concerned",
    },
    "surprised": {
        "index": "03", "label": "惊讶",
        "aliases": ["surprised", "吃惊"],
        "description": "睁大眼睛张着嘴，吃惊",
        "effect": {"motion": "hop", "bubble": "surprise", "sound": "emo-exclaim"},
        "pose": "surprised, wide eyes, open mouth, one hand to mouth, shocked",
    },
    "shy": {
        "index": "04", "label": "害羞",
        "aliases": ["shy", "脸红", "慌张", "flustered", "心虚", "手足无措", "撒娇", "央求", "拜托", "黏人", "pleading"],
        "description": "红着脸，不好意思",
        "effect": {"motion": "back", "bubble": "shy", "sound": "emo-shy"},
        "pose": "shy, heavy blush, bashful, looking away, fingers fidgeting together, embarrassed",
    },
    "confused": {
        "index": "05", "label": "疑惑",
        "aliases": ["confused", "不解", "挠头"],
        "description": "一只手挠着头、歪着脑袋，搞不懂、没听明白",
        "effect": {"motion": None, "bubble": "question", "sound": "emo-question"},
        "pose": "confused, head tilt, one hand scratching head, puzzled, pout",
    },
    "thinking": {
        "index": "06", "label": "思考",
        "aliases": ["thinking", "想想", "琢磨", "深度思考"],
        "description": "食指点着下巴歪头想事情",
        "effect": {"motion": None, "bubble": "bulb", "sound": "emo-bulb"},
        "pose": "thinking, index finger on chin, looking up, thoughtful, head tilt",
    },
    "goofy": {
        "index": "07", "label": "傻笑",
        "aliases": ["憨笑", "嘿嘿"],
        "description": "挠着头闭眼嘿嘿傻笑；被夸了、偷着乐、得意的时候",
        "effect": {"motion": "hop2", "bubble": None, "sound": "cartoon-2"},
        "pose": "goofy grin, closed eyes, sheepish smile, one hand scratching head, laughing",
    },
    "tehepero": {
        "index": "08", "label": "装傻",
        "aliases": ["被骂", "挨批", "萌混过关", "吐舌", "tehepero", "卖萌", "调皮", "wink", "眨眼", "坏笑", "俏皮", "小恶魔"],
        "description": "眨一只眼吐舌头、小拳头轻敲自己的头；萌混过关",
        "effect": {"motion": "hop", "bubble": None, "sound": "emo-sweat"},
        "pose": "tehepero, one eye closed, wink, tongue out, fist tapping own head, playful, sweatdrop",
    },
    "tea": {
        "index": "09", "label": "喝茶",
        "aliases": ["tea", "捧茶", "下午茶", "茶歇", "休息", "放松", "惬意"],
        "description": "双手捧着白瓷茶杯惬意微笑，杯口冒热气；休息、茶歇、放松时",
        "effect": {"motion": "hop2", "bubble": "heart", "sound": "emo-heart"},
        "pose": "holding white ceramic teacup with both hands, content smile, steaming teacup, subtle steam, relaxed",
    },
    "cry": {
        "index": "10", "label": "大哭",
        "aliases": ["cry", "哭", "哭泣", "难过", "sad", "委屈", "掉眼泪", "伤心", "泪流"],
        "description": "掉着眼泪揉眼睛，呜呜哭；难过、委屈、伤心时",
        "effect": {"motion": "shiver", "bubble": "tear", "sound": "emo-tear"},
        "pose": "crying, tears streaming down face, rubbing eyes with fists, sobbing, open mouth wailing, tear drops, sad",
    },
    "angry": {
        "index": "11", "label": "生气",
        "aliases": ["angry", "鼓脸", "气鼓鼓", "吃醋", "闷闷", "不满", "撅嘴", "发脾气"],
        "description": "鼓着脸颊双手叉腰，气鼓鼓；吃醋、不满、闹小脾气时",
        "effect": {"motion": "shake", "bubble": "angry", "sound": "emo-angry"},
        "pose": "angry pout, puffed cheeks, hands on hips, frowning, furrowed brow, anger vein mark, leaning forward slightly",
    },
    "laugh": {
        "index": "12", "label": "大笑",
        "aliases": ["laugh", "哈哈大笑", "开心", "笑出声", "欢乐", "捧腹"],
        "description": "闭眼张嘴哈哈大笑、双手举起；特别开心、笑出声时",
        "effect": {"motion": "hop2", "bubble": None, "sound": "cartoon-1"},
        "pose": "laughing out loud, closed eyes, open mouth big laugh, both arms raised up, joyful, head tilted back slightly",
    },
    "smug": {
        "index": "13", "label": "得意",
        "aliases": ["smug", "哼哼", "骄傲", "邀功", "自满", "神气", "得意洋洋"],
        "description": "抱臂抬下巴、眯眼得意笑；被夸了邀功、小得意时",
        "effect": {"motion": None, "bubble": "steam", "sound": "emo-steam"},
        "pose": "smug smirk, arms crossed, chin up, half-closed eyes, proud expression, confident",
    },
    "wave": {
        "index": "14", "label": "挥手",
        "aliases": ["wave", "打招呼", "你好", "再见", "拜拜", "hi", "hello", "bye", "问候"],
        "description": "举起一只手挥呀挥，笑着打招呼；上线问候、道别时",
        "effect": {"motion": "hop", "bubble": None, "sound": "cartoon-1"},
        "pose": "waving hand, one arm raised waving hello, open palm, cheerful smile, greeting",
    },
    "heart": {
        "index": "15", "label": "比心",
        "aliases": ["heart", "比心", "爱心手势", "给你小心心", "heart hands", "示爱"],
        "description": "双手在胸前比出心形，甜甜笑；表达喜欢、给你小心心",
        "effect": {"motion": "hop", "bubble": "heart", "sound": "emo-heart"},
        "pose": "heart hands, both hands forming heart shape near chest, sweet smile, floating heart symbol",
    },
    "cheer": {
        "index": "16", "label": "加油",
        "aliases": ["cheer", "加油", "握拳", "鼓劲", "打气", "fight", "鼓励", "应援"],
        "description": "举起小拳头给你打气，眼神亮亮的；鼓励、应援、加油时",
        "effect": {"motion": "hop2", "bubble": "exclaim", "sound": "emo-exclaim"},
        "pose": "fist pump, one clenched fist raised up, determined bright smile, cheering, energetic",
    },
    "sleepy": {
        "index": "17", "label": "困倦",
        "aliases": ["sleepy", "困", "哈欠", "想睡", "tired", "熬夜", "晚安", "打盹"],
        "description": "捂嘴打哈欠、眼睛眯起来；困了、深夜、准备休息时",
        "effect": {"motion": "sink", "bubble": "sigh", "sound": "emo-sigh"},
        "pose": "yawning, one hand covering mouth, eyes closed, sleepy tired expression, head tilted",
    },
    "blowkiss": {
        "index": "18", "label": "飞吻",
        "aliases": ["blowkiss", "飞吻", "么么哒", "mua", "亲亲你", "吻"],
        "description": "指尖抵唇送出飞吻、眨一只眼，飘出小爱心；情侣间亲昵道别、撒娇时",
        "effect": {"motion": "closer", "bubble": "heart", "sound": "emo-heart"},
        "pose": "blowing kiss, fingertips to pursed lips, one eye closed wink, small heart floating from fingertips, playful",
    },
    "hug": {
        "index": "19", "label": "求抱抱",
        "aliases": ["hug", "抱抱", "求抱抱", "要抱抱", "张开手", "撒娇", "贴贴"],
        "description": "张开双臂凑向你求抱抱；想你了、撒娇、要安慰时",
        "effect": {"motion": "closer", "bubble": "heart", "sound": "emo-heart"},
        "pose": "arms open wide asking for hug, reaching out toward viewer, warm smile, leaning forward, open arms",
    },
    "hearteyes": {
        "index": "20", "label": "爱心眼",
        "aliases": ["hearteyes", "爱心眼", "心动", "犯花痴", "满眼是你", "着迷", "喜欢死你了"],
        "description": "瞳孔变成爱心、双手捧在胸前，满脸心动；情侣间直白表达喜欢",
        "effect": {"motion": "hop", "bubble": "heart", "sound": "emo-heart"},
        "pose": "heart-shaped pupils, heart eyes, lovestruck, both hands clasped at chest, heavy blush, floating hearts",
    },
    "reach": {
        "index": "21", "label": "牵手",
        "aliases": ["reach", "牵手", "伸出手", "牵牵", "拉手", "一起走", "邀请"],
        "description": "向你伸出手邀请牵手，温柔笑；一起走、约会邀请时",
        "effect": {"motion": "closer", "bubble": "shy", "sound": "emo-shy"},
        "pose": "one hand reaching toward viewer, open palm extended forward, inviting gesture, gentle smile, slight lean forward",
    },
    "letter": {
        "index": "22", "label": "情书",
        "aliases": ["letter", "情书", "告白", "递信", "信封", "表白", "礼物信"],
        "description": "双手递上封着爱心的粉色信笺，红着脸；告白、纪念日、递心意时",
        "effect": {"motion": "back", "bubble": "shy", "sound": "emo-shy"},
        "pose": "holding pink envelope with heart seal, both hands presenting love letter, shy smile, heavy blush",
    },
    "kiss": {
        "index": "23", "label": "亲亲",
        "aliases": ["kiss", "亲亲", "啵", "索吻", "亲一个", "chu"],
        "description": "嘟唇凑近要亲亲，背着手红着脸；情侣间索吻、亲昵时",
        "effect": {"motion": "closer", "bubble": "heart", "sound": "emo-heart"},
        "pose": "puckered lips, closed eyes, leaning forward toward viewer, kiss face, hands clasped behind back, blush, floating hearts",
    },
}

# 第二批新增(推荐 8 + 情侣 6), 供 CLI "new" 只跑新增
NEW_KEYS = [k for k, v in EXPRESSIONS.items() if int(v["index"]) >= 10]


def positive_for(expr: str) -> str:
    return f"{CHAR_CORE}, {EXPRESSIONS[expr]['pose']}, {BODY_SCENE}"


def build_workflow(expr: str, seed: int, width: int, height: int) -> dict:
    return {
        "3": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": 28, "cfg": 5.5,
            "sampler_name": "euler_ancestral", "scheduler": "normal", "denoise": 1.0,
            "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0]}},
        "4": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "miaomiaoRealskin_anima11.safetensors", "weight_dtype": "default"}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {
            "width": width, "height": height, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": positive_for(expr), "clip": ["14", 0]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": NEGATIVE, "clip": ["14", 0]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["15", 0]}},
        "9": {"class_type": "SaveImage", "inputs": {
            "filename_prefix": f"{REMOTE_TMP}/{expr}" if REMOTE_TMP else f"sakura-sprite/{expr}",
            "images": ["8", 0]}},
        "14": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "miaomiaoRealskin_anima11_txt.safetensors", "type": "qwen_image", "device": "default"}},
        "15": {"class_type": "VAELoader", "inputs": {"vae_name": "qwenImage_qwenImageVAE.safetensors"}},
    }


def api_post(path, payload):
    req = urllib.request.Request(BASE_URL + path, data=json.dumps(payload).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_get(path):
    with urllib.request.urlopen(BASE_URL + path, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def wait_result(prompt_id, timeout_s=900):
    start = time.time()
    while time.time() - start < timeout_s:
        hist = api_get(f"/history/{prompt_id}")
        if prompt_id in hist:
            entry = hist[prompt_id]
            if entry.get("status", {}).get("status_str") == "error":
                raise RuntimeError(f"ComfyUI 错误: {json.dumps(entry['status'], ensure_ascii=False)[:2000]}")
            if entry.get("outputs"):
                return entry
        time.sleep(2)
    raise TimeoutError(prompt_id)


def generate_one(expr, seed, tag, width, height):
    wf = build_workflow(expr, seed, width, height)
    prompt_id = api_post("/prompt", {"prompt": wf, "client_id": str(uuid.uuid4())})["prompt_id"]
    print(f"[{expr}] seed={seed} {width}x{height} 提交 {prompt_id}", flush=True)
    t0 = time.time()
    entry = wait_result(prompt_id)
    images = entry["outputs"].get("9", {}).get("images", [])
    if not images:
        raise RuntimeError(f"无输出: {json.dumps(entry['outputs'])[:500]}")
    info = images[0]
    query = urllib.parse.urlencode({"filename": info["filename"],
                                    "subfolder": info.get("subfolder", ""), "type": info["type"]})
    out_dir = OUT_ROOT / expr
    out_dir.mkdir(parents=True, exist_ok=True)
    stem = f"{expr}_s{seed}" + (f"_{tag}" if tag else "")
    out_path = out_dir / f"{stem}.png"
    with urllib.request.urlopen(BASE_URL + "/view?" + query, timeout=60) as resp:
        out_path.write_bytes(resp.read())
    meta = {"expr": expr, "seed": seed, "width": width, "height": height,
            "positive": positive_for(expr), "negative": NEGATIVE, "tag": tag,
            "prompt_id": prompt_id, "base_url": BASE_URL, "remote_tmp": REMOTE_TMP,
            **{k: EXPRESSIONS[expr][k] for k in ("index", "label", "aliases", "description", "effect")}}
    out_path.with_suffix(".json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"[{expr}] 完成 {time.time()-t0:.0f}s -> {out_path}", flush=True)
    return out_path


def main():
    global BASE_URL, REMOTE_TMP
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("expr", choices=[*EXPRESSIONS.keys(), "all", "new"])
    parser.add_argument("--count", type=int, default=1)
    parser.add_argument("--seed", type=int, default=900100, help="固定起始 seed(默认锁同一底利于服装一致), 之后递增")
    parser.add_argument("--tag", default="")
    parser.add_argument("--width", type=int, default=832)
    parser.add_argument("--height", type=int, default=1216)
    parser.add_argument("--base-url", default=BASE_URL, help="ComfyUI 地址, 如 http://192.168.5.3:18188")
    parser.add_argument("--remote-tmp", default="", help="服务器 output 下临时文件夹名, 如 sakura_tmp_20261108")
    args = parser.parse_args()
    BASE_URL = args.base_url.rstrip("/")
    REMOTE_TMP = args.remote_tmp.strip("/")
    exprs = list(EXPRESSIONS.keys()) if args.expr == "all" else NEW_KEYS if args.expr == "new" else [args.expr]
    failures = []
    for expr in exprs:
        for i in range(args.count):
            try:
                generate_one(expr, args.seed + i, args.tag, args.width, args.height)
            except Exception as exc:
                print(f"[{expr}] seed={args.seed+i} 失败: {exc}", flush=True)
                failures.append((expr, str(exc)))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())