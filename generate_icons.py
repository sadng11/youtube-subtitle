import os
import zlib
import struct

def make_png(width, height, color_func):
    raw_data = bytearray()
    for y in range(height):
        raw_data.append(0)  # filter type 0 (None)
        for x in range(width):
            r, g, b, a = color_func(x, y, width, height)
            raw_data.extend([r, g, b, a])
            
    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = zlib.crc32(c) & 0xffffffff
        return struct.pack('>I', len(data)) + c + struct.pack('>I', crc)
    
    png = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    png += chunk(b'IHDR', ihdr)
    compressed = zlib.compress(bytes(raw_data), 9)
    png += chunk(b'IDAT', compressed)
    png += chunk(b'IEND', b'')
    return png

def icon_color(x, y, w, h):
    nx = (x / w) * 2 - 1
    ny = (y / h) * 2 - 1
    
    corner_r = 0.35
    ax = max(0, abs(nx) - (1 - corner_r))
    ay = max(0, abs(ny) - (1 - corner_r))
    dist = (ax**2 + ay**2)**0.5
    
    if dist > corner_r:
        return (0, 0, 0, 0) # transparent
    
    grad = (ny + 1) / 2
    r_bg = int(255 - grad * 35)
    g_bg = int(20 - grad * 20)
    b_bg = int(45 - grad * 25)
    
    is_line1 = (-0.55 <= nx <= 0.55) and (-0.28 <= ny <= -0.05)
    is_line2 = (-0.40 <= nx <= 0.40) and (0.10 <= ny <= 0.32)
    
    if is_line1 or is_line2:
        return (255, 255, 255, 255)
    
    return (r_bg, g_bg, b_bg, 255)

os.makedirs('icons', exist_ok=True)
for size in [16, 48, 128]:
    data = make_png(size, size, icon_color)
    with open(f'icons/icon-{size}.png', 'wb') as f:
        f.write(data)
    print(f"Generated icons/icon-{size}.png")
