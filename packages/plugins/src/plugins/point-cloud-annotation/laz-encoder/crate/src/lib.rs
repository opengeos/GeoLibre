//! A minimal LASzip encoder for the browser.
//!
//! JavaScript builds the LAS header and VLRs itself; this module supplies the
//! `laszip encoded` VLR payload for a point format and compresses the point
//! records. Compression writes an absolute chunk-table offset, so the caller
//! passes the header + VLR prefix and gets back the whole file.

use std::io::Cursor;

use laz::{LasZipCompressor, LazItemRecordBuilder, LazVlr};
use wasm_bindgen::prelude::*;

fn vlr_for(point_format: u8, extra_bytes: u16) -> Result<LazVlr, JsError> {
    let items = LazItemRecordBuilder::default_for_point_format_id(point_format, extra_bytes)
        .map_err(|e| JsError::new(&e.to_string()))?;
    Ok(LazVlr::from_laz_items(items))
}

/// The payload of the `laszip encoded` VLR (user id "laszip encoded", record
/// id 22204) for LAS point data record `point_format` with `extra_bytes`.
#[wasm_bindgen]
pub fn laszip_vlr_data(point_format: u8, extra_bytes: u16) -> Result<Vec<u8>, JsError> {
    let vlr = vlr_for(point_format, extra_bytes)?;
    let mut out = Vec::new();
    vlr.write_to(&mut out).map_err(|e| JsError::new(&e.to_string()))?;
    Ok(out)
}

/// Compresses `points` (uncompressed records of `record_length` bytes) and
/// appends them to `prefix` (the LAS header and VLRs, ending exactly at the
/// point data offset). Returns the complete LAZ file.
#[wasm_bindgen]
pub fn compress_points(
    prefix: &[u8],
    points: &[u8],
    point_format: u8,
    extra_bytes: u16,
    record_length: usize,
) -> Result<Vec<u8>, JsError> {
    if record_length == 0 || points.len() % record_length != 0 {
        return Err(JsError::new("point buffer is not a whole number of records"));
    }
    let vlr = vlr_for(point_format, extra_bytes)?;
    let mut cursor = Cursor::new(Vec::with_capacity(prefix.len() + points.len() / 4));
    std::io::Write::write_all(&mut cursor, prefix).map_err(|e| JsError::new(&e.to_string()))?;
    let mut compressor =
        LasZipCompressor::new(cursor, vlr).map_err(|e| JsError::new(&e.to_string()))?;
    compressor
        .compress_many(points)
        .map_err(|e| JsError::new(&e.to_string()))?;
    compressor.done().map_err(|e| JsError::new(&e.to_string()))?;
    Ok(compressor.into_inner().into_inner())
}
