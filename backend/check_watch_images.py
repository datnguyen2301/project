import os
from PIL import Image

uploads = r'D:\project\backend\uploads'
files = []
for f in os.listdir(uploads):
    if f.startswith('thumb_watch_') or f.startswith('watch_'):
        path = os.path.join(uploads, f)
        if not os.path.isdir(path):
            files.append((os.path.getmtime(path), path, f))

files.sort(reverse=True)
print(f"Total watch images: {len(files)}")
print("\nTop 10 most recent:")
for mtime, path, name in files[:10]:
    img = Image.open(path)
    size_kb = os.path.getsize(path) // 1024
    import datetime
    ts = datetime.datetime.fromtimestamp(mtime).strftime('%Y-%m-%d %H:%M')
    print(f"  {ts}  {name}  {img.size[0]}x{img.size[1]}  {size_kb}KB")
