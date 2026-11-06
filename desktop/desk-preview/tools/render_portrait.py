"""Compose the original full-resolution character with dev's art classroom."""
from pathlib import Path
import sys

import bpy


folder = Path(sys.argv[-1]).resolve()
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.engine = "CYCLES"
scene.cycles.samples = 3
scene.view_settings.view_transform = "Standard"
scene.render.resolution_x, scene.render.resolution_y = 960, 1144
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = str(folder / "portrait-sharp.png")

camera_data = bpy.data.cameras.new("Portrait orthographic camera")
camera = bpy.data.objects.new(camera_data.name, camera_data)
scene.collection.objects.link(camera)
camera.location.z = 3
camera_data.type = "ORTHO"
camera_data.ortho_scale = 2
scene.camera = camera
frame = camera_data.view_frame(scene=scene)
x = max(point.x for point in frame)
y = max(point.y for point in frame)

mesh = bpy.data.meshes.new("Portrait plate")
mesh.from_pydata([(-x, -y, 0), (x, -y, 0), (x, y, 0), (-x, y, 0)], [], [(0, 1, 2, 3)])
uv_layer = mesh.uv_layers.new()
for data, uv in zip(uv_layer.data, [(0, 0), (1, 0), (1, 1), (0, 1)], strict=True):
    data.uv = uv
plate = bpy.data.objects.new(mesh.name, mesh)
scene.collection.objects.link(plate)
material = bpy.data.materials.new("Original character and painted classroom")
material.use_nodes = True
mesh.materials.append(material)
nodes, links = material.node_tree.nodes, material.node_tree.links
nodes.clear()
coords = nodes.new("ShaderNodeTexCoord")


def texture(name, scale, offset):
    mapping = nodes.new("ShaderNodeMapping")
    mapping.inputs["Scale"].default_value = (*scale, 1)
    mapping.inputs["Location"].default_value = (*offset, 0)
    links.new(coords.outputs["UV"], mapping.inputs["Vector"])
    node = nodes.new("ShaderNodeTexImage")
    node.image = bpy.data.images.load(str(folder / name))
    node.extension = "CLIP"
    links.new(mapping.outputs["Vector"], node.inputs["Vector"])
    return node


background = texture("scene-ink.png", (.52, .65), (.32, .16))
art = texture("character.png", (480 / 800, 572 / 1200), (190 / 800, 1 - 532 / 1200))
grade = nodes.new("ShaderNodeHueSaturation")
grade.inputs["Saturation"].default_value = .83
grade.inputs["Value"].default_value = .89
links.new(background.outputs["Color"], grade.inputs["Color"])
mix = nodes.new("ShaderNodeMixRGB")
links.new(art.outputs["Alpha"], mix.inputs[0])
links.new(grade.outputs["Color"], mix.inputs[1])
links.new(art.outputs["Color"], mix.inputs[2])
emission = nodes.new("ShaderNodeEmission")
links.new(mix.outputs[0], emission.inputs[0])
output = nodes.new("ShaderNodeOutputMaterial")
links.new(emission.outputs[0], output.inputs["Surface"])
bpy.ops.render.render(write_still=True)
