#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cygpath -u "${VAST_FFMPEG_REPO_ROOT:?VAST_FFMPEG_REPO_ROOT is required}")"
download_root="$(cygpath -u "${VAST_FFMPEG_SOURCE_CACHE:?VAST_FFMPEG_SOURCE_CACHE is required}")"
toolchain_source_root="$(cygpath -u "${VAST_FFMPEG_TOOLCHAIN_SOURCE_CACHE:?VAST_FFMPEG_TOOLCHAIN_SOURCE_CACHE is required}")"
build_root="$(cygpath -u "${VAST_FFMPEG_BUILD_ROOT:?VAST_FFMPEG_BUILD_ROOT is required}")"
source_stage="$build_root/corresponding-source"
work_root="$build_root/work"

case "$build_root" in
  /[a-zA-Z]/VastBuild/ffmpeg-9.0.1) ;;
  *)
    echo "Refusing to clean unexpected FFmpeg build root: $build_root" >&2
    exit 2
    ;;
esac

export SOURCE_DATE_EPOCH="1786492800"

echo '[Vast FFmpeg] Packaging pristine corresponding source'
for source_archive in "$toolchain_source_root"/*.src.tar.zst; do
  gpg --homedir /etc/pacman.d/gnupg --batch --verify "$source_archive.sig" "$source_archive"
done

rm -rf "$source_stage"
mkdir -p "$source_stage/sources" "$source_stage/toolchain-sources" "$source_stage/recipe/windows"

for source_archive in \
  ffmpeg-9.0.1.tar.xz \
  x264-b35605ace3ddf7c1a5d67a2eb553f034aef41d55.tar \
  libvpx-1.15.2.tar.gz \
  opus-1.5.2.tar.gz \
  libogg-1.3.6.tar.xz \
  libvorbis-1.3.7.tar.xz \
  lame-3.100.tar.gz; do
  tar -xf "$download_root/$source_archive" -C "$source_stage/sources"
done

cp "$toolchain_source_root"/*.src.tar.zst "$toolchain_source_root"/*.src.tar.zst.sig "$source_stage/toolchain-sources/"
cp "$repo_root/third_party/ffmpeg/ffmpeg-build.lock.json" "$source_stage/recipe/"
cp "$repo_root/third_party/ffmpeg/README.md" "$repo_root/third_party/ffmpeg/BUILD.md" "$repo_root/third_party/ffmpeg/CAPABILITIES.md" "$source_stage/recipe/"
cp -a "$repo_root/third_party/ffmpeg/scripts" "$source_stage/recipe/"
cp \
  "$repo_root/scripts/build-vast-ffmpeg.ps1" \
  "$repo_root/scripts/avidae-ffmpeg-capabilities.cjs" \
  "$repo_root/scripts/generate-vast-ffmpeg-provenance.cjs" \
  "$repo_root/scripts/check-ffmpeg-release-compliance.cjs" \
  "$source_stage/recipe/windows/"

for build_evidence in config.h config_components.h ffbuild/config.mak; do
  sed "s|$build_root|/usr/src/vast-ffmpeg|g" "$work_root/ffmpeg/$build_evidence" > "$source_stage/recipe/$(basename "$build_evidence")"
done

find "$source_stage" -exec touch -h -d "@$SOURCE_DATE_EPOCH" {} +
tar --sort=name --mtime="@$SOURCE_DATE_EPOCH" --owner=0 --group=0 --numeric-owner \
  -I 'zstd -12 -T0' -cf "$build_root/ffmpeg-corresponding-source-win64.tar.zst" \
  -C "$source_stage" .

echo '[Vast FFmpeg] Pristine corresponding-source archive completed.'
