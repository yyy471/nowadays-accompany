"""Scene refinements for the existing desk, shared by every light plate."""
import math
from pathlib import Path

import bmesh
import bpy
from mathutils import Vector


BOOK_TITLES = ("活动记录", "角色相册", "角色资料", "模型配置", "技能与连接", "应用设置")


def material(name, color, roughness=.64):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    shader = mat.node_tree.nodes.get("Principled BSDF")
    shader.inputs["Base Color"].default_value = (*color, 1)
    shader.inputs["Roughness"].default_value = roughness
    return mat


def mesh(group, name, vertices, faces, mat):
    data = bpy.data.meshes.new(name)
    data.from_pydata(vertices, [], faces)
    data.update()
    obj = bpy.data.objects.new(name, data)
    group.objects.link(obj)
    data.materials.append(mat)
    return obj


def branch(group, name, points, width, mat):
    data = bpy.data.curves.new(name, "CURVE")
    data.dimensions = "3D"
    data.bevel_depth = width
    data.bevel_resolution = 3
    spline = data.splines.new("BEZIER")
    spline.bezier_points.add(len(points) - 1)
    for point, position in zip(spline.bezier_points, points, strict=True):
        point.co = position
        point.handle_left_type = point.handle_right_type = "AUTO"
    obj = bpy.data.objects.new(name, data)
    group.objects.link(obj)
    data.materials.append(mat)


def seed(group, name, center, normal, radius, depth, mat):
    data = bpy.data.meshes.new(name)
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=8, radius=1)
    bm.to_mesh(data)
    bm.free()
    obj = bpy.data.objects.new(name, data)
    group.objects.link(obj)
    obj.location = center
    obj.scale = (radius, radius, depth)
    obj.rotation_euler = normal.to_track_quat("Z", "Y").to_euler()
    for polygon in data.polygons:
        polygon.use_smooth = True
    data.materials.append(mat)


def replace_bouquet(scene):
    for obj in scene.objects:
        if obj.name.startswith(("Reed stem", "Pampas fiber", "Maple stem", "Maple leaf")):
            obj.hide_render = True
    vase = scene.objects["Vase • sage stoneware"]
    group = vase.users_collection[0]
    origin = vase.location.copy()
    stem = material("Cosmos • sage stems", (.10, .17, .072))
    leaf = material("Cosmos • leaf", (.105, .20, .081))
    ivory = material("Cosmos • ivory petals", (.89, .72, .52))
    pink = material("Cosmos • dusty pink petals", (.67, .29, .27))
    ochre = material("Cosmos • ochre pollen", (.63, .23, .043))
    core = material("Cosmos • umber center", (.16, .059, .019))
    for i, (dx, dy, height, radius, tilt, petals) in enumerate((
        (-.49, .035, 2.28, .31, -.22, ivory),
        (.08, -.10, 2.51, .34, .19, pink),
        (.55, .10, 1.99, .27, .32, ivory),
        (-.12, -.20, 1.82, .24, -.37, pink),
    )):
        name = f"Cosmos {i + 1}"
        mouth = origin + Vector((dx * .14, 0, .965))
        center = origin + Vector((dx, dy, height))
        middle = mouth.lerp(center, .53) + Vector((-.06 if dx > 0 else .05, .04, .03))
        branch(group, name + " stem", [mouth, middle, center], .011, stem)
        normal = Vector((tilt, -1, .21)).normalized()
        u = normal.cross(Vector((0, 0, 1))).normalized()
        v = u.cross(normal).normalized()
        for index in range(8):
            angle = (index + i * .22) * math.tau / 8
            axis = math.cos(angle) * u + math.sin(angle) * v
            across = -math.sin(angle) * u + math.cos(angle) * v
            points = [(0.16, -.09, 0), (.49, -.26, -.025), (.84, -.23, .018),
                      (1, -.105, .065), (.97, .015, .10), (1.01, .115, .06),
                      (.85, .23, .02), (.48, .23, -.028), (.16, .09, 0)]
            vertices = [center + radius * (axis * x + across * y + normal * z) for x, y, z in points]
            vertices.append(center + axis * radius * .56 + normal * radius * .018)
            petal = mesh(group, f"{name} petal {index + 1}", vertices,
                         [(9, p, (p + 1) % 9) for p in range(9)], petals)
            for polygon in petal.data.polygons:
                polygon.use_smooth = True
            petal.modifiers.new("Petal thickness", "SOLIDIFY").thickness = .003
        seed(group, name + " center", center + normal * .016, normal, radius * .24, .036, core)
        for n in range(7):
            angle = n * math.tau / 7
            direction = math.cos(angle) * u + math.sin(angle) * v
            seed(group, f"{name} pollen {n + 1}", center + normal * .042 + direction * radius * .16,
                 normal, .018, .014, ochre)
        side = -.24 if i % 2 else .25
        tip = middle + Vector((side, -.065, .15))
        midleaf = middle.lerp(tip, .52)
        mesh(group, name + " leaf", [middle, midleaf + Vector((0, -.017, .07)), tip,
                                    midleaf + Vector((0, .012, -.049)), midleaf + Vector((0, -.03, .013))],
             [(0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)], leaf)


def refine_desk(day, night):
    replace_bouquet(day)
    memo = day.objects["Wall tag 2"]
    memo.name = "Memo • pressed cream paper"
    memo.scale.x *= 1.21
    memo.scale.z *= 2.55
    memo.location.x -= .05
    memo.location.z -= .08
    memo.rotation_euler.y *= .60
    memo.data.materials[0] = material("Memo • warm ivory paper", (.68, .54, .36), .92)
    memo_group = memo.users_collection[0]
    pin_center = memo.location + Vector((-.85, -.048, .34))
    seed(memo_group, "Memo • indigo tack", pin_center, Vector((0, -1, 0)), .051, .018,
         material("Memo • ink tack", (.051, .072, .126), .52))

    font = bpy.data.fonts.load(str(Path("C:/Windows/Fonts/msyh.ttc")), check_existing=True)
    labels = sorted((obj for obj in day.objects if obj.name.endswith("volume number")), key=lambda obj: obj.location.x)
    for obj, title in zip(labels, BOOK_TITLES, strict=True):
        obj.data.font = font
        obj.data.body = "\n".join(title)
        obj.data.size = .135
        obj.data.space_line = 1.02
        obj.data.space_character = 1
        obj.location.z -= .29 if len(title) == 4 else .34

    bulb = night.objects["Lamp • porcelain bulb diffuser"]
    shade = night.objects["Lamp • rolled metal shade"]
    axis = (bulb.location - shade.location).normalized()
    glow = night.objects["Lamp • emissive filament glow"]
    glow.location = bulb.location.copy()
    glow.scale = bulb.scale * 1.029
    practical = night.objects["Warm bulb • independent practical"]
    practical.location = bulb.location - axis * .146
    practical.rotation_euler = (-axis).to_track_quat("-Z", "Y").to_euler()
    practical.data.size = .18
    practical.data.energy = 95
    return memo


def refine_window(day):
    jamb = day.objects["Window right jamb"]
    group = jamb.users_collection[0]
    metal = material("Window • warm painted hardware", (.56, .50, .41), .31)
    trim = material("Window • inset painted beads", (.65, .58, .47), .48)
    seal = material("Window • inner shadow seal", (.21, .19, .16), .77)

    def block(name, center, dimensions, radius, mat):
        data = bpy.data.meshes.new(name)
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        for vertex in bm.verts:
            for axis, size in enumerate(dimensions):
                vertex.co[axis] *= size
        bm.to_mesh(data)
        bm.free()
        obj = bpy.data.objects.new(name, data)
        group.objects.link(obj)
        obj.location = center
        data.materials.append(mat)
        bevel = obj.modifiers.new("Soft machined edge", "BEVEL")
        bevel.width = radius
        bevel.segments = 3
        obj.modifiers.new("Weighted normals", "WEIGHTED_NORMAL")

    for x in (-5.95, -5.81, -3.99):
        block("Window • recessed glass seal", (x, 2.508, 3.62), (.019, .033, 5.08), .007, seal)
        block("Window • inset glazing bead", (x - .019, 2.463, 3.62), (.026, .047, 5.08), .009, trim)
    block("Window • lower glazing bead", (-6.86, 2.493, 1.096), (5.48, .043, .037), .012, trim)
    block("Window • latch plate", (-5.86, 2.278, 2.89), (.096, .04, .217), .023, metal)
    block("Window • latch lever", (-5.826, 2.229, 2.891), (.061, .067, .184), .024, metal)


def add_plush_fill(scene, plush, collection, name, energy, color, group):
    receiver = bpy.data.collections.get("Lighting • plush receivers")
    if receiver is None:
        receiver = bpy.data.collections.new("Lighting • plush receivers")
        receiver.objects.link(plush)
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.color = color
    data.shape = "DISK"
    data.size = 1.9
    data.specular_factor = .2
    light = bpy.data.objects.new(name, data)
    collection.objects.link(light)
    light.location = (1.1, -2.55, 2.18)
    light.rotation_euler = (Vector((1.29, -.17, 1.18)) - light.location).to_track_quat("-Z", "Y").to_euler()
    light.light_linking.receiver_collection = receiver
    light.lightgroup = group
