# Docker image size note

The production Vibe Practice Management image is approximately **750-900 MB**. This is large for a Node.js application. Most of the bloat comes from one decision.

## The Chrome problem

We bundle **Chromium** (~280 MB on disk, ~180 MB compressed) so Puppeteer can render firm-branded HTML+CSS templates to PDF. This was the explicit choice in [QUESTIONS.md Q18](../QUESTIONS.md#q18--pdf-rendering-library) over lighter alternatives:

- **React-PDF** (~10 MB) — pure JS but constrained layout, no flexbox-style flow, makes firm-branded templates harder to design
- **WeasyPrint** (~50 MB + Python runtime) — would add Python to the image entirely; not worth dual-runtime maintenance
- **Puppeteer + bundled Chromium** (~280 MB) — full HTML/CSS rendering, branded templates work natively, ✅ chosen

## Breakdown

Approximate sizes of major components in the runtime stage:

| Component | Size | Notes |
|---|--:|---|
| Debian bookworm-slim base | ~75 MB | Minimal base + apt cache stripped |
| Node.js 20 | ~150 MB | Runtime + npm + builtins |
| Chromium | ~280 MB | For Puppeteer |
| Noto fonts (CJK + emoji + Liberation) | ~80 MB | Required for international names, currency symbols, emoji in client communications |
| node_modules (production) | ~120 MB | Including Drizzle, Express, BullMQ, React, etc. |
| Compiled app code (apps/* dist) | ~50 MB | All four apps after Vite bundling |
| postgresql-client | ~20 MB | For backup/restore scripts |
| tini (init) + curl + ca-certs | ~10 MB | Operational essentials |
| **Total** | **~785 MB** | Within target band |

## Why we accept this

- **Self-hosted appliance.** The firm pulls this image once and runs it. Pull bandwidth is paid once; runtime image-size is irrelevant to the user experience.
- **Customer's hardware spec.** The GMKtec NucBox M6 reference hardware has 256GB+ NVMe; even 100x our image size would fit.
- **PDF flexibility matters.** Firm branding is a real differentiator. Locking the PDF renderer to a constrained layout would hurt the product more than the image-size hurts deployment.

## When this might bite us

- **CI build cache pressure** — frequent rebuilds without cache hits cost minutes. Mitigated by Docker Buildx and GitHub Actions cache.
- **Container registry quota** — GHCR has limits for free tier; multi-arch (amd64 + arm64) doubles the storage. As of this writing, well within limits.
- **First pull on customer hardware** — ~280 MB of Chromium downloads is the longest single hop. Cloudflare-fronted GHCR mitigates somewhat.

## What would make this smaller

If we ever need to trim:

1. **Drop arm64.** Most firm appliances run on amd64. Halves registry storage.
2. **Move PDFs to a sidecar.** Run Chromium in its own container that only does PDF rendering. Main API stays small. Adds inter-container complexity.
3. **Use a `gotenberg`-style HTTP service.** Replace Puppeteer with a remote PDF service. Adds network dep, removes Chrome.
4. **Drop the international fonts.** Saves ~80 MB. Acceptable for US-only firms; breaks if any client name uses CJK or emoji.

None of these are planned for v1. Image size monitoring lives in CI; if we cross 1.2 GB the build fails and forces a re-evaluation.

## How to check current size

```sh
docker images ghcr.io/kisaesdevlab/vibe-time-billing
# Compare uncompressed (`docker images`) and compressed (registry-shown) sizes
```

`dive` is useful for layer-by-layer inspection:

```sh
dive ghcr.io/kisaesdevlab/vibe-time-billing:latest
```
