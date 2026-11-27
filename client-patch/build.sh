#!/data/data/com.termux/files/usr/bin/bash
# Build "RustDesk P2P fix": the official RustDesk 1.5.3 arm64 APK with bionic's
# getifaddrs() patched in (see README.md), installable beside the official app.
#
# Output: build/rustdesk-1.5.3-p2pfix.apk, signed with a local key in build/.
# Needs: gh (to fetch the release), python3, java, kotlinc, zipalign, apksigner,
# keytool, and APKEditor.jar ($APK_EDITOR_PATH or termux-tools' copy).
set -euo pipefail
cd "$(dirname "$0")"

VERSION=1.5.3
APK_NAME="rustdesk-$VERSION-aarch64-signed.apk"
APK_SHA256=6b3aca1a7e68c3f80e5abe7ec3bea3e5ff445a03cf77131ff79a1ee4270288ff
APK_EDITOR="${APK_EDITOR_PATH:-$HOME/git/termux-tools/edge-fix/tools/APKEditor.jar}"
SUFFIX="${PACKAGE_SUFFIX:-p2pfix}"
OUT="build/rustdesk-$VERSION-$SUFFIX.apk"

test -f "$APK_EDITOR" || { echo "APKEditor.jar not found: $APK_EDITOR" >&2; exit 1; }
mkdir -p build/input build/work
rm -rf build/work/*

# 1. Official release APK, pinned by hash.
if [[ ! -f "build/input/$APK_NAME" ]]; then
    gh release download "$VERSION" -R rustdesk/rustdesk -p "$APK_NAME" -D build/input
fi
echo "$APK_SHA256  build/input/$APK_NAME" | sha256sum -c -

# 2. Patch the native library; tests first.
python3 -I -m unittest discover -s test
unzip -q -o "build/input/$APK_NAME" lib/arm64-v8a/librustdesk.so lib/arm64-v8a/libc++_shared.so -d build/work/orig
mkdir -p build/work/lib
python3 -I patch_librustdesk.py build/work/orig/lib/arm64-v8a/librustdesk.so build/work/lib/librustdesk.so

# 3. On Android (Termux), call the real library's getifaddrs before and after.
if [[ "$(uname -o 2>/dev/null)" == Android ]]; then
    cp build/work/orig/lib/arm64-v8a/libc++_shared.so build/work/lib/
    clang -Wall -Wextra -O1 test/libtest.c -o build/work/libtest -ldl
    build/work/libtest build/work/orig/lib/arm64-v8a expect-fail
    build/work/libtest build/work/lib
fi

# 4. Repack with the patched library, dropping the old v1 signature files
#    (compression of every other entry is kept as it was).
python3 -I - "build/input/$APK_NAME" build/work/lib/librustdesk.so build/work/repacked.apk <<'EOF'
import sys, zipfile
src, lib, dst = sys.argv[1:]
with zipfile.ZipFile(src) as zin, zipfile.ZipFile(dst, "w") as zout:
    for info in zin.infolist():
        name = info.filename
        if name.startswith("META-INF/") and name.rsplit(".", 1)[-1] in ("SF", "RSA", "EC", "DSA", "MF"):
            continue
        data = open(lib, "rb").read() if name == "lib/arm64-v8a/librustdesk.so" else zin.read(name)
        zout.writestr(info, data, compress_type=info.compress_type)
EOF

# 5. Own package name, label and debuggable flag.
kotlinc CloneManifest.kt -classpath "$APK_EDITOR" -include-runtime -d build/work/clone-manifest.jar 2>/dev/null
java -Xmx1024m -cp "build/work/clone-manifest.jar:$APK_EDITOR" CloneManifestKt build/work/repacked.apk build/work/clone.apk "$SUFFIX"

# 6. Align and sign with a local key (created once, kept in build/).
if [[ ! -f build/local.keystore ]]; then
    python3 -I -c 'from pathlib import Path; import secrets; p=Path("build/key-password"); p.write_text(secrets.token_urlsafe(32)); p.chmod(0o600)'
    keytool -genkeypair -keystore build/local.keystore -storetype PKCS12 \
        -storepass:file build/key-password -alias local -keyalg RSA -keysize 2048 \
        -validity 10000 -dname "CN=RustDesk P2P fix (local build)"
fi
zipalign -p -f 4 build/work/clone.apk build/work/aligned.apk
# PKCS12: the key uses the store password; passing the file twice would hit EOF.
apksigner sign --ks build/local.keystore --ks-pass file:build/key-password --ks-key-alias local \
    --out "$OUT" build/work/aligned.apk
apksigner verify "$OUT"
zipalign -c -p 4 "$OUT"
sha256sum "$OUT"
