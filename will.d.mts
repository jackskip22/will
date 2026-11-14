// SPDX-License-Identifier: MIT
import type { Buffer } from 'node:buffer';

/** Offsets address original UTF-8 bytes, not JavaScript string positions. */
export type ByteSpan = [start: number, end: number];
export type Law = 'edit' | 'append' | 'keep';
export type Path = 'working' | 'authoring';
export type DocumentBytes = string | Uint8Array;
export type Binding = 'markdown' | 'text';
export interface ReadOptions { binding?: Binding }

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
  | { insert: DocumentBytes; insertBase64?: never }
  | { insertBase64: string; insert?: never }
);

export type Decision =
  | { outcome: 'applied' }
  | {
      outcome: 'invalid';
      reason: 'precondition';
      rule: 'unknown_path' | 'unknown_binding' | 'malformed_splice' | 'out_of_range_splice' | 'overlapping_splices';
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

export type SealRegion = { region: number; law: Law } & (
  | { status: 'intact'; sealedBytes: number }
  | { status: 'changed'; reason: 'length_mismatch' | 'digest_mismatch'; sealedBytes: number }
  | { status: 'unsealed'; reason: 'absent' | 'malformed_seal' | 'unsupported_seal' | 'unsupported_law' | 'document_faulted' }
);

export interface SealVerification {
  faulted: boolean;
  faults: Fault[];
  regions: SealRegion[];
}

export interface SealVector {
  id: string;
  kind: 'seal' | 'verify';
  expect: SealVerification | { docBase64: string } | { error: string; region?: number };
  [field: string]: unknown;
}

export interface StripResult { bytes: Buffer; removed: number }
export interface StripVector {
  id: string;
  kind: 'strip';
  expect: { docBase64: string; removed: number } | { error: string };
  [field: string]: unknown;
}

export function bindingForFile(file: string): Binding;
/** Preserve JSON numeric lexemes for evaluation. Treat the decoded value as unvalidated input. */
export function exactJSON(text: string): unknown;
export function parse(bytes: DocumentBytes, options?: ReadOptions): ParseResult;
/** Judges one act without mutating the document or splices. Defaults to the working path. */
export function evaluate(before: DocumentBytes, splices: readonly Splice[], path?: Path, options?: ReadOptions): Decision;
export function diffSplices(before: DocumentBytes, after: DocumentBytes, options?: ReadOptions): Array<{
  start: number;
  end: number;
  insertBase64: string;
}>;
export function compare(before: DocumentBytes, after: DocumentBytes, options?: ReadOptions): Decision;
/** Authoring only. Returns a copy; refuses faulty, changed or unreadable seals and intent overflow. */
export function seal(bytes: DocumentBytes, options?: ReadOptions): Buffer;
/** Exact text integrity only; no authenticity, permission, or native DOCX/PDF structure claim. */
export function verifySeals(bytes: DocumentBytes, options?: ReadOptions): SealVerification;
/** Authoring only. Removes marker lines from a copy; refuses faulty input and preserves every other byte. */
export function strip(bytes: DocumentBytes, options?: ReadOptions): StripResult;
/** Pass JSON text to preserve exact decimal and exponent offsets in vectors. */
export function checkVectors(spec: string | { vectors: readonly Vector[]; sealVectors?: readonly SealVector[]; textVectors?: readonly Vector[]; stripVectors?: readonly StripVector[] }): {
  total: number;
  failures: Array<{ id: string; got: unknown }>;
};
