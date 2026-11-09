# Fieldroom browser edition

A version of Fieldroom that runs as a page inside claude.ai, with no server to install.

- **Storage:** projects, documents, and photos are saved in the viewer's own browser (IndexedDB) on that device. Each person who opens the page has their own projects, and clearing browser data erases them.
- **AI extraction:** uses Claude through the claude.ai page, using the same extraction instructions as the server's Gemini extraction. No API key is needed. The first time, claude.ai asks the viewer for permission. Floor plan pages and images are sent to Claude as pictures, and document text is sent as text.
- **Not available:** QR scanning with the camera, and room links that open a specific room.

## Build

```bash
npm run build:browser
```

This writes `browser-edition/dist/`. The build copies the app from `public/` and the extraction instructions from `server.mjs`, then applies small patches. Each patch must match exactly once, so the build stops with an error if a change to `public/app.js` breaks one. `npm test` runs the build as a check.

## Publish to claude.ai

Publish `dist/fieldroom.html` as a claude.ai artifact, with these supporting files:

- `vendor/pdfjs/pdf.min.mjs`
- `vendor/pdfjs/pdf.worker.b64.txt`
- `fieldroom-logo.svg`, `fieldroom-logo-reversed.svg`, `qr-code-icon.svg`

Declare the capabilities `{"sample": {"images": true}, "downloads": true}`:

- `sample` lets the page ask Claude to read documents.
- `downloads` lets **Export CSV** save a file.

Claude Code can do this with its Artifact tool.

## Files

| File | Purpose |
| --- | --- |
| `browser-backend.js` | Replaces the server's `/api/*` routes with browser storage, and the blocked `alert`/`confirm`/`prompt` with on-page dialogs |
| `extract-claude.js` | Prepares documents (PDF text and page images, DOCX text) and asks Claude to extract rooms and deliverables |
| `build.mjs` | Builds the page |
