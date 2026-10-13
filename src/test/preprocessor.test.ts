import * as assert from 'assert';
import { test } from 'node:test';
import { analyze, evaluateCondition } from '../preprocessor';

const defs = (obj: Record<string, string>) => (name: string) => obj[name];

/** Returns the inactive text of `source`, using `«»` markers to make expectations readable. */
function inactiveText(source: string, defines: Record<string, string>): string[] {
	return analyze(source, defs(defines)).inactive.map((r) => source.slice(r.start, r.end).trim());
}

test('simple #if / #else', () => {
	const src = `
#if old_lib
oldCall();
#else
newCall();
#end
`;
	assert.deepStrictEqual(inactiveText(src, { old_lib: '1' }), ['newCall();']);
	assert.deepStrictEqual(inactiveText(src, {}), ['oldCall();']);
});

test('#elseif chain only takes the first true branch', () => {
	const src = `#if a A #elseif b B #elseif c C #else D #end`;
	assert.deepStrictEqual(inactiveText(src, { b: '1', c: '1' }), ['A', 'C', 'D']);
	assert.deepStrictEqual(inactiveText(src, {}), ['A', 'B', 'C']);
	assert.deepStrictEqual(inactiveText(src, { a: '1', c: '1' }), ['B', 'C', 'D']);
});

test('nested blocks inside an inactive branch are covered by the outer range', () => {
	const src = `#if js
	#if debug X #else Y #end
#else
	Z
#end`;
	assert.deepStrictEqual(inactiveText(src, {}), ['#if debug X #else Y #end']);
	assert.deepStrictEqual(inactiveText(src, { js: '1' }), ['X', 'Z']);
	assert.deepStrictEqual(inactiveText(src, { js: '1', debug: '1' }), ['Y', 'Z']);
});

test('condition without parentheses is a single operand; the rest of the line is code', () => {
	const src = `#if js trace("js"); #else trace("other"); #end`;
	assert.deepStrictEqual(inactiveText(src, { js: '1' }), ['trace("other");']);
	const a = analyze(src, defs({}));
	assert.strictEqual(a.directives[0].condition!.text, 'js');
});

test('directives in strings, comments and regexes are ignored', () => {
	const src = `
var s = "#if foo";
var t = '#else \${ "#end" + '}' }';
// #if foo
/* #else
#end */
var r = ~/#if x\\/#end/g;
#if foo A #end`;
	assert.deepStrictEqual(inactiveText(src, {}), ['A']);
});

test('dotted names', () => {
	assert.deepStrictEqual(inactiveText('#if target.sys A #else B #end', { 'target.sys': '1' }), ['B']);
	assert.deepStrictEqual(inactiveText('#if (target.name == "js") A #else B #end', { 'target.name': 'js' }), ['B']);
});

test('unterminated #if extends to end of file', () => {
	assert.deepStrictEqual(inactiveText('#if nope\nA\nB', {}), ['A\nB']);
});

test('conditions that cannot be evaluated do not grey anything', () => {
	const src = `#if (foo + 1) A #else B #end C`;
	const a = analyze(src, defs({ foo: '1' }));
	assert.deepStrictEqual(a.inactive, []);
	assert.match(a.directives[0].condition!.error!, /Expected/);
});

test('conditions on defines with unknown values do not grey anything', () => {
	const src = `#if (haxe >= version("4.0.0")) A #else B #end #if js C #end`;
	const a = analyze(src, (name) => (name === 'haxe' ? null : undefined));
	assert.deepStrictEqual(a.inactive.map((r) => src.slice(r.start, r.end).trim()), ['C']);
	assert.match(a.directives[0].condition!.error!, /not known/);
});

test('an incomplete condition does not swallow the next directive', () => {
	const src = `#if (foo &&\n#else B #end`;
	const a = analyze(src, defs({}));
	assert.deepStrictEqual(
		a.directives.map((d) => d.kind),
		['if', 'else', 'end'],
	);
});

test('hover information', () => {
	const a = analyze('#if (foo && !bar) X #end', defs({ foo: '1' }));
	const d = a.directives[0];
	assert.strictEqual(d.condition!.text, '(foo && !bar)');
	assert.strictEqual(d.condition!.result, true);
	assert.deepStrictEqual(d.condition!.identifiers, ['foo', 'bar']);
});

test('evaluation matches compiler rules', () => {
	const lookup = defs({ zero: '0', empty: '', foo: 'bar', num: '10', ver: '1.2.0', haxe: '4.3.6' });
	const cases: [string, boolean][] = [
		['zero', true],
		['empty', true],
		['(0)', false],
		['("")', true],
		['(nope == nope)', false],
		['(nope != nope)', true],
		['(haxe > "4.10.0")', true], // plain string comparison
		['(haxe > version("4.10.0"))', false],
		['(num > 9)', true],
		['(num >= "9")', false], // string comparison
		['(ver > version("1.2.0-rc.10"))', true],
		['(version("1.2.0-rc.b") > version("1.2.0-rc.10"))', true],
		['(nope || foo && nope)', false],
		['(-1 < 0)', true],
		['(0x10 == 16)', true],
		['!(foo)', false],
	];
	for (const [cond, expected] of cases) {
		assert.strictEqual(evaluateCondition(cond, lookup), expected, cond);
	}
	assert.throws(() => evaluateCondition('(foo > 1)', lookup), /Cannot compare/);
	assert.throws(() => evaluateCondition('(ver > version("1.2"))', lookup), /Invalid version/);
});
