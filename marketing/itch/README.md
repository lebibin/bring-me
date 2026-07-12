# itch.io page assets

All rendered from real in-game scenes (sandbox mode, `?fx=1`) at native resolution;
logo/cover/banner composed with Titan One + Baloo 2 (Google Fonts, OFL).

| File | Size | itch.io slot |
| --- | --- | --- |
| `cover.png` | 1260×1000 (2× of 630×500) | Cover image (game page + thumbnails) |
| `banner.png` | 1920×720 (2× of 960×360) | Page banner (theme editor → banner) |
| `logo.png` | 1900×700, transparent | Wordmark — page body, devlogs, press |
| `social.png` | 1200×630 | Social/OG embed (Twitter/Discord cards) |
| `screenshot-01-backyard-race.png` | 1920×1080 | Screenshots |
| `screenshot-02-jumbotron-reveal.png` | 1920×1080 | Screenshots |
| `screenshot-03-city-park.png` | 1920×1080 | Screenshots |
| `screenshot-04-beach-cove.png` | 1920×1080 | Screenshots |
| `screenshot-05-closeup.png` | 1920×1080 | Screenshots |
| `icon-1024.png` | 1024×1024 | Master square icon (source for resizes) |
| `icon-512.png` / `icon-192.png` | 512 / 192 | PWA manifest icons (`purpose: any`) |
| `icon-maskable-512.png` / `icon-maskable-192.png` | 512 / 192 | PWA manifest icons (`purpose: maskable`, art inside safe zone) |
| `apple-touch-icon.png` | 180×180 | iOS home-screen icon (`<link rel="apple-touch-icon">`) |

Regenerating: run the client (`npm run dev:client`), open
`http://localhost:5175/?fx=1&stage=N#/sandbox`, and drive `window.__bringme`
(teleport via ECS `Position`, spawn extra blobs with `buildBlob`, pose the
camera manually, then `ctx.render()` + `canvas.toDataURL`).
