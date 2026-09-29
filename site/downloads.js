// The one place the site names Tau's installers. Every stable release from
// 0.7.14 on carries these fixed names, so "latest" always has them.
window.TAU_DOWNLOADS = {
  base: "https://github.com/Rasalas/tau-releases/releases/latest/download/",
  releaseNotes: "https://github.com/Rasalas/tau-releases/releases/latest",
  files: [
    { id: "mac-arm64", os: "mac", label: "Mac with Apple silicon", detail: "M1 and later", file: "Tau-mac-arm64.dmg", kind: ".dmg" },
    { id: "mac-x64", os: "mac", label: "Mac with Intel", detail: "Intel processor", file: "Tau-mac-x64.dmg", kind: ".dmg" },
    { id: "windows", os: "windows", label: "Windows", detail: "Windows 10 and 11", file: "Tau-windows-x64.exe", kind: ".exe" },
    { id: "linux-deb", os: "linux", label: "Linux: Debian, Ubuntu", detail: "x64", file: "Tau-linux-amd64.deb", kind: ".deb" },
    { id: "linux-appimage", os: "linux", label: "Linux: other distributions", detail: "x64", file: "Tau-linux-x86_64.AppImage", kind: ".AppImage" },
  ],
};
