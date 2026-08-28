#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cygpath -u "${VAST_FFMPEG_REPO_ROOT:?VAST_FFMPEG_REPO_ROOT is required}")"
download_root="$(cygpath -u "${VAST_FFMPEG_SOURCE_CACHE:?VAST_FFMPEG_SOURCE_CACHE is required}")"
toolchain_source_root="$(cygpath -u "${VAST_FFMPEG_TOOLCHAIN_SOURCE_CACHE:?VAST_FFMPEG_TOOLCHAIN_SOURCE_CACHE is required}")"
build_root="$(cygpath -u "${VAST_FFMPEG_BUILD_ROOT:?VAST_FFMPEG_BUILD_ROOT is required}")"
jobs="${VAST_FFMPEG_JOBS:-${NUMBER_OF_PROCESSORS:-4}}"
prefix="$build_root/prefix"
source_root="$build_root/sources"
work_root="$build_root/work"
runtime_root="$build_root/runtime"

case "$build_root" in
  /[a-zA-Z]/VastBuild/ffmpeg-9.0.1) ;;
  *)
    echo "Refusing to clean unexpected FFmpeg build root: $build_root" >&2
    exit 2
    ;;
esac

export PATH="/ucrt64/bin:/usr/bin:$PATH"
export PKG_CONFIG_PATH="$prefix/lib/pkgconfig"
export PKG_CONFIG_LIBDIR="$prefix/lib/pkgconfig"
export SOURCE_DATE_EPOCH="1786492800"
export ZERO_AR_DATE=1
export ARFLAGS=crD
common_cflags="-O2 -ffile-prefix-map=$build_root=/usr/src/vast-ffmpeg -fdebug-prefix-map=$build_root=/usr/src/vast-ffmpeg"
common_ldflags="-L$prefix/lib -static -static-libgcc"

echo '[Vast FFmpeg] Verifying signed toolchain corresponding source'
for source_archive in "$toolchain_source_root"/*.src.tar.zst; do
  gpg --homedir /etc/pacman.d/gnupg --batch --verify "$source_archive.sig" "$source_archive"
done

rm -rf "$source_root" "$work_root" "$prefix" "$runtime_root"
mkdir -p "$source_root" "$work_root" "$prefix" "$runtime_root/bin" "$runtime_root/licenses"

extract() {
  local archive="$1"
  tar -xf "$download_root/$archive" -C "$source_root"
}

extract ffmpeg-9.0.1.tar.xz
extract x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar
extract libvpx-1.15.2.tar.gz
extract opus-1.5.2.tar.gz
extract libogg-1.3.6.tar.xz
extract libvorbis-1.3.7.tar.xz
extract lame-3.100.tar.gz

build_autoconf_static() {
  local source_dir="$1"
  shift
  mkdir -p "$work_root/$source_dir"
  pushd "$work_root/$source_dir" >/dev/null
  "$source_root/$source_dir/configure" \
    --host=x86_64-w64-mingw32 \
    --prefix="$prefix" \
    --disable-shared \
    --enable-static \
    "$@" \
    CFLAGS="$common_cflags" \
    LDFLAGS="$common_ldflags"
  make -j"$jobs"
  make install
  popd >/dev/null
}

echo '[Vast FFmpeg] Building x264'
pushd "$source_root/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55" >/dev/null
./configure \
  --host=x86_64-w64-mingw32 \
  --prefix="$prefix" \
  --enable-static \
  --disable-cli \
  --disable-opencl \
  --extra-cflags="$common_cflags" \
  --extra-ldflags="$common_ldflags"
make -j"$jobs"
make install
popd >/dev/null

echo '[Vast FFmpeg] Building libvpx'
mkdir -p "$work_root/libvpx"
pushd "$work_root/libvpx" >/dev/null
"$source_root/libvpx-1.15.2/configure" \
  --target=x86_64-win64-gcc \
  --prefix="$prefix" \
  --disable-shared \
  --enable-static \
  --disable-examples \
  --disable-tools \
  --disable-docs \
  --disable-unit-tests \
  --enable-vp8 \
  --enable-vp9 \
  --extra-cflags="$common_cflags"
make -j"$jobs"
make install
popd >/dev/null

echo '[Vast FFmpeg] Building Opus'
build_autoconf_static opus-1.5.2 --disable-doc --disable-extra-programs

echo '[Vast FFmpeg] Building libogg'
build_autoconf_static libogg-1.3.6

echo '[Vast FFmpeg] Building libvorbis'
build_autoconf_static libvorbis-1.3.7 --disable-docs --disable-examples --disable-oggtest

echo '[Vast FFmpeg] Building LAME'
build_autoconf_static lame-3.100 --disable-frontend --disable-decoder

echo '[Vast FFmpeg] Building FFmpeg'
mkdir -p "$work_root/ffmpeg"
pushd "$work_root/ffmpeg" >/dev/null
"$source_root/ffmpeg-9.0.1/configure" \
  --prefix="$prefix" \
  --arch=x86_64 \
  --target-os=mingw32 \
  --enable-gpl \
  --enable-version3 \
  --enable-static \
  --disable-shared \
  --disable-autodetect \
  --disable-debug \
  --disable-doc \
  --disable-ffplay \
  --enable-ffmpeg \
  --enable-ffprobe \
  --enable-schannel \
  --enable-libx264 \
  --enable-libvpx \
  --enable-libopus \
  --enable-libvorbis \
  --enable-libmp3lame \
  --pkg-config-flags=--static \
  --extra-cflags="-I$prefix/include $common_cflags" \
  --extra-ldflags="$common_ldflags"
make -j"$jobs"
install -m 0755 ffmpeg.exe "$runtime_root/bin/ffmpeg.exe"
install -m 0755 ffprobe.exe "$runtime_root/bin/ffprobe.exe"
popd >/dev/null

cp "$source_root/ffmpeg-9.0.1/COPYING.GPLv3" "$runtime_root/licenses/FFmpeg-GPLv3.txt"
cp "$source_root/x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55/COPYING" "$runtime_root/licenses/x264-COPYING.txt"
cp "$source_root/libvpx-1.15.2/LICENSE" "$runtime_root/licenses/libvpx-LICENSE.txt"
cp "$source_root/opus-1.5.2/COPYING" "$runtime_root/licenses/Opus-COPYING.txt"
cp "$source_root/libogg-1.3.6/COPYING" "$runtime_root/licenses/libogg-COPYING.txt"
cp "$source_root/libvorbis-1.3.7/COPYING" "$runtime_root/licenses/libvorbis-COPYING.txt"
cp "$source_root/lame-3.100/COPYING" "$runtime_root/licenses/LAME-COPYING.txt"
cp /ucrt64/share/licenses/gcc-libs/COPYING3 "$runtime_root/licenses/GCC-GPLv3.txt"
cp /ucrt64/share/licenses/gcc-libs/COPYING.RUNTIME "$runtime_root/licenses/GCC-Runtime-Library-Exception.txt"
cp /ucrt64/share/licenses/crt/COPYING.MinGW-w64-runtime.txt "$runtime_root/licenses/MinGW-w64-runtime-COPYING.txt"
cp /ucrt64/share/licenses/libwinpthread/COPYING "$runtime_root/licenses/libwinpthread-COPYING.txt"

bash "$repo_root/third_party/ffmpeg/scripts/package-corresponding-source.sh"

echo '[Vast FFmpeg] Build and corresponding-source archive completed.'
