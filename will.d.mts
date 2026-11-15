// SPDX-License-Identifier: MIT
import type { Buffer } from 'node:buffer';

/** Offsets address original UTF-8 bytes, not JavaScript string positions. */
export type ByteSpan = [start: number, end: number];
export type Law = 'edit' | 'append' | 'keep';
export type Path = 'working' | 'authoring';
export type DocumentBytes = string | Uint8Array;

export type Fault =
  | { mode: 'invalid_utf8'; line: null; byteSpan: ByteSpan }
  | {
      mode: 'unpaired_marker' | 'malformed_marker' | 'unknown_law' | 'unknown_version' | 'intent_over_bound';
      line: number;
      byteSpan: ByteSpan;
    };

export interface Marker {
  line: number;
  byteSpan: ByteSpan;
}

export interface Region {
  index: number;
  law: Law;
  intent: string | null;
  opener: Marker;
  closer: Marker;
  governedSpan: ByteSpan;
}

export interface ParseResult {
  regions: Region[];
  faults: Fault[];
  faulted: boolean;
}

export type Splice = {
  start: number;
  end: number;
} & (
  | { insert: string | Buffer; insertBase64?: never }
  | { insertBase64: string; insert?: never }
);

export type Decision =
  | { outcome: 'applied' }
  | {
      outcome: 'invalid';
      reason: 'precondition';
      rule: 'unknown_path' | 'malformed_splice' | 'out_of_range_splice' | 'overlapping_splices';
    }
  | ({ outcome: 'refused'; reason: 'document_law' } & (
      | { rule: 'before_faulted' | 'result_faulted'; faults: Fault[] }
      | { rule: 'marker_span_touched'; region: number; law: Law }
      | { rule: 'law_violated'; region: number; law: 'keep' | 'append' }
      | { rule: 'marker_sequence_mismatch' }
    ));

export interface Vector {
  id: string;
  kind: 'parse' | 'evaluate';
  expect: ParseResult | Decision;
  [field: string]: unknown;
}

export function parse(bytes: DocumentBytes): ParseResult;
/** Judges one act without mutating the document or splices. Defaults to the working path. */
export function evaluate(before: DocumentBytes, splices: readonly Splice[], path?: Path): Decision;
export function diffSplices(before: DocumentBytes, after: DocumentBytes): Array<{
  start: number;
  end: number;
  insertBase64: string;
}>;
export function compare(before: DocumentBytes, after: DocumentBytes): Decision;
/** Pass JSON text to preserve exact decimal and exponent offsets in vectors. */
export function checkVectors(spec: string | { vectors: readonly Vector[] }): {
  total: number;
  failures: Array<{ id: string; got: unknown }>;
};
