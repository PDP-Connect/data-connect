// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Remembers the stored JSON text a parsed record came from. JSON.parse rounds
// numbers through binary64, so a predicate that must compare stored numbers
// exactly needs the original lexemes. A WeakMap keeps the text out of the
// record object: spreads, projections and serialization never see it.
const sourceTextByRecord = new WeakMap<object, string>();

export function rememberRecordSourceText<T extends object>(
	record: T,
	text: string,
): T {
	sourceTextByRecord.set(record, text);
	return record;
}

export function recordSourceText(record: object): string | undefined {
	return sourceTextByRecord.get(record);
}
