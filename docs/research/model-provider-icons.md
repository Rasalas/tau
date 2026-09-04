# Model-provider icons

Research date: 2026-09-04

## Recommendation

Bundle reviewed provider assets with Tau instead of hotlinking them. Prefer a square SVG or a raster source at least twice the rendered CSS size. For an 18 px badge, use SVG or a raster image at least 36×36 px. A 16×16 favicon is too small on a Retina display; a 32×32 source is usable at 16 px and marginal at 18 px.

Show the model vendor, not the runtime owner. Anthropic and OpenAI are model vendors. OpenCode and KI:connect can also act as runtimes or gateways, so Tau may eventually need separate `modelProvider` and `runtimeProvider` fields.

## First-party sources

### Anthropic / Claude

Anthropic's homepage publishes a 32×32 PNG favicon and a larger webclip image. The 32×32 favicon is usable for a 16 px badge, but a larger square source is preferable for an 18 px badge.

- [Anthropic](https://www.anthropic.com/)
- [Anthropic favicon](https://cdn.prod.website-files.com/67ce28cfec624e2b733f8a52/681d52619fec35886a7f1a70_favicon.png)

No public first-party brand-kit page was confirmed during this research. Review Anthropic's current trademark terms before shipping the copied asset.

### OpenAI / GPT

OpenAI maintains an official brand page. Use an asset downloaded from that page rather than scraping a site favicon. The page may be protected by Cloudflare, so Tau should not depend on runtime access to it.

- [OpenAI brand guidelines](https://openai.com/brand/)

Review the current usage terms on the brand page before bundling the mark.

### Google / Gemini

The first-party Gemini web app publishes the multicolor Gemini sparkle as an SVG favicon and a 512 px PNG. Either is technically sufficient at 18 px; the SVG is the best source.

- [Gemini](https://gemini.google.com/)
- [Gemini sparkle SVG](https://www.gstatic.com/lamda/images/gemini_sparkle_aurora_33f86dc0c0257da337c63.svg)
- [Gemini sparkle 512 px PNG](https://www.gstatic.com/lamda/images/gemini_sparkle_4g_512_lt_f94943af3be039176192d.png)
- [Google Brand Resource Center](https://about.google/brand-resource-center/guidance/)

Google's Brand Resource Center says third-party use of Google brand elements is restricted and may require permission. Review the applicable product guidance before shipping the Gemini mark. Use the Gemini product mark, not the generic Google `G`, to identify Gemini models.

### OpenCode

OpenCode has a first-party brand page. Its site publishes a 96×96 PNG favicon, a 48×48 ICO, a 180×180 Apple touch icon, and square logo previews. The 96 px or 180 px source is sufficient at 18 px.

- [OpenCode brand assets](https://opencode.ai/brand)
- [OpenCode 96 px favicon](https://opencode.ai/favicon-96x96-v3.png)
- [OpenCode 180 px touch icon](https://opencode.ai/apple-touch-icon-v3.png)

### KI:connect

KI:connect is the NRW university platform described by RWTH Aachen. Its first-party project site publishes the KI:connect logo as SVG plus PNG favicon and touch-icon assets. Use the SVG if a compact symbol remains recognizable at 18 px. If the SVG is a wordmark, a dedicated square mark is needed.

- [RWTH description of KI:connect](https://www.itc.rwth-aachen.de/cms/it-center/Services/Kollaboration/~bndnjc/KI-connect/lidx/1/)
- [KI:connect project site](https://kiconnect.pages.rwth-aachen.de/pages/)
- [KI:connect SVG logo](https://kiconnect.pages.rwth-aachen.de/pages/img/logo_kiconnect.svg)

## Implementation notes

- Store approved copies under a local asset directory and record their source and retrieval date.
- Do not fetch provider images when rendering the sidebar. Hotlinks create privacy, availability, and visual-change risks.
- Preserve aspect ratio, colors, and clear space. Do not redraw trademarked marks as text glyphs.
- Add an accessible provider name even when the visible badge contains only an icon.
- Test each icon on Tau's dark background at 16, 18, and 20 CSS px.
