/**
 * Haxe conditional compilation analysis.
 *
 * Finds `#if` / `#elseif` / `#else` / `#end` directives in Haxe source,
 * evaluates their conditions against a set of defines using the same rules as
 * the Haxe compiler, and reports the character ranges that would be skipped.
 *
 * This module has no dependency on the VS Code API so it can be unit tested.
 */

/**
 * Returns the value of a define, `undefined` if it is not defined, or `null`
 * if it is not known whether it is defined (conditions using it are then not evaluated).
 */
export type DefineLookup = (name: string) => string | undefined | null;

export interface Range {
	start: number;
	end: number;
}

export interface ConditionInfo {
	/** Source text of the condition. */
	text: string;
	/** Evaluation result, or `undefined` if it could not be evaluated. */
	result: boolean | undefined;
	/** Why the condition could not be evaluated. */
	error?: string;
	/** Define names referenced by the condition, in order of appearance. */
	identifiers: string[];
}

export interface Directive {
	kind: 'if' | 'elseif' | 'else' | 'end';
	/** Offset of the `#`. */
	start: number;
	/** Offset just after the directive, including its condition. */
	end: number;
	condition?: ConditionInfo;
	/** Whether the code following this directive (up to the next directive in the same chain) is compiled. */
	branchActive?: boolean;
	/** Whether the directive itself sits in code that is compiled. */
	reachable: boolean;
}

export interface Analysis {
	/** Ranges of code that are not compiled, sorted and non-overlapping. */
	inactive: Range[];
	directives: Directive[];
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

const enum T {
	Ident,
	String,
	Number,
	Op,
	Directive,
	Other,
	EOF,
}

interface Token {
	kind: T;
	value: string;
	start: number;
	end: number;
}

const isIdentStart = (c: string) => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentChar = (c: string) => isIdentStart(c) || (c >= '0' && c <= '9');
const isDigit = (c: string) => c >= '0' && c <= '9';

/** Multi-character operators that matter for conditions, longest first. */
const OPERATORS = ['...', '&&', '||', '==', '!=', '<=', '>='];

/**
 * A minimal Haxe tokenizer. It only needs to be precise about the things
 * that can hide a `#` (comments, strings, regular expressions) and about the
 * tokens that can appear in a condition.
 */
class Lexer {
	private pos = 0;
	private peeked: Token | undefined;

	constructor(readonly text: string) {}

	peek(): Token {
		return (this.peeked ??= this.read());
	}

	next(): Token {
		const tok = this.peek();
		this.peeked = undefined;
		return tok;
	}

	private read(): Token {
		const text = this.text;
		for (;;) {
			const c = text.charAt(this.pos);
			if (c === '') return { kind: T.EOF, value: '', start: text.length, end: text.length };
			if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
				this.pos++;
				continue;
			}
			if (c === '/' && text.charAt(this.pos + 1) === '/') {
				const nl = text.indexOf('\n', this.pos);
				this.pos = nl < 0 ? text.length : nl;
				continue;
			}
			if (c === '/' && text.charAt(this.pos + 1) === '*') {
				const close = text.indexOf('*/', this.pos + 2);
				this.pos = close < 0 ? text.length : close + 2;
				continue;
			}
			break;
		}

		const start = this.pos;
		const c = text.charAt(start);
		const tok = (kind: T, value = text.slice(start, this.pos)): Token => ({ kind, value, start, end: this.pos });

		if (c === '"' || c === "'") {
			const value = this.readString(c);
			return tok(T.String, value);
		}
		if (c === '~' && text.charAt(start + 1) === '/') {
			this.readRegex();
			return tok(T.Other);
		}
		if (c === '#' && isIdentStart(text.charAt(start + 1))) {
			this.pos++;
			while (isIdentChar(text.charAt(this.pos))) this.pos++;
			return tok(T.Directive, text.slice(start + 1, this.pos));
		}
		if (isIdentStart(c)) {
			while (isIdentChar(text.charAt(this.pos))) this.pos++;
			return tok(T.Ident);
		}
		if (isDigit(c) || (c === '.' && isDigit(text.charAt(start + 1)))) {
			this.readNumber();
			return tok(T.Number);
		}
		for (const op of OPERATORS) {
			if (text.startsWith(op, start)) {
				this.pos += op.length;
				return tok(T.Op);
			}
		}
		this.pos++;
		return tok('!<>-().,'.includes(c) ? T.Op : T.Other);
	}

	/** Reads a string literal and returns its (unescaped) contents. */
	private readString(quote: string): string {
		const text = this.text;
		let value = '';
		this.pos++;
		while (this.pos < text.length) {
			const c = text.charAt(this.pos);
			if (c === quote) {
				this.pos++;
				break;
			}
			if (c === '\\') {
				value += unescape(text.charAt(this.pos + 1));
				this.pos += 2;
				continue;
			}
			if (quote === "'" && c === '$' && text.charAt(this.pos + 1) === '{') {
				// Interpolated expression: skip tokens until the matching brace so
				// that quotes inside it don't end the string.
				this.pos += 2;
				let depth = 1;
				while (depth > 0) {
					const t = this.read();
					if (t.kind === T.EOF) return value;
					if (t.value === '{') depth++;
					else if (t.value === '}') depth--;
				}
				continue;
			}
			value += c;
			this.pos++;
		}
		return value;
	}

	private readRegex() {
		const text = this.text;
		this.pos += 2;
		while (this.pos < text.length) {
			const c = text.charAt(this.pos);
			if (c === '\\') {
				this.pos += 2;
				continue;
			}
			if (c === '\n') return;
			this.pos++;
			if (c === '/') break;
		}
		while (isIdentChar(text.charAt(this.pos))) this.pos++;
	}

	private readNumber() {
		const text = this.text;
		if (text.charAt(this.pos) === '0' && /[xX]/.test(text.charAt(this.pos + 1))) {
			this.pos += 2;
			while (/[0-9a-fA-F_]/.test(text.charAt(this.pos))) this.pos++;
		} else {
			while (isDigit(text.charAt(this.pos)) || text.charAt(this.pos) === '_') this.pos++;
			// A `.` only belongs to the number if it isn't the start of `...`.
			if (text.charAt(this.pos) === '.' && text.charAt(this.pos + 1) !== '.') {
				this.pos++;
				while (isDigit(text.charAt(this.pos)) || text.charAt(this.pos) === '_') this.pos++;
			}
			if (/[eE]/.test(text.charAt(this.pos)) && /[-+0-9]/.test(text.charAt(this.pos + 1))) {
				this.pos += 2;
				while (isDigit(text.charAt(this.pos))) this.pos++;
			}
		}
		// Type suffixes such as `i64` or `f32`.
		while (isIdentChar(text.charAt(this.pos))) this.pos++;
	}
}

function unescape(c: string): string {
	switch (c) {
		case 'n':
			return '\n';
		case 't':
			return '\t';
		case 'r':
			return '\r';
		default:
			return c;
	}
}

// ---------------------------------------------------------------------------
// Condition parsing
// ---------------------------------------------------------------------------

type Expr =
	| { kind: 'ident'; name: string }
	| { kind: 'string'; value: string }
	| { kind: 'number'; value: number }
	| { kind: 'version'; value: string }
	| { kind: 'not'; e: Expr }
	| { kind: 'neg'; e: Expr }
	| { kind: 'binop'; op: string; a: Expr; b: Expr };

class ConditionError extends Error {}

/** Parses the condition after `#if` / `#elseif`, mirroring the compiler's `parse_macro_cond`. */
class ConditionParser {
	readonly identifiers: string[] = [];
	/** End offset of the last consumed token. */
	lastEnd = -1;

	constructor(private readonly lex: Lexer) {}

	/**
	 * Without parentheses a condition is a single (possibly negated) operand,
	 * so `#if js trace("x"); #end` is valid and the condition is just `js`.
	 */
	parseTopLevel(): Expr {
		const t = this.take();
		switch (t.kind) {
			case T.Ident:
				return this.ident(this.dottedName(t.value, true));
			case T.String:
				return { kind: 'string', value: t.value };
			case T.Number:
				return { kind: 'number', value: parseNumber(t.value) };
			case T.Op:
				if (t.value === '!') return { kind: 'not', e: this.parseTopLevel() };
				if (t.value === '-') return { kind: 'neg', e: this.parseTopLevel() };
				if (t.value === '(') {
					const e = this.parseExpr();
					this.expect(')');
					return e;
				}
		}
		throw new ConditionError(`Unexpected '${t.value}' in condition`);
	}

	private parseExpr(): Expr {
		let e = this.parseAnd();
		while (this.lex.peek().value === '||') {
			this.take();
			e = { kind: 'binop', op: '||', a: e, b: this.parseAnd() };
		}
		return e;
	}

	private parseAnd(): Expr {
		let e = this.parseCompare();
		while (this.lex.peek().value === '&&') {
			this.take();
			e = { kind: 'binop', op: '&&', a: e, b: this.parseCompare() };
		}
		return e;
	}

	private parseCompare(): Expr {
		let e = this.parseUnary();
		for (;;) {
			const t = this.lex.peek();
			if (t.kind !== T.Op || !['==', '!=', '<', '<=', '>', '>='].includes(t.value)) return e;
			this.take();
			e = { kind: 'binop', op: t.value, a: e, b: this.parseUnary() };
		}
	}

	private parseUnary(): Expr {
		const t = this.take();
		switch (t.kind) {
			case T.Ident: {
				const name = this.dottedName(t.value, false);
				if (this.lex.peek().value === '(') return this.call(name);
				return this.ident(name);
			}
			case T.String:
				return { kind: 'string', value: t.value };
			case T.Number:
				return { kind: 'number', value: parseNumber(t.value) };
			case T.Op:
				if (t.value === '!') return { kind: 'not', e: this.parseUnary() };
				if (t.value === '-') return { kind: 'neg', e: this.parseUnary() };
				if (t.value === '(') {
					const e = this.parseExpr();
					this.expect(')');
					return e;
				}
		}
		throw new ConditionError(`Unexpected '${t.value}' in condition`);
	}

	private call(name: string): Expr {
		this.expect('(');
		const arg = this.take();
		this.expect(')');
		if (name !== 'version') throw new ConditionError(`Unsupported function '${name}' in condition`);
		if (arg.kind !== T.String) throw new ConditionError('version() expects a string literal');
		return { kind: 'version', value: arg.value };
	}

	/** Reads `a.b.c`. At the top level the parts must not be separated by whitespace. */
	private dottedName(first: string, adjacentOnly: boolean): string {
		let name = first;
		while (this.lex.peek().value === '.' && (!adjacentOnly || this.lex.peek().start === this.lastEnd)) {
			this.take();
			const part = this.take();
			if (part.kind !== T.Ident) throw new ConditionError(`Unexpected '${part.value}' in condition`);
			name += '.' + part.value;
		}
		return name;
	}

	private ident(name: string): Expr {
		if (!this.identifiers.includes(name)) this.identifiers.push(name);
		return { kind: 'ident', name };
	}

	private take(): Token {
		const t = this.lex.peek();
		// Never swallow the next directive, so that a broken condition doesn't
		// desynchronise the #if/#end nesting.
		if (t.kind === T.EOF || t.kind === T.Directive) throw new ConditionError('Incomplete condition');
		this.lex.next();
		this.lastEnd = t.end;
		return t;
	}

	private expect(value: string) {
		const t = this.take();
		if (t.value !== value) throw new ConditionError(`Expected '${value}' but found '${t.value}'`);
	}
}

function parseNumber(s: string): number {
	return Number(s.replace(/_/g, '').replace(/(?<=[0-9a-fA-F])([iuf]\d+)$/, ''));
}

// ---------------------------------------------------------------------------
// Condition evaluation (mirrors the compiler's `eval` / `cmp` / `is_true`)
// ---------------------------------------------------------------------------

interface SemVer {
	release: [number, number, number];
	pre: string[] | undefined;
}

type Value =
	| { t: 'null' }
	| { t: 'bool'; v: boolean }
	| { t: 'float'; v: number }
	| { t: 'string'; v: string }
	| { t: 'version'; v: SemVer };

const NULL: Value = { t: 'null' };
/** Marker for comparisons the compiler silently treats as "not comparable". */
const INCOMPARABLE = Symbol('incomparable');

export function parseVersion(s: string): SemVer | undefined {
	const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(s);
	if (!m) return undefined;
	return { release: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4]?.split('.') };
}

function compareVersions(a: SemVer, b: SemVer): number {
	for (let i = 0; i < 3; i++) {
		if (a.release[i] !== b.release[i]) return a.release[i] < b.release[i] ? -1 : 1;
	}
	if (!a.pre || !b.pre) return a.pre ? -1 : b.pre ? 1 : 0;
	for (let i = 0; i < Math.min(a.pre.length, b.pre.length); i++) {
		const x = a.pre[i];
		const y = b.pre[i];
		const xn = /^\d+$/.test(x);
		const yn = /^\d+$/.test(y);
		if (xn && yn) {
			if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
		} else if (xn !== yn) {
			return xn ? -1 : 1;
		} else if (x !== y) {
			return x < y ? -1 : 1;
		}
	}
	return Math.sign(a.pre.length - b.pre.length);
}

function describe(v: Value): string {
	switch (v.t) {
		case 'null':
			return 'null';
		case 'bool':
			return `bool ${v.v}`;
		case 'float':
			return `float ${v.v}`;
		case 'string':
			return `string "${v.v}"`;
		case 'version':
			return `version ${v.v.release.join('.')}${v.v.pre ? '-' + v.v.pre.join('.') : ''}`;
	}
}

function toFloat(s: Value & { t: 'string' }, other: Value): number {
	const n = s.v.trim() === '' ? NaN : Number(s.v);
	if (Number.isNaN(n)) throw new ConditionError(`Cannot compare ${describe(s)} and ${describe(other)}`);
	return n;
}

function toVersion(s: Value & { t: 'string' }): SemVer {
	const v = parseVersion(s.v);
	if (!v) throw new ConditionError(`Invalid version string "${s.v}". Should follow SemVer.`);
	return v;
}

const sign = (a: number | string | boolean, b: typeof a) => (a < b ? -1 : a > b ? 1 : 0);

function compare(a: Value, b: Value): number | typeof INCOMPARABLE {
	if (a.t === 'null' || b.t === 'null') return INCOMPARABLE;
	if (a.t === 'float' && b.t === 'float') return sign(a.v, b.v);
	if (a.t === 'string' && b.t === 'string') return sign(a.v, b.v);
	if (a.t === 'bool' && b.t === 'bool') return sign(a.v, b.v);
	if (a.t === 'string' && b.t === 'float') return sign(toFloat(a, b), b.v);
	if (a.t === 'float' && b.t === 'string') return sign(a.v, toFloat(b, a));
	if (a.t === 'version' && b.t === 'version') return compareVersions(a.v, b.v);
	if (a.t === 'string' && b.t === 'version') return compareVersions(toVersion(a), b.v);
	if (a.t === 'version' && b.t === 'string') return compareVersions(a.v, toVersion(b));
	if (a.t === 'bool' || b.t === 'bool') return INCOMPARABLE;
	throw new ConditionError(`Cannot compare ${describe(a)} and ${describe(b)}`);
}

function isTrue(v: Value): boolean {
	switch (v.t) {
		case 'null':
			return false;
		case 'bool':
			return v.v;
		case 'float':
			return v.v !== 0;
		default:
			return true;
	}
}

function evaluate(e: Expr, lookup: DefineLookup): Value {
	switch (e.kind) {
		case 'ident': {
			const v = lookup(e.name);
			if (v === null) throw new ConditionError(`The value of '${e.name}' is not known`);
			return v === undefined ? NULL : { t: 'string', v };
		}
		case 'string':
			return { t: 'string', v: e.value };
		case 'number':
			return { t: 'float', v: e.value };
		case 'version': {
			const v = parseVersion(e.value);
			if (!v) throw new ConditionError(`Invalid version string "${e.value}". Should follow SemVer.`);
			return { t: 'version', v };
		}
		case 'not':
			return { t: 'bool', v: !isTrue(evaluate(e.e, lookup)) };
		case 'neg': {
			const v = evaluate(e.e, lookup);
			if (v.t !== 'float') throw new ConditionError('Unsupported operation');
			return { t: 'float', v: -v.v };
		}
		case 'binop': {
			if (e.op === '&&') return { t: 'bool', v: isTrue(evaluate(e.a, lookup)) && isTrue(evaluate(e.b, lookup)) };
			if (e.op === '||') return { t: 'bool', v: isTrue(evaluate(e.a, lookup)) || isTrue(evaluate(e.b, lookup)) };
			const c = compare(evaluate(e.a, lookup), evaluate(e.b, lookup));
			if (e.op === '!=') return { t: 'bool', v: c !== 0 };
			if (c === INCOMPARABLE) return { t: 'bool', v: false };
			const ops: Record<string, (c: number) => boolean> = {
				'==': (c) => c === 0,
				'<': (c) => c < 0,
				'<=': (c) => c <= 0,
				'>': (c) => c > 0,
				'>=': (c) => c >= 0,
			};
			return { t: 'bool', v: ops[e.op](c) };
		}
	}
}

/** Evaluates a standalone condition such as `(js && !debug)`. Mainly useful for tests. */
export function evaluateCondition(source: string, lookup: DefineLookup): boolean {
	const parser = new ConditionParser(new Lexer(source));
	return isTrue(evaluate(parser.parseTopLevel(), lookup));
}

// ---------------------------------------------------------------------------
// Region analysis
// ---------------------------------------------------------------------------

interface Frame {
	/** Whether the code around the #if chain is compiled. */
	parentActive: boolean;
	/** Whether some earlier branch of the chain was taken. */
	taken: boolean;
	/** Set once a condition in the chain could not be evaluated; from then on nothing is greyed. */
	unknown: boolean;
	branchActive: boolean;
	branchStart: number;
	sawElse: boolean;
}

export function analyze(text: string, lookup: DefineLookup): Analysis {
	const lex = new Lexer(text);
	const inactive: Range[] = [];
	const directives: Directive[] = [];
	const stack: Frame[] = [];

	const isActive = () => stack.length === 0 || stack[stack.length - 1].branchActive;

	const closeBranch = (frame: Frame, end: number) => {
		if (frame.parentActive && !frame.branchActive && end > frame.branchStart) {
			inactive.push({ start: frame.branchStart, end });
		}
	};

	const readCondition = (): { info: ConditionInfo; end: number } => {
		const parser = new ConditionParser(lex);
		const condStart = lex.peek().start;
		let result: boolean | undefined;
		let error: string | undefined;
		try {
			result = isTrue(evaluate(parser.parseTopLevel(), lookup));
		} catch (e) {
			if (!(e instanceof ConditionError)) throw e;
			error = e.message;
		}
		const end = Math.max(parser.lastEnd, condStart);
		return { info: { text: text.slice(condStart, end), result, error, identifiers: parser.identifiers }, end };
	};

	for (;;) {
		const tok = lex.next();
		if (tok.kind === T.EOF) break;
		if (tok.kind !== T.Directive) continue;

		const reachable = isActive();
		switch (tok.value) {
			case 'if': {
				const { info, end } = readCondition();
				const unknown = info.result === undefined;
				const frame: Frame = {
					parentActive: reachable,
					taken: info.result === true,
					unknown,
					branchActive: reachable && (unknown || info.result === true),
					branchStart: end,
					sawElse: false,
				};
				stack.push(frame);
				directives.push({ kind: 'if', start: tok.start, end, condition: info, branchActive: frame.branchActive, reachable });
				break;
			}
			case 'elseif': {
				const frame = stack[stack.length - 1];
				const { info, end } = readCondition();
				if (!frame || frame.sawElse) {
					directives.push({ kind: 'elseif', start: tok.start, end, condition: info, reachable });
					break;
				}
				closeBranch(frame, tok.start);
				frame.unknown ||= info.result === undefined;
				frame.branchActive = frame.parentActive && (frame.unknown || (!frame.taken && info.result === true));
				frame.taken ||= info.result === true;
				frame.branchStart = end;
				directives.push({ kind: 'elseif', start: tok.start, end, condition: info, branchActive: frame.branchActive, reachable: frame.parentActive });
				break;
			}
			case 'else': {
				const frame = stack[stack.length - 1];
				if (!frame || frame.sawElse) {
					directives.push({ kind: 'else', start: tok.start, end: tok.end, reachable });
					break;
				}
				closeBranch(frame, tok.start);
				frame.sawElse = true;
				frame.branchActive = frame.parentActive && (frame.unknown || !frame.taken);
				frame.taken = true;
				frame.branchStart = tok.end;
				directives.push({ kind: 'else', start: tok.start, end: tok.end, branchActive: frame.branchActive, reachable: frame.parentActive });
				break;
			}
			case 'end': {
				const frame = stack.pop();
				if (frame) closeBranch(frame, tok.start);
				directives.push({ kind: 'end', start: tok.start, end: tok.end, reachable: frame ? frame.parentActive : reachable });
				break;
			}
			// #error, #line and friends don't affect what is compiled.
		}
	}

	// Unterminated #if: everything to the end of the file belongs to the open branch.
	while (stack.length > 0) closeBranch(stack.pop()!, text.length);

	inactive.sort((a, b) => a.start - b.start);
	return { inactive, directives };
}
