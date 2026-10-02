/** Shell-independent authorization and lifecycle. No pixels leave a disabled or locked session. */
export class CaptureService {
  constructor({ available, owner, take }) {
    this.available = available;
    this.owner = owner;
    this.take = take;
    this.enabled = true;
    this.busy = false;
  }
  check() {
    if (!this.enabled || !this.available()) throw new Error("Unlock your Wayland session and enable Tau SnapShots before capturing a window.");
  }
  disable() { this.enabled = false; }
  async capture(sender) {
    this.check();
    if (this.busy) throw new Error("A SnapShot is already in progress.");
    this.busy = true;
    try {
      if (await this.owner() !== sender) throw new Error("Only the Tau capture client may request a SnapShot.");
      this.check();
      const snapshot = await this.take();
      this.check();
      return snapshot;
    } finally { this.busy = false; }
  }
}
