from PIL import Image, ImageDraw, ImageFont
import os

for size in [192, 512]:
    img = Image.new('RGBA', (size, size), (10, 14, 26, 255))
    draw = ImageDraw.Draw(img)
    
    # Background gradient circle
    for i in range(size//2, 0, -1):
        alpha = int(255 * (1 - i/(size//2)) * 0.3)
        color = (99, 102, 241, alpha)
        draw.ellipse([size//2-i, size//2-i, size//2+i, size//2+i], fill=color)
    
    # Star symbol
    star_size = int(size * 0.45)
    x, y = size//2, size//2
    draw.text((x - star_size//2, y - star_size//2), "✦", fill=(167, 139, 250, 255))
    
    img.save(f'/home/claude/pwa-assistant/icon-{size}.png')
    print(f"Created icon-{size}.png")
