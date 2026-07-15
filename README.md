# 🔗 links.osdc.dev

The Open Source Developers Community's link tree. Every OSDC link in one place.

One HTML file, one stylesheet, one small script. No framework, no build step,
no runtime dependencies — including the QR code, which is generated from
scratch (see below).

```
index.html          the page; links are hand-authored, there is no data array
css/style.css       all styling, ~12 custom properties, no scales
js/main.js          theme toggle · copy email · share/QR modal
assets/
  logo.svg          the OSDC wordmark
  favicon.svg       same mark, self-theming via an embedded <style>
  qr.svg            generated — see "The QR code"
  fonts/            Poppins 400/500/600/700 (OFL, see OFL.txt)
tools/qr.mjs        the QR generator (never deployed)
```

## Editing links

Links are plain HTML in `index.html`. Copy an existing `<a class="link">` block
and change the href, label, sub, and icon. Icons are inline SVG on a 24x24
viewBox — stroked ones use `stroke-linecap="square"`; brand marks are filled
with the official geometry.

There is one time-bound section, marked `NOW`. When the event it points at is
over, delete that heading and the `<nav>` under it. Nothing else on the page
goes stale.

## The QR code

`assets/qr.svg` is committed, so the page ships zero third-party code. Rebuild
it only if the URL changes:

```sh
node tools/qr.mjs             # writes assets/qr.svg + prints a damage report
node tools/qr.mjs --selftest  # checks the encoder against qrencode(1)
```

Three things make it more than a plain QR:

**Alphanumeric encoding.** The payload is `HTTPS://LINKS.OSDC.DEV` in caps, so
it fits QR's alphanumeric mode (~5.5 bits/char instead of 8). Scheme and host
are case-insensitive per RFC 3986, so scanners open it exactly like the
lowercase form. The denser encoding buys a lower version — fewer, chunkier
modules.

**Content-aware logo knockout.** The logo is a wide wordmark, so a square mask
would blank a lot of modules the letters never touch. Instead the generator
rasterises the real silhouette from `logo.svg`, dilates it slightly to give the
glyphs breathing room, and drops only the modules it actually covers. Modules
under the logo's *ink* still read dark, so a dark module beneath a stroke costs
nothing — only mismatches are damage.

**It proves its own margin.** The generator maps every damaged module back to
its codeword, groups those into Reed-Solomon blocks, and refuses any version
where the worst block burns more than 60% of its correction capacity. It walks
versions upward until one qualifies. Current output:

```
v5-H (37x37) · mask 3 · 4 blocks x (22 EC codewords, t=11)
102 of 1369 modules blanked (7.5%) · 21 of 134 codewords damaged
errors per block: 4, 5, 6, 6 (capacity 11 each) → worst block 55%
```

Versions 7-10 are unusable here: they place an alignment pattern dead centre,
where the logo goes. Damaging an alignment pattern breaks *detection*, which no
amount of error correction recovers.

### Verifying it

`--selftest` builds each test payload under all 8 masks and asserts that
`qrencode`'s matrix matches one of them — an independent check of the encoding,
Reed-Solomon, and module placement. Then decode the real, logo-occluded output:

```sh
rsvg-convert -w 256 assets/qr.svg -o /tmp/qr.png
zbarimg --quiet --raw /tmp/qr.png
python3 -c "import cv2; print(cv2.QRCodeDetector().detectAndDecode(cv2.imread('/tmp/qr.png'))[0])"
```

Both should print `HTTPS://LINKS.OSDC.DEV`. 256px is roughly a phone camera at
arm's length.

## Running it

```sh
python3 -m http.server 8000    # or: npx wrangler dev
```

## Deploying

Cloudflare Workers, assets-only — the site sits at the subdomain root, so there
is no worker script. `custom_domain: true` provisions the DNS record and
certificate.

```sh
npx wrangler deploy
```

## Assets

The logo is vectorised from `OSDC_white_logo.png` in [osdc/design](https://github.com/osdc/design):

```sh
magick OSDC_white_logo.png -background black -alpha remove -colorspace gray \
  -threshold 50% -negate logo.pbm
potrace -s --turdsize 4 --alphamax 1.0 --opttolerance 0.2 logo.pbm -o traced.svg
```

potrace emits a `translate(...) scale(0.1,-0.1)` transform; `assets/logo.svg`
has that baked into absolute coordinates so it needs no transform and
`tools/qr.mjs` can parse it directly.

## Licence

MIT — see [LICENSE](LICENSE). Poppins is under the OFL. The OSDC logo is the
community's mark.

The `og` branch holds the previous link tree: a LittleLink fork that served
OSDC (as OSSDEVS) from 2021 to 2024.
