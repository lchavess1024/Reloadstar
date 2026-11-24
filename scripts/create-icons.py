"""Draw the Reloadstar toolbar and store icons using the Python standard library."""
from math import atan2, cos, degrees, hypot, pi, sin
from pathlib import Path
from struct import pack
from zlib import compress, crc32

OUTPUT = Path(__file__).resolve().parents[1] / 'extension' / 'icons'
ARROW = ((0.609, 0.442), (0.711, 0.502), (0.716, 0.382))
STAR = tuple(
    (0.776 + radius * cos(i * pi / 5 - pi / 2),
     0.256 + radius * sin(i * pi / 5 - pi / 2))
    for i in range(10) for radius in (0.139 if i % 2 == 0 else 0.056,)
)


def inside_polygon(x, y, points):
    previous = points[-1]
    inside = False
    for current in points:
        ax, ay = previous
        bx, by = current
        if (ay > y) != (by > y) and x < (bx - ax) * (y - ay) / (by - ay) + ax:
            inside = not inside
        previous = current
    return inside


def inside_arrow(x, y):
    dx, dy = x - 0.461, y - 0.545
    if abs(hypot(dx, dy) - 0.229) <= 0.049 and 39 <= degrees(atan2(dy, dx)) % 360 <= 330:
        return True
    if hypot(x - 0.639, y - 0.689) < 0.049:
        return True
    return 0.60 < x < 0.72 and 0.37 < y < 0.50 and inside_polygon(x, y, ARROW)


def pixel(x, y):
    border = hypot(max(abs(x - 0.5) - 0.275, 0), max(abs(y - 0.5) - 0.275, 0))
    if border > 0.206:
        return (0, 0, 0, 0)
    if border > 0.190:
        return (54, 85, 111, 255)
    glow = max(0, 1 - hypot(x - 0.24, y - 0.19) * 1.21)
    color = (int(10 + 13 * glow), int(24 + 28 * glow), int(40 + 40 * glow), 255)
    if inside_arrow(x + 0.008, y - 0.018):
        color = (6, 17, 29, 255)
    if inside_arrow(x, y):
        color = (int(202 - 65 * y), int(247 - 30 * y), 255, 255)
    if 0.63 < x < 0.93 and 0.11 < y < 0.43:
        if inside_polygon(x + 0.007, y - 0.016, STAR):
            color = (90, 56, 10, 255)
        if inside_polygon(x, y, STAR):
            color = (255, max(194, int(251 - 125 * y)), max(65, int(203 - 335 * y)), 255)
    return color


def chunk(kind, content):
    return pack('>I', len(content)) + kind + content + pack('>I', crc32(kind + content))


def render(size):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            samples = [pixel((x + dx) / size, (y + dy) / size)
                       for dx in (0.125, 0.375, 0.625, 0.875)
                       for dy in (0.125, 0.375, 0.625, 0.875)]
            opaque = [color for color in samples if color[3]]
            rows.extend(round(sum(color[channel] for color in opaque) / len(opaque))
                        if opaque else 0 for channel in range(3))
            rows.append(round(255 * len(opaque) / len(samples)))
    return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', pack('>2I5B', size, size, 8, 6, 0, 0, 0))
            + chunk(b'IDAT', compress(rows, 9)) + chunk(b'IEND', b''))


OUTPUT.mkdir(parents=True, exist_ok=True)
for dimension in (16, 32, 48, 128):
    (OUTPUT / f'icon{dimension}.png').write_bytes(render(dimension))
