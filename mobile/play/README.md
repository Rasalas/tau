# Google Play assets and review demo

`en-US/` and `de-DE/` contain the listing text and 1024 × 500 feature graphic.
`assets/icon.png` is the 512 × 512 rendering of `assets/icon/square-light.svg`
at the repository root. The PNG graphics are rendered from the adjacent SVG
with `rsvg-convert`. No private account credentials belong here.

## Local demo

On the Hosts screen, **Try demo** opens three sample conversations in the same
workbench used by paired hosts. The demo host runs in memory inside the app.
Messages receive a fixed, clearly labelled simulated reply; there is no model,
network host, filesystem access or provider account. **More → Exit demo** reloads
the Hosts screen and discards demo messages and settings. Each visit starts fresh.

The demo is available to everyone, including reviewers. It does not grant access
to saved hosts. It cannot verify pairing, real agent execution, file operations
or remote push delivery. Do not describe it as complete access to these functions
or promise that Google will accept it as the only review resource.

Suggested English review instructions, once a bundle containing the demo has
been uploaded:

> Tau is a companion for a Tau host on the user's own computer. No Tau account is
> required. To inspect sample conversations without a computer or an AI account,
> open the app and tap "Try demo" on the Hosts screen. Open a sample thread or tap
> "New thread" and send a message. Replies are explicitly simulated and stay in
> memory on the phone. Use More → Exit demo to leave and reset it. The demo does
> not exercise real host pairing, agent execution, file operations or push
> delivery. These functions require a paired Tau host; setup information is at
> https://rasalas.github.io/tau/.

The currently uploaded initial bundle, version code `715`, predates this demo.
Review instructions must not refer to it until a replacement bundle is uploaded.
