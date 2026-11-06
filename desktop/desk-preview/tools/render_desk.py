"""Export registered desk plates from the existing courtyard Blender project."""
import json
from pathlib import Path
import sys

import bpy
from bpy_extras.object_utils import world_to_camera_view
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
from desk_art import add_plush_fill, refine_desk, refine_window


import argparse


parser = argparse.ArgumentParser()
parser.add_argument("source", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--only", nargs="+", choices=("day", "dawn", "dusk", "cloud", "rain", "night", "wet-night", "snow", "snow-night"))
parser.add_argument("--snow", type=Path)
parser.add_argument("--room-only", action="store_true")
args = parser.parse_args(sys.argv[1:])
source, output = args.source, args.output
output.mkdir(parents=True, exist_ok=True)
bpy.ops.wm.open_mainfile(filepath=str(source.resolve()))
scenes = list(bpy.data.scenes)
day, rain, night = scenes
camera = day.camera
camera.data.lens = 70
camera.rotation_euler = (Vector((0, 2.47, 1.89)) - camera.location).to_track_quat("-Z", "Y").to_euler()


def point(world):
    position = world_to_camera_view(day, camera, world)
    return [round(position.x * 100, 4), round((1 - position.y) * 100, 4)]


def projected_vertices(obj):
    return [point(obj.matrix_world @ vertex.co) for vertex in obj.data.vertices]


def bounds(*objects):
    vertices = [point(obj.matrix_world @ Vector(corner)) for obj in objects for corner in obj.bound_box]
    left, right = min(x for x, _ in vertices), max(x for x, _ in vertices)
    top, bottom = min(y for _, y in vertices), max(y for _, y in vertices)
    return [left, top, right - left, bottom - top]


objects = day.objects
memo = refine_desk(day, night)
refine_window(day)
bpy.context.view_layer.update()
plush = objects["Plush • original character cutout"]
plush_region = [52.6, 53.4, 13.6, 27.1]
anchors = {
    "portrait": projected_vertices(objects["Original portrait print"]),
    "photo": bounds(objects["Polaroid paper frame"]),
    "caption": point(objects["Photo caption"].location),
    "plush": bounds(plush),
    "plushRegion": plush_region,
    "memo": bounds(memo),
    "clock": bounds(objects["Clock • smoked glass display"]),
    "calendar": bounds(objects["Calendar page"]),
    "roles": bounds(objects["Small instant print • paper border"], objects["Small instant print • paper border.001"]),
    "lamp": bounds(objects["Lamp • rolled metal shade"]),
    "books": [bounds(obj) for obj in sorted(
        (obj for obj in objects if obj.name.endswith("volume • spine")),
        key=lambda obj: obj.location.x,
    )],
    "cup": bounds(objects["Ceramic mug • rolled rim, blue inlay and foot"]),
    "window": [0, 1.1, 24.2, 59.1],
    "panes": [[0, 1.1, 10.30, 58.5], [11.28, 1.1, 12.39, 58.5]],
}
(output / "anchors.json").write_text(json.dumps(anchors, indent=2), encoding="utf-8")
for name in ("photo-day.webp", "photo-ayou.webp", "plush.webp", "character.png", "courtyard-window.png"):
    image = bpy.data.images[name]
    (output / name).write_bytes(image.packed_file.data)

for obj in list(bpy.data.objects):
    if obj.name.startswith(("Wall tag", "Clock display digits", "Rain trail")) or obj.name in {
        "Photo caption", "Calendar number", "Original portrait print", "Plush • original character cutout"
    }:
        obj.hide_render = True

practical = next(collection for collection in bpy.data.collections if collection.name.startswith("Desk lamp •"))
for scene in scenes:
    if scene != night:
        scene.collection.children.link(practical)
        scene.view_layers[0].lightgroups.add(name="Desk lamp")
    scene.render.resolution_percentage = 75
    scene.cycles.samples = 44
    scene.render.image_settings.file_format = "PNG"
night.objects["Cool room fill"].data.energy *= 1.30
add_plush_fill(night, plush, night.collection, "Plush • soft sky bounce", 17, (.79, .86, 1), "Sky and room bounce")
add_plush_fill(night, plush, practical, "Plush • warm practical bounce", 27, (1, .84, .69), "Desk lamp")


def exterior_nodes(scene):
    exterior = next(obj for obj in scene.objects if obj.name.startswith("Exterior"))
    return exterior.active_material.node_tree.nodes


def render(key, scene):
    if args.only and key not in args.only:
        return
    for lamp in ("off", "on"):
        practical.hide_render = lamp == "off"
        settings = scene.render
        settings.use_border = False
        settings.image_settings.color_mode = "RGB"
        plush.hide_render = True
        settings.filepath = str(output / f"{key}-{lamp}.png")
        bpy.ops.render.render(write_still=True, scene=scene.name)
        if args.room_only:
            continue
        x, y, w, h = plush_region
        settings.use_border = True
        settings.use_crop_to_border = True
        settings.border_min_x, settings.border_max_x = x / 100, (x + w) / 100
        settings.border_min_y, settings.border_max_y = 1 - (y + h) / 100, 1 - y / 100
        plush.hide_render = False
        camera_objects = [obj for obj in scene.objects if obj != plush and obj.visible_camera]
        for obj in camera_objects:
            obj.visible_camera = False
        compositor = settings.use_compositing
        settings.use_compositing = False
        settings.film_transparent = True
        settings.image_settings.color_mode = "RGBA"
        settings.filepath = str(output / f"plush-{key}-{lamp}.png")
        try:
            bpy.ops.render.render(write_still=True, scene=scene.name)
        finally:
            settings.use_compositing = compositor
            settings.film_transparent = False
            for obj in camera_objects:
                obj.visible_camera = True


render("day", day)
render("rain", rain)
render("cloud", rain)
render("night", night)
wet_sky = exterior_nodes(night)
wet_sky.get("Hue/Saturation/Value").inputs["Saturation"].default_value = .18
next(node for node in wet_sky if node.type == "EMISSION").inputs["Strength"].default_value *= .75
night.objects["Cool room fill"].data.energy *= .82
render("wet-night", night)

if args.snow:
    image = bpy.data.images.load(str(args.snow.resolve()))
    for key, scene in (("snow", rain), ("snow-night", night)):
        nodes = exterior_nodes(scene)
        next(node for node in nodes if node.type == "TEX_IMAGE").image = image
        nodes.get("Hue/Saturation/Value").inputs["Saturation"].default_value = .68
        render(key, scene)

sun = day.objects["Low afternoon sun"]
sun_data = sun.data
sky = next(obj for obj in day.objects if obj.name.startswith("Diffuse sky"))
day_lights = {obj.name: obj.data.energy for obj in day.objects
              if obj.type == "LIGHT" and obj not in practical.objects.values()}
sky_nodes = exterior_nodes(day)
sky_tint = next(node for node in sky_nodes if node.type == "MIX_RGB")
sky_emission = next(node for node in sky_nodes if node.type == "EMISSION")

for key, energy, color, tint, elevation, sky_strength in (
    ("dawn", .24, (1, .71, .58), (.90, .85, 1), 3.65, .46),
    ("dusk", .55, (1, .54, .29), (1, .77, .68), 4.55, .61),
):
    for name, strength in day_lights.items():
        day.objects[name].data.energy = strength * (.57 if key == "dawn" else .66)
    sun_data.energy = day_lights[sun.name] * energy
    sun_data.color = color
    sun.rotation_euler = (Vector((1, -5, .4)) - Vector((-9, 6, elevation))).to_track_quat("-Z", "Y").to_euler()
    sky.data.color = (.72, .81, 1) if key == "dawn" else (1, .80, .73)
    sky_tint.inputs[2].default_value = (*tint, 1)
    sky_emission.inputs["Strength"].default_value = sky_strength
    render(key, day)
