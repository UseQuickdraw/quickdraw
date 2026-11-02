# Quickdraw teaser

A 17.5-second, 1920×1080 promo in a minimal type-and-light style:
"The blockchain was founded on ◆ *self-custody*" → "It's time to *own* your trades" →
the real panel (`panel.png`, a 2× capture of the extension) with a cursor buying 0.5 SOL and
selling 50%, toasts and holdings updating → the logo, the wordmark, and "*Self-custody* trading panel".

- `teaser.html` draws every frame on a canvas as a function of time (copy, timings,
  colours and easing are all at the top of its script), and encodes the clip in the
  browser with WebCodecs (H.264) and [mp4-muxer](https://github.com/Vanilagy/mp4-muxer).
- `render.mjs` opens it in headless Edge and saves the result.

```bash
npm run teaser                       # writes docs/quickdraw-teaser.mp4
npm run teaser -- --stills 1.5,8,10  # JPEG stills at those seconds, for a quick look
```

Needs Edge (or Chrome: `BROWSER=/path/to/chrome npm run teaser`) and a network
connection for the page's Google Fonts and the muxer module. The clip has no audio.
