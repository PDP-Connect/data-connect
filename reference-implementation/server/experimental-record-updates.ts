// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createRequire } from "node:module";
import {
	assertRecordIdentity,
	normalizePrimaryKey,
} from "./record-expand-helpers.ts";

// Prototype profile syntax, deliberately distinct from a RECORD snapshot.
export const EXPERIMENTAL_PARTIAL_UPDATE_TYPE =
	"PDPP_EXPERIMENTAL_PARTIAL_UPDATE_V1";
export interface ExperimentalUpdateInput {
	data?: unknown;
	key: unknown;
	op?: unknown;
	remove?: unknown;
	set?: unknown;
	type?: unknown;
}
export interface ExperimentalStream {
	primary_key?: unknown;
	schema?: unknown;
	semantics?: unknown;
}
interface Validator {
	errors?: unknown;
	(data: unknown): boolean;
}
const requireFromContract = createRequire(
	import.meta.resolve("@pdpp/reference-contract"),
);
const Ajv = requireFromContract("ajv/dist/2020.js") as new (
	options: object,
) => { compile: (schema: object) => Validator };
const ajv = new Ajv({
	addUsedSchema: false,
	allErrors: true,
	ownProperties: true,
	strict: false,
});
(requireFromContract("ajv-formats") as (instance: unknown) => void)(ajv);
const validators = new Map<string, Validator>();

export function experimentalRecordUpdatesEnabled(): boolean {
	return process.env.PDPP_EXPERIMENTAL_RECORD_UPDATES === "1";
}
export function recordUpdateError(
	code: string,
	message: string,
): Error & { code: string } {
	return Object.assign(new Error(message), { code });
}
function isObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function containsNonFiniteNumber(value: unknown): boolean {
	if (typeof value === "number") {
		return !Number.isFinite(value);
	}
	if (value !== null && typeof value === "object") {
		return Object.values(value).some(containsNonFiniteNumber);
	}
	return false;
}
export function isPartialInstruction(input: ExperimentalUpdateInput): boolean {
	return (
		input.type === EXPERIMENTAL_PARTIAL_UPDATE_TYPE ||
		(experimentalRecordUpdatesEnabled() &&
			(input.set !== undefined || input.remove !== undefined))
	);
}
export function validateExperimentalSnapshot(
	stream: ExperimentalStream | null,
	key: unknown,
	data: unknown,
): void {
	if (!isObject(data)) {
		throw recordUpdateError(
			"invalid_record_schema",
			"RECORD data must be an object",
		);
	}
	if (containsNonFiniteNumber(data)) {
		throw recordUpdateError(
			"invalid_record_schema",
			"RECORD numbers must remain finite after JSON parsing",
		);
	}
	const primaryKey = normalizePrimaryKey(stream?.primary_key);
	const scalarKeyParts =
		typeof key === "string" || typeof key === "number" ? [key] : [];
	const keyParts = Array.isArray(key) ? key : scalarKeyParts;
	if (
		primaryKey.length > 0 &&
		(keyParts.length !== primaryKey.length ||
			keyParts.some(
				(part) =>
					part === null || part === undefined || typeof part === "object",
			))
	) {
		throw recordUpdateError(
			"invalid_record_identity",
			"Key must provide every declared primary-key value",
		);
	}
	for (const field of primaryKey) {
		if (!Object.hasOwn(data, field)) {
			throw recordUpdateError(
				"invalid_record_identity",
				`Missing primary-key field '${field}'`,
			);
		}
	}
	assertRecordIdentity(primaryKey, key, data);
	if (stream?.schema && typeof stream.schema === "object") {
		const cacheKey = JSON.stringify(stream.schema);
		let validate = validators.get(cacheKey);
		if (!validate) {
			validate = ajv.compile(stream.schema);
			validators.set(cacheKey, validate);
		}
		if (!validate(data)) {
			throw recordUpdateError(
				"invalid_record_schema",
				"RECORD data does not satisfy the stream schema",
			);
		}
	}
}
export function applyPartialInstruction(
	input: ExperimentalUpdateInput,
	stream: ExperimentalStream | null,
	current: unknown,
): Record<string, unknown> {
	if (!experimentalRecordUpdatesEnabled()) {
		throw recordUpdateError(
			"invalid_partial_update",
			"Experimental partial-update profile is disabled",
		);
	}
	if (
		input.type !== EXPERIMENTAL_PARTIAL_UPDATE_TYPE ||
		input.op !== undefined ||
		input.data !== undefined ||
		!isObject(input.set) ||
		!Array.isArray(input.remove) ||
		input.remove.some(
			(field) => typeof field !== "string" || field.length === 0,
		) ||
		Object.keys(input.set).some(
			(field) =>
				field.length === 0 || (input.remove as unknown[]).includes(field),
		) ||
		new Set(input.remove).size !== input.remove.length
	) {
		throw recordUpdateError(
			"invalid_partial_update",
			"Instruction requires distinct top-level set fields and remove field names",
		);
	}
	if (stream?.semantics !== "mutable_state") {
		throw recordUpdateError(
			"invalid_partial_update",
			"Partial updates require a mutable_state stream",
		);
	}
	if (!isObject(current)) {
		throw recordUpdateError(
			"invalid_partial_update",
			"Partial update requires an existing live record",
		);
	}
	const result = { ...current, ...input.set };
	for (const field of input.remove as string[]) {
		delete result[field];
	}
	validateExperimentalSnapshot(stream, input.key, result);
	return result;
}
export function equalJsonValues(left: unknown, right: unknown): boolean {
	if (left === right) {
		return true;
	}
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length &&
			left.every((value, index) => equalJsonValues(value, right[index]))
		);
	}
	if (isObject(left) && isObject(right)) {
		const keys = Object.keys(left);
		return (
			keys.length === Object.keys(right).length &&
			keys.every(
				(key) =>
					Object.hasOwn(right, key) && equalJsonValues(left[key], right[key]),
			)
		);
	}
	return false;
}
export function enforceAppendOnlyDuplicate(
	stream: ExperimentalStream | null,
	currentData: unknown,
	newData: unknown,
): boolean {
	if (
		!experimentalRecordUpdatesEnabled() ||
		stream?.semantics !== "append_only"
	) {
		return false;
	}
	if (!equalJsonValues(currentData, newData)) {
		throw recordUpdateError(
			"append_only_record_conflict",
			"Append-only record already exists with differing data",
		);
	}
	return true;
}
