// Reads the fields of an input from untrusted JSON by a small table: one entry per
// field, with its type and range. A missing field, an unknown field, a wrong type or a
// number outside its range makes the whole body bad (null). Nothing is filled in.
import { isObject, isTextUpTo, isWholeNumber } from './request_checks'
import { parse as parseScore } from './score'
import { utf8Bytes } from './utf8'

type Nullable = { nullable?: true }

type FieldSpec = (
	| { type: 'whole'; max?: number }
	| { type: 'text'; max: number; mayBeEmpty?: true }
	| { type: 'flag' }
	| { type: 'oneOf'; values: readonly string[] }
	| { type: 'score' }
	| { type: 'object'; fields: InputFields }
	| {
			type: 'record'
			maxKeys: number
			maxKeyLength: number
			// The most UTF-8 bytes the record has as JSON; a key's limit counts bytes too.
			maxSize: number
	  }
) &
	Nullable

export type InputFields = { readonly [field: string]: FieldSpec }

// Any names with a text, number or flag each, as sent.
type FreeRecord = { [name: string]: string | number | boolean }

type FieldValue<Field extends FieldSpec> = Field extends { type: 'whole' }
	? number
	: Field extends { type: 'text' }
		? string
		: Field extends { type: 'flag' }
			? boolean
			: Field extends { type: 'oneOf'; values: readonly (infer Value)[] }
				? Value
				: Field extends { type: 'score' }
					? string
					: Field extends { type: 'object'; fields: infer Inner }
						? Inner extends InputFields
							? InputValues<Inner>
							: never
						: Field extends { type: 'record' }
							? FreeRecord
							: never

export type InputValues<Spec extends InputFields> = {
	-readonly [Name in keyof Spec]: Spec[Name] extends { nullable: true }
		? FieldValue<Spec[Name]> | null
		: FieldValue<Spec[Name]>
}

type Plain = { [field: string]: unknown }

function readRecord(
	field: { maxKeys: number; maxKeyLength: number; maxSize: number },
	value: unknown,
): FreeRecord | undefined {
	// Lua encodes an empty table as `[]`: that is an empty record. Any other array is not one.
	if (Array.isArray(value) && value.length === 0) return {}
	if (!isObject(value)) return undefined
	const names = Object.keys(value)
	if (names.length > field.maxKeys) return undefined
	const result: FreeRecord = {}
	for (const name of names) {
		const each = value[name]
		if (name === '__proto__' || utf8Bytes(name) > field.maxKeyLength)
			return undefined
		if (
			typeof each !== 'string' &&
			typeof each !== 'boolean' &&
			!(typeof each === 'number' && Number.isFinite(each))
		)
			return undefined
		result[name] = each
	}
	return utf8Bytes(JSON.stringify(result)) > field.maxSize ? undefined : result
}

function readField(field: FieldSpec, value: unknown): unknown | undefined {
	if (value === null) return field.nullable === true ? null : undefined
	switch (field.type) {
		case 'whole':
			return isWholeNumber(value, field.max) ? value : undefined
		case 'text':
			if (field.mayBeEmpty === true && value === '') return value
			return isTextUpTo(value, field.max) ? value : undefined
		case 'flag':
			return typeof value === 'boolean' ? value : undefined
		case 'oneOf':
			return typeof value === 'string' && field.values.includes(value)
				? value
				: undefined
		case 'score':
			return parseScore(value) ?? undefined
		case 'object': {
			const inner = readFields(field.fields, value)
			return inner === null ? undefined : inner
		}
		case 'record':
			return readRecord(field, value)
	}
}

function readFields(spec: InputFields, body: unknown): Plain | null {
	if (!isObject(body)) return null
	const names = Object.keys(spec)
	if (Object.keys(body).some((name) => !names.includes(name))) return null
	const result: Plain = {}
	for (const name of names) {
		const value = readField(spec[name], body[name])
		if (value === undefined) return null
		result[name] = value
	}
	return result
}

// The typed body, or null when it is bad.
export function readInput<Spec extends InputFields>(
	spec: Spec,
	body: unknown,
): InputValues<Spec> | null {
	return readFields(spec, body) as InputValues<Spec> | null
}
