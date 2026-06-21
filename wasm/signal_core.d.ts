/* tslint:disable */
/* eslint-disable */
/**
* Initialisation. Called automatically by wasm-bindgen on module load.
* We install a panic hook so Rust panics surface in the browser console
* rather than disappearing silently.
*/
export function _init(): void;
/**
* Build tag — JS can query this to confirm the WASM is the version it expects.
* @returns {string}
*/
export function build_tag(): string;
/**
* Decode a DSF file's bytes to PCM at the target sample rate.
* Returns interleaved f32 samples (L,R,L,R,...).
* Returns an empty Vec on any error (the JS side then falls back).
* @param {Uint8Array} bytes
* @param {number} target_rate
* @returns {Float32Array}
*/
export function decode_dsd_to_pcm(bytes: Uint8Array, target_rate: number): Float32Array;
/**
* Measure THD+N from a captured signal containing a known tone.
* Returns the THD+N ratio in dB (more negative = cleaner).
* @param {Float32Array} samples
* @param {number} sample_rate
* @param {number} fundamental_hz
* @returns {number}
*/
export function measure_thd_n(samples: Float32Array, sample_rate: number, fundamental_hz: number): number;
/**
* Compute Dynamic Range using the TT DR Meter algorithm.
* `samples` is interleaved (L,R,L,R,...). Returns an integer DR value.
*
* Per channel:
*   1. Split into 3-second non-overlapping blocks
*   2. Compute RMS of each block
*   3. Sort RMS values descending, take top 20%
*   4. DR_channel = peak_dB - mean(top 20% RMS)_dB
* Track DR = round(mean of channel DRs)
* @param {Float32Array} samples
* @param {number} sample_rate
* @param {number} channels
* @returns {number}
*/
export function compute_dr(samples: Float32Array, sample_rate: number, channels: number): number;
/**
* Analyze whether a file's claimed hi-res spec matches its actual content.
* `samples` is interleaved; we only look at channel 0.
* @param {Float32Array} samples
* @param {number} sample_rate
* @param {number} channels
* @param {number} claimed_rate
* @param {number} claimed_bits
* @returns {any}
*/
export function analyze_hi_res(samples: Float32Array, sample_rate: number, channels: number, claimed_rate: number, claimed_bits: number): any;
/**
* Parse audio file headers. `bytes` is the first 256 KB (or 1 MB).
* `ext` is the file extension (lowercase, no dot).
* `want_art` controls whether embedded pictures are extracted.
*
* Returns a JS object. Picture bytes (if extracted) come back via
* `take_last_picture()` immediately after — this avoids serialising
* megabyte-sized binary data through serde_json.
* @param {Uint8Array} bytes
* @param {string} ext
* @param {boolean} want_art
* @returns {any}
*/
export function parse_metadata(bytes: Uint8Array, ext: string, want_art: boolean): any;
/**
* Retrieve picture bytes from the last parse_metadata call.
* Returns an empty Vec if no picture was found.
* @returns {Uint8Array}
*/
export function take_last_picture(): Uint8Array;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly analyze_hi_res: (a: number, b: number, c: number, d: number, e: number, f: number) => number;
  readonly build_tag: (a: number) => void;
  readonly compute_dr: (a: number, b: number, c: number, d: number) => number;
  readonly decode_dsd_to_pcm: (a: number, b: number, c: number, d: number) => void;
  readonly measure_thd_n: (a: number, b: number, c: number, d: number) => number;
  readonly parse_metadata: (a: number, b: number, c: number, d: number, e: number) => number;
  readonly take_last_picture: (a: number) => void;
  readonly _init: () => void;
  readonly __wbindgen_add_to_stack_pointer: (a: number) => number;
  readonly __wbindgen_export_0: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_1: (a: number, b: number) => number;
  readonly __wbindgen_export_2: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
