/**
 * Compares the evaluator against the real Haxe compiler on generated
 * conditions. Skipped when no `haxe` executable is available
 * (set the HAXE environment variable to point at one).
 */
import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { definesFromArgs, expandArgs, queryCompilerDefines } from '../defines';
import { evaluateCondition } from '../preprocessor';

const haxe = process.env.HAXE ?? 'haxe';
let haxeAvailable = true;
try {
	execFileSync(haxe, ['--version'], { stdio: 'ignore' });
} catch {
	haxeAvailable = false;
}

const DEFINE_ARGS = ['-D', 'zero=0', '-D', 'empty=', '-D', 'foo=bar', '-D', 'my-flag', '-D', 'num=10', '-D', 'ver=1.2.0', '-D', 'fl=1.5'];
const DUMP_CP = path.join(__dirname, '..', '..', 'haxe');

const atoms = [
	'foo', 'nope', 'zero', 'empty', 'my_flag', 'num', 'ver', 'fl', 'js', 'sys', 'target.sys', 'true', 'false', 'haxe4',
	'"bar"', '"10"', '"1.2.0"', '9', '10', '1.5', '0', '-1',
	'version("1.2.0")', 'version("1.10.0")', 'version("1.2.0-rc.1")',
];
const cmpOps = ['==', '!=', '<', '<=', '>', '>='];

/** A small deterministic PRNG so failures are reproducible. */
function rng(seed: number) {
	return () => {
		seed = (seed * 1103515245 + 12345) & 0x7fffffff;
		return seed / 0x7fffffff;
	};
}

function generate(rand: () => number, depth: number): string {
	const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];
	const r = rand();
	if (depth <= 0 || r < 0.3) return pick(atoms);
	if (r < 0.55) return `${pick(atoms)} ${pick(cmpOps)} ${pick(atoms)}`;
	if (r < 0.65) return `!(${generate(rand, depth - 1)})`;
	return `(${generate(rand, depth - 1)}) ${pick(['&&', '||'])} (${generate(rand, depth - 1)})`;
}

test('evaluator agrees with the Haxe compiler', { skip: !haxeAvailable && 'haxe not found' }, async () => {
	const lookupDefines = await queryCompilerDefines([...DEFINE_ARGS, '--interp'], { haxe, cwd: os.tmpdir(), dumpClassPath: DUMP_CP });
	const lookup = (name: string) => lookupDefines.get(name);

	const rand = rng(42);
	const conditions: string[] = [];
	while (conditions.length < 400) {
		const cond = `(${generate(rand, 3)})`;
		// Only keep conditions the compiler accepts; errors are checked separately.
		try {
			evaluateCondition(cond, lookup);
			conditions.push(cond);
		} catch {
			// skip
		}
	}

	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxe-oracle-'));
	const body = conditions
		.map((c, i) => `#if ${c} Sys.println("${i}:T"); #else Sys.println("${i}:F"); #end`)
		.join('\n');
	fs.writeFileSync(path.join(dir, 'Main.hx'), `class Main { static function main() {\n${body}\n} }\n`);
	const out = execFileSync(haxe, ['-main', 'Main', ...DEFINE_ARGS, '--interp'], { cwd: dir, encoding: 'utf8' });
	const actual = out.trim().split('\n');

	for (let i = 0; i < conditions.length; i++) {
		const expected = evaluateCondition(conditions[i], lookup) ? 'T' : 'F';
		assert.strictEqual(actual[i], `${i}:${expected}`, `#if ${conditions[i]}`);
	}
});

test('estimated defines are a subset of the compiler defines', { skip: !haxeAvailable && 'haxe not found' }, async () => {
	const version = execFileSync(haxe, ['--version'], { encoding: 'utf8' }).trim();
	// Targets that don't need a haxelib (hxcpp, hxjava, ...) to be installed.
	for (const target of [['--js', 'x.js'], ['--hl', 'x.hl'], ['--interp'], ['--python', 'x.py'], ['--lua', 'x.lua'], ['--php', 'out'], ['--neko', 'x.n']]) {
		const args = [...DEFINE_ARGS, '--debug', ...target];
		const exact = await queryCompilerDefines(args, { haxe, cwd: os.tmpdir(), dumpClassPath: DUMP_CP });
		const estimated = definesFromArgs(expandArgs(args, os.tmpdir()), version);
		for (const [name, value] of estimated) {
			assert.strictEqual(exact.get(name), value, `${target[0]}: ${name}`);
		}
	}
});
