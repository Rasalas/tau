import { configure } from "@testing-library/dom";

// Integration-heavy renderer tests share the machine with Git and runtime
// subprocess fixtures. Keep DOM polling tolerant of scheduler contention while
// preserving each assertion's own failure output.
configure({ asyncUtilTimeout: 5_000 });
