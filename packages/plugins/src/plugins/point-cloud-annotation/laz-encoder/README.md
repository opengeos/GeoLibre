# laz-encoder

A minimal LASzip encoder for the point cloud annotator's LAZ export, built from
[laz-rs](https://github.com/laz-rs/laz-rs) (the `laz` crate) with
`wasm-bindgen`. No npm package offers LAZ *compression* in the browser
(`laz-perf` and `@loaders.gl/las` only decode), so it is vendored here.

- `crate/` is the Rust source. `laszip_vlr_data` returns the `laszip encoded`
  VLR payload for a point format; `compress_points` compresses the point
  records after a caller-built LAS header and VLRs.
- `laz_encoder.js`, `laz_encoder.d.ts` and `laz_encoder_bg.wasm` are the
  generated `wasm-pack --target web` output. Do not edit them by hand.

To rebuild (needs Rust with the `wasm32-unknown-unknown` target and
`wasm-pack`):

```bash
cd packages/plugins/src/plugins/point-cloud-annotation/laz-encoder/crate
wasm-pack build --target web --release --out-dir ../pkg-build
cp ../pkg-build/laz_encoder.js ../pkg-build/laz_encoder.d.ts ../pkg-build/laz_encoder_bg.wasm ..
rm -rf ../pkg-build target
```

`tests/point-cloud-annotation.test.ts` round-trips a LAZ file through
`laz-perf` and compares every record with the uncompressed LAS export.
