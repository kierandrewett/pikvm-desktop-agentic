// Build the RPM via the electron-installer-redhat API so we can pass a custom
// desktop template (StartupWMClass) — the CLI doesn't expose it. Run after
// electron-packager has produced builds/pikvm-desktop-linux-x64.
import installer from "electron-installer-redhat";
import { resolve } from "path";

const root = resolve(import.meta.dirname, "..");

// whisper.cpp's prebuilt .so/binaries carry RPATHs pointing at their compile-time
// build dir, which rpmbuild's check-rpaths treats as fatal (invalid + empty runpath).
// They're a non-issue for our shipping model (bundled native libs that load their
// own siblings), so tell rpmbuild to allow them rather than fail the whole package.
// 0x1F = every check-rpaths bit (standard|invalid|...|empty). Inherited by rpmbuild.
process.env.QA_RPATHS = "0x001F";

await installer({
    src: resolve(root, "builds/pikvm-desktop-linux-x64/"),
    dest: resolve(root, "builds/rpm/"),
    arch: "x86_64",
    name: "pikvm-desktop",
    productName: "PiKVM Desktop",
    genericName: "Remote Desktop",
    bin: "pikvm-desktop",
    icon: resolve(root, "src/assets/icon.png"),
    desktopTemplate: resolve(root, "build/desktop.ejs"),
});

console.log("RPM built (with StartupWMClass).");
