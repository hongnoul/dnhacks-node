"""Generate SkyMesh mascot brand assets into public/.

Run: /opt/homebrew/bin/python3 scripts/generate-brand-assets.py
Outputs (all committed):
  public/favicon.ico            16/32/48 multi-size ICO
  public/icon-180.png           apple-touch-icon (180x180, opaque)
  public/icon-192.png           PWA / Android (192x192)
  public/icon-512.png           PWA / Android (512x512, maskable-safe)
  public/icon-512-maskable.png  maskable variant with extra padding
  public/opengraph-image.png    1200x630 link preview with mascot + wordmark
"""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PUB = ROOT / "public"

BG = (11, 15, 20, 255)        # --bg
STEEL = (230, 239, 250, 255)  # mascot fill on dark
ACCENT = (78, 161, 255, 255)  # --accent
DIM = (125, 143, 166, 255)    # --dim
WHITE = (219, 230, 243, 255)  # --text

ARIAL = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
ARIAL_REG = "/System/Library/Fonts/Supplemental/Arial.ttf"


def main() -> None:
    import cairosvg
    from PIL import Image, ImageDraw, ImageFont

    # Mascot: render the standalone mascot SVG (transparent) once at 1024.
    mascot_png = PUB / "_mascot-1024.png"
    cairosvg.svg2png(url=str(PUB / "skymesh-logo.svg"), write_to=str(mascot_png),
                     output_width=1024, output_height=1024)
    mascot = Image.open(mascot_png).convert("RGBA")
    # Recolor black glyph to pale steel so it reads on the dark tile.
    r, g, b, a = mascot.split()
    steel = Image.merge("RGBA", (Image.new("L", mascot.size, STEEL[0]),
                                 Image.new("L", mascot.size, STEEL[1]),
                                 Image.new("L", mascot.size, STEEL[2]), a))
    mascot_png.unlink()

    def tile(size: int, pad_frac: float) -> Image.Image:
        img = Image.new("RGBA", (size, size), BG)
        inner = int(size * (1 - pad_frac * 2))
        m = steel.resize((inner, inner), Image.LANCZOS)
        img.alpha_composite(m, ((size - inner) // 2, (size - inner) // 2))
        return img

    # Favicon tile: generous padding so the dome survives 16px.
    fav = tile(64, 0.16)
    fav.save(PUB / "favicon.ico", sizes=[(16, 16), (32, 32), (48, 48)])
    # Crisp PNG favicon for modern browsers (SVG icon.svg is primary).
    tile(64, 0.16).resize((32, 32), Image.LANCZOS).convert("RGB").save(PUB / "favicon-32.png")

    # Apple touch icon must be opaque (iOS ignores/darkens alpha).
    tile(180, 0.10).convert("RGB").save(PUB / "icon-180.png")
    tile(192, 0.10).save(PUB / "icon-192.png")
    tile(512, 0.10).save(PUB / "icon-512.png")
    # Maskable: keep the glyph inside the central safe zone (~80% diameter).
    tile(512, 0.22).save(PUB / "icon-512-maskable.png")

    # OG image: dark console backdrop, mascot left, wordmark right.
    W, H = 1200, 630
    og = Image.new("RGBA", (W, H), BG)
    d = ImageDraw.Draw(og)
    d.ellipse([760, -320, 1420, 340], fill=(23, 54, 83, 255))  # faint radar glow
    m = steel.resize((430, 430), Image.LANCZOS)
    og.alpha_composite(m, (80, 100))
    f_title = ImageFont.truetype(ARIAL, 120)
    f_sub = ImageFont.truetype(ARIAL_REG, 38)
    d.text((570, 175), "SkyMesh", font=f_title, fill=WHITE)
    y = 335
    for line in ("Turn phones into a", "drone-sensing mesh."):
        d.text((572, y), line, font=f_sub, fill=DIM)
        y += 48
    d.rectangle([572, y + 12, 620, y + 20], fill=ACCENT)
    y += 40
    for line in ("On-device detection.", "Nothing leaves the phone."):
        d.text((572, y), line, font=f_sub, fill=DIM)
        y += 48
    og.convert("RGB").save(PUB / "opengraph-image.png")
    print("wrote brand assets to public/")


if __name__ == "__main__":
    sys.exit(main())
