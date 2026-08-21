/**
 * Sample encoded polylines offered by the Add Encoded Polyline Layer dialog.
 *
 * Kept out of the dialog component so the samples can be decoded in a test:
 * an encoded polyline is opaque, so a sample that silently decodes to garbage
 * (or fails to decode at all) is invisible until someone loads it in the UI.
 * `tests/polyline-samples.test.ts` decodes every entry with the precision and
 * unescape settings the dialog applies when the sample is picked.
 */
export interface PolylineSample {
  /** i18n key for the entry's label in the sample picker. */
  key:
    | "addData.polyline.sampleGoogle"
    | "addData.polyline.sampleValhalla"
    | "addData.polyline.sampleEscaped"
    | "addData.polyline.sampleMultiLine";
  /** The encoded text pasted into the textarea when this sample is picked. */
  value: string;
  /** Coordinate precision the sample is encoded at. */
  precision: number;
  /** Whether the dialog's "unescape backslashes" toggle is turned on. */
  unescape?: boolean;
}

export const SAMPLE_POLYLINES: PolylineSample[] = [
  {
    key: "addData.polyline.sampleGoogle",
    value: "_p~iF~ps|U_ulLnnqC_mqNvxq`@",
    precision: 5,
    unescape: true,
  },
  {
    key: "addData.polyline.sampleValhalla",
    value: "_o`diA~gw}qC_pR_pR_pR_af@",
    precision: 6,
    unescape: true,
  },
  {
    // A San Francisco -> Monterey route whose encoding happens to contain a
    // literal backslash, written here the way a JSON payload would carry it:
    // doubled. The TypeScript source therefore holds four backslashes, which
    // is two at runtime, which the dialog's unescape step collapses back to
    // the one byte the decoder needs. Without that step the backslash pair
    // truncates a varint and the decode fails, so this entry only works when
    // "unescape" is on, which is exactly what it is here to demonstrate.
    key: "addData.polyline.sampleEscaped",
    value: "c|peFjaejV~ek@__\\\\~}d@ku|@~eiAcf[z_hA~kO",
    precision: 5,
    unescape: true,
  },
  {
    key: "addData.polyline.sampleMultiLine",
    value: "_p~iF~ps|U_ulLnnqC_mqNvxq`@\n_ibE_seK_seK_seK\nmc_Ie}hV_c_@_c_@",
    precision: 5,
    unescape: true,
  },
];
