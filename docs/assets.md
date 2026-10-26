# Persistent campaign images

A creator can attach an actual **PNG** to a revision. The server checks it, stores the bytes, and the revision refers to exactly those bytes from then on. A reviewer sees that same image after a reload or a server restart, an approval is bound to its digest, and replacing the image makes the approval stale. This applies to both modes (demo and authenticated).

## What is stored where (architecture)

```
data/brandproof.json                 workspace state (JSON)
data/brandproof.json.assets/<sha256>.png   retained image bytes, named by their own digest
```

- **Content-addressed files.** An image lives at `<workspace file>.assets/<sha256>.png`. The directory is derived from the workspace file, so the demo workspace, the authenticated workspace and any other workspace never share bytes (tested). The name *is* the SHA-256 of the bytes, so a reference cannot silently point at different content.
- **A registry in the workspace state** (`state.assets[sha256]`) records bytes, dimensions, media type, uploader (real actor in authenticated mode) and time. Only a registered digest is ever turned into a file path, so there is no route from a request to an arbitrary file.
- **Revisions refer by digest.** `asset.retainedSha256` is the server-computed digest. The legacy `fileSha256` is set from it. Old records are untouched.
- **Approval identity.** `assetHash` (part of every approval binding) includes `retainedSha256` **only when present**, so every existing asset hash and therefore every existing approval is unchanged. A new retained image or a replacement changes the binding and the approval shows **Re-review required** (reason: image details). A metadata-only claim with the same fingerprint is *not* the same identity as retained bytes (tested).
- **Never deleted.** Registered images are history; there is no deletion or garbage-collection in this slice. Superseded images stay readable through the revisions that used them.

## Upload path and consistency

`POST /api/assets` takes the raw bytes (`Content-Type: application/octet-stream`; the declared type is only a gate). Creators and managers only; in authenticated mode it needs a live session, the CSRF token and a matching Origin like every write. Uploads are **single-flight**, so quota checks cannot race:

1. validate the bytes (below); compute SHA-256;
2. identical bytes already retained: return the existing entry (idempotent). The stored file is **verified by digest**; if it is missing, unreadable or damaged (same size or not) it is **replaced by the bytes just received**, which were validated and hash to the registered digest (response: `deduplicated: true, restored: "missing" | "corrupt"`). The replacement is a temp file plus an atomic rename, so a reader sees the old file or the restored one, never a mixture. If the restoration fails the damaged file is left exactly as it was and the upload fails with 503;
3. quota check **before** writing;
4. write the file (temporary file, fsync, rename);
5. register it in the serialised, atomic workspace write.

If step 5 fails the new file is removed again, so nothing unregistered stays behind. The **temporary file is removed after any ordinary I/O failure** while writing: open, a partial write, fsync, close or rename (tested with injected faults). A crash or power loss between steps can still leave a `.tmp` file or an unregistered image file; neither is ever served, counted or referenced, but nothing cleans them up in this version. A revision may only be saved with a reference that resolves to a retained image (checked inside the same atomic write; unknown, malformed, upper-case or mismatching references are refused with 422). Requesting review or approving first **reads the retained file and checks it against its recorded size and SHA-256** (not just that a file of the right size exists), so **no review request or approval is recorded on an image that is missing, unreadable or damaged**: 409 `asset_missing` or 409 `asset_corrupt`, with the message "Upload the same image again to restore it". Together with the binding (digest plus the guideline/evidence hashes the person saw) this means an approval is only recorded against bytes that matched at that moment.

## What the server validates (it trusts nothing the client says)

File name, media type, digest and dimensions sent by the client are ignored. The bytes must be a sound PNG: signature; chunk lengths, names and order; **every chunk CRC**; IHDR limits (size, colour type and bit depth combinations, no animation); palette rules; no unknown critical chunks; image data in one contiguous run; **the zlib stream is decompressed with a hard output limit, must be fully consumed and must expand to exactly the size the header implies** (so truncated data and decompression bombs are refused); every scanline filter byte is valid (interlaced images included); nothing after the end marker. Pixels are *not* reconstructed or interpreted. Only the fixed type `image/png` is ever served. **No SVG, HTML, PDF, JPEG, GIF, WebP or URLs.**

| Limit | Value |
|---|---|
| Request/image size | 2 MiB per image |
| Dimensions | at most 4096 on a side and 4,000,000 pixels |
| Decoded size | at most 40 MiB |
| Workspace storage | 50 MiB in total, 200 images |
| Chunks | at most 1000 |

(The limits are settings in `src/assets.js`; tests use smaller ones.) When the quota is full the upload is refused with a message saying images cannot be deleted in this version: **there is no recovery path inside the app today** other than starting a new workspace file. This is a deliberate limit of the first slice.

## Serving

`GET /api/assets/<64 hex>` returns the retained bytes with `Content-Type: image/png` (fixed), `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Content-Disposition: inline; filename="image.png"`, `Cross-Origin-Resource-Policy: same-origin`, `Cache-Control: private, no-store`. In authenticated mode every read needs a live session. The server re-hashes the file it read and refuses (500 `asset_corrupt`) to send bytes that no longer match their digest; a file that is gone gives 404 `asset_missing`. `GET /api/assets/usage` reports count, bytes and the limits.

## Integrity limits

Detection is **point-in-time**: the bytes are verified when they are served, when a review is requested and when an approval is about to be recorded, and again by the digest every time a reviewer opens the image. BrandProof cannot stop someone with access to the folder from changing or deleting a file afterwards; it can only refuse to treat damaged bytes as the approved image the next time they are used. An approval already recorded stays recorded (history); if the file is later damaged the image is no longer served and the item cannot be sent for review or approved again until the same image is uploaded again.

## What is NOT claimed

- Retaining an image reads nothing from it. (Separately and optionally, a human-confirmed transcription of the words printed in the image can be saved with a revision, with an offline OCR draft as a starting point; the person must compare it with the printed words and digits, and fixing a claim in the artwork means replacing the image: see [ocr-image-text.md](ocr-image-text.md).) It does **not** extract colours or compute contrast from pixels. Text colour, background colour and "colours used" stay **manual metadata chosen by a person**: typed, picked, or sampled by clicking the retained image (the colour of that one clicked pixel is read in the browser and saved as a hex value; the person still decides what it means). Nothing is ever extracted automatically. Palette and contrast findings keep saying so, and "Not checked" is shown when nothing was entered.
- No image-quality, accessibility or brand-fit judgement is made by the server. Alt text is still a person's text.
- Images are stored **unencrypted** in a local directory next to the workspace file. This is local storage, not confidential multi-user storage.
- Only the first frame/structure of ordinary PNGs is accepted; animated PNG is refused.

## Legacy and compatibility

- A revision saved before this feature has only a file name and a **browser-reported** fingerprint. It is shown as **Metadata only: image not retained** and the reviewer is told they cannot see it. It is not relabelled and keeps working. Its binding is exactly what it was.
- The editor shows the same distinction when you start a new revision from such a record, and offers to attach the PNG.
- Replacing an image keeps the old alt text, and the editor says so (a person must check it still describes the new image). Removing an image from a draft is explicit and earlier revisions keep theirs.
- A failed or late upload never changes the draft: the editor states what the draft still contains, an older upload completing after a newer choice, a removal, a cancel or another draft is discarded, and Save is disabled while an upload is running.

## Data implications

Workspace files gain, only when used, a top-level `assets` registry and revisions may gain `asset.retainedSha256`. A file without them loads and behaves as before. Back up the workspace file **and its `.assets` directory together**; authenticated mode's backups cover the JSON file only. Do not downgrade to a build that predates this feature after saving retained images (it would show the references as unknown fields and not serve the images). The package script excludes `data/` and any `*.assets` directory.
