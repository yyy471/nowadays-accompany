# 夏澄系统预置服饰资源位置

本目录为系统默认助手「夏澄（`builtin_key = "xiacheng"`）」的预置外观目录，打包与启动时由后端配置 `presetAssetsDir`（环境变量 `NOWADAYS_PRESET_ASSETS_DIR` / 启动参数 `--preset-assets-dir`，默认指向本目录的上级 `backend/assets/presets`）自动加载。

## 当前已配置套系

```text
backend/assets/presets/xiacheng/
├── README.md
└── outfits/
    ├── default/                # 默认激活套系：「日常常服」
    │   ├── manifest.json       # 服饰名称、说明与 spriteNames 中文展示名映射
    │   ├── home.png            # 主页立绘（支持 home.png / home.jpg / home.jpeg / home.webp）
    │   └── sprites/            # 19 张 1024×1536 透明 PNG 差分（英文文件名 + manifest.json 映射中文展示名）
    └── 02_weaver/              # 第二套预置服饰：「时序织梦」
        ├── manifest.json
        ├── home.png
        └── sprites/
```

## 说明

1. `outfits/default/` 会在启动时优先排序并在角色当前未选服饰时自动激活为默认穿着（`state.outfitId`）；其余 `outfits/<slug>/` 子目录均作为预置服饰（`isPreset: true`）载入衣柜。
2. 当某套预置目录中尚无有效图片时，默认保持无图空态；放入或更新图片并重启后端后会自动同步最新立绘、差分图片及 `manifest.json` 中的中文展示名，历史句段已引用的旧预置图会受管保留。
3. 运行中的用户仍可在界面中为夏澄**新增自定义服饰**（`isPreset: false`），预置服饰及其素材本身禁止改名、替换、覆盖上传或删除（返回 `409 PRESET_APPEARANCE_LOCKED`）。
