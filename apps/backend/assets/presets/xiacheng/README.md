# 夏澄系统预置服饰资源位置

本目录为主角色席位（`builtin_key = "xiacheng"`）提供夏澄的初始外观。后端通过配置 `presetAssetsDir`（环境变量 `NOWADAYS_PRESET_ASSETS_DIR` / 启动参数 `--preset-assets-dir`，默认指向本目录的上级 `backend/assets/presets`）读取播种素材。

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

1. `outfits/default/` 会在首次播种时优先排序并在角色当前未选服饰时自动激活为默认穿着（`state.outfitId`）；其余 `outfits/<slug>/` 子目录均作为预置服饰（`isPreset: true`）载入衣柜。
2. 首次初始化及中断恢复时读取目录与 `manifest.json`。缺少有效图片时保留无图空态。已就绪的席位在重启时直接使用保存的外观，之后更新本目录只影响新初始化的席位。
3. 用户可在角色配置的「外观」分区维护预置和自添服饰、立绘与差分。`isPreset` 标记素材来源。删除服饰须至少保留一套，历史句段引用的图片保留供回放。
