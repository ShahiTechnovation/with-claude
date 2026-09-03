import sys, os
from PIL import Image
src, outdir, band = sys.argv[1], sys.argv[2], int(sys.argv[3]) if len(sys.argv)>3 else 1400
os.makedirs(outdir, exist_ok=True)
im = Image.open(src)
w, h = im.size
n = (h + band - 1)//band
for i in range(n):
    top = i*band
    bot = min(h, top+band)
    im.crop((0, top, w, bot)).save(f"{outdir}/slice-{i:02d}.png")
print(f"{n} slices from {w}x{h}")
