"""Draw the Reloadstar toolbar and store icons using the Python standard library."""
from math import atan2, cos, degrees, hypot, pi, radians, sin
from pathlib import Path
from struct import pack
from zlib import compress, crc32

OUTPUT = Path(__file__).resolve().parents[1] / 'extension' / 'icons'
RING_CENTER = (0.456, 0.500)
RING_RADIUS = 0.292
RING_WEIGHT = 0.057
RING_START = 54
RING_TAIL = (
    RING_CENTER[0] + RING_RADIUS * cos(radians(RING_START)),
    RING_CENTER[1] + RING_RADIUS * sin(radians(RING_START)),
)
ARROWHEAD = ((0.510, 0.352), (0.811, 0.434), (0.735, 0.147))
STAR = tuple(
    (0.826 + radius * cos(i * pi / 5 - pi / 2),
     0.789 + radius * sin(i * pi / 5 - pi / 2))
    for i in range(10) for radius in (0.124 if i % 2 == 0 else 0.051,)
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
    dx, dy = x - RING_CENTER[0], y - RING_CENTER[1]
    if abs(hypot(dx, dy) - RING_RADIUS) <= RING_WEIGHT:
        if RING_START <= degrees(atan2(dy, dx)) % 360 <= 315:
            return True
    if hypot(x - RING_TAIL[0], y - RING_TAIL[1]) < RING_WEIGHT:
        return True
    return 0.50 < x < 0.82 and 0.14 < y < 0.44 and inside_polygon(x, y, ARROWHEAD)


def pixel(x, y):
    border = hypot(max(abs(x - 0.5) - 0.310, 0), max(abs(y - 0.5) - 0.310, 0))
    if border > 0.173:
        return (0, 0, 0, 0)
    if border > 0.157:
        return (54, 85, 111, 255)
    glow = max(0, 1 - hypot(x - 0.24, y - 0.19) * 1.21)
    color = (int(10 + 13 * glow), int(24 + 28 * glow), int(40 + 40 * glow), 255)
    if inside_arrow(x + 0.008, y - 0.018):
        color = (6, 17, 29, 255)
    if inside_arrow(x, y):
        color = (int(200 - 72 * y), int(247 - 30 * y), 255, 255)
    if 0.70 < x < 0.96 and 0.65 < y < 0.92:
        if inside_polygon(x + 0.007, y - 0.016, STAR):
            color = (90, 56, 10, 255)
        if inside_polygon(x, y, STAR):
            color = (255, max(194, int(239 - 185 * (y - 0.68))), max(70, int(154 - 460 * (y - 0.68))), 255)
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
