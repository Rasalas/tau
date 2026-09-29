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

English review instructions for the demo in bundle `71500`:

> Tau is a companion for a Tau host on the user's own computer. No Tau account is
> required. To inspect sample conversations without a computer or an AI account,
> open the app and tap "Try demo" on the Hosts screen. Open a sample thread or tap
> "New thread" and send a message. Replies are explicitly simulated and stay in
> memory on the phone. Use More → Exit demo to leave and reset it. The demo does
> not exercise real host pairing, agent execution, file operations or push
> delivery. These functions require a paired Tau host; setup information is at
> https://rasalas.github.io/tau/.

Bundle `71500` is available on the internal test track. The review instructions
are not saved in Play: its mandatory full-access declaration cannot be confirmed
for this limited demo. See `docs/mobile-google-play.md` for the remaining steps.

`assets/phone/` contains two unedited Android emulator captures. Both language
listings use these screenshots; the app interface is currently English.
