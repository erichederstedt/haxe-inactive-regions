import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test } from 'node:test';
import { applyOverrides, argsFromVshaxeConfiguration, definesFromArgs, expandArgs, expandLibraries, firstCompilation, versionDefines } from '../defines';

function tempDir(files: Record<string, string>): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'haxe-inactive-'));
	for (const [name, content] of Object.entries(files)) {
		fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
		fs.writeFileSync(path.join(dir, name), content);
	}
	return dir;
}

test('hxml files are expanded recursively', () => {
	const dir = tempDir({
		'build.hxml': '# comment\ncommon.hxml\n-main Main\n--js bin/main.js\n',
		'common.hxml': '-cp src\n-D my-flag\n-D answer=42\n-lib heaps:1.10.0\n',
	});
	const args = expandArgs(['build.hxml'], dir);
	assert.deepStrictEqual(args, ['-cp', 'src', '-D', 'my-flag', '-D', 'answer=42', '-lib', 'heaps:1.10.0', '-main', 'Main', '--js', 'bin/main.js']);

	const d = definesFromArgs(args, '4.3.6');
	assert.strictEqual(d.get('my_flag'), '1');
	assert.strictEqual(d.get('answer'), '42');
	assert.strictEqual(d.get('heaps'), '1.10.0');
	assert.strictEqual(d.get('js'), '1');
	assert.strictEqual(d.get('target.name'), 'js');
	assert.strictEqual(d.get('sys'), undefined);
	assert.strictEqual(d.get('haxe4'), '1');
});

test('only the first compilation is used', () => {
	const args = ['-D', 'common', '--each', '--cpp', 'out', '--next', '--js', 'x.js'];
	assert.deepStrictEqual(firstCompilation(args), ['-D', 'common', '--cpp', 'out']);
	assert.deepStrictEqual(firstCompilation(['--js', 'a', '--next', '--cpp', 'b']), ['--js', 'a']);
	const d = definesFromArgs(firstCompilation(args));
	assert.strictEqual(d.get('cpp'), '1');
	assert.strictEqual(d.get('sys'), '1');
	assert.strictEqual(d.get('js'), undefined);
});

test('version defines match the compiler', () => {
	assert.deepStrictEqual(
		Object.fromEntries(versionDefines('4.3.6')),
		{ haxe: '4.3.6', 'haxe-ver': '4.306', haxe_ver: '4.306', haxe3: '1', haxe4: '1' },
	);
});

test('overrides', () => {
	const d = definesFromArgs(['-D', 'a', '-D', 'b-c']);
	applyOverrides(d, ['!a', '!b-c', 'x=1', 'new-lib']);
	assert.strictEqual(d.get('a'), undefined);
	assert.strictEqual(d.get('b_c'), undefined);
	assert.strictEqual(d.get('x'), '1');
	assert.strictEqual(d.get('new_lib'), '1');
});

test('haxelib dependencies are defined', () => {
	const repo = tempDir({
		'heaps/.current': '1.10.0',
		'heaps/1,10,0/haxelib.json': JSON.stringify({ name: 'heaps', version: '1.10.0', dependencies: { format: '', hxbit: 'git:https://x' } }),
		'heaps/1,10,0/extraParams.hxml': '-D heaps-extra\n',
		'Format/.current': '3.7.0',
		'Format/3,7,0/haxelib.json': JSON.stringify({ name: 'format', version: '3.7.0' }),
		'Format/3,6,0/haxelib.json': JSON.stringify({ name: 'format', version: '3.6.0' }),
		'hxbit/.current': '1.5.0',
		'hxbit/git/haxelib.json': JSON.stringify({ name: 'hxbit', version: '1.5.1-git' }),
		'my-dev/.dev': '',
	});
	const devDir = tempDir({ 'haxelib.json': JSON.stringify({ name: 'my-dev', version: '0.1.0', dependencies: { format: '3.6.0' } }) });
	fs.writeFileSync(path.join(repo, 'my-dev/.dev'), devDir);
	const project = tempDir({});
	const env = { HAXELIB_PATH: repo };

	const d = definesFromArgs(expandLibraries(['-lib', 'heaps', '--js', 'x.js'], project, env));
	assert.strictEqual(d.get('heaps'), '1.10.0');
	assert.strictEqual(d.get('heaps_extra'), '1');
	assert.strictEqual(d.get('format'), '3.7.0');
	assert.strictEqual(d.get('hxbit'), '1.5.1-git');
	assert.strictEqual(d.get('js'), '1');

	// The first requested version of a library wins.
	const dev = definesFromArgs(expandLibraries(['-lib', 'my-dev', '-lib', 'format'], project, env));
	assert.strictEqual(dev.get('my_dev'), '0.1.0');
	assert.strictEqual(dev.get('format'), '3.6.0');

	// Unknown libraries are still defined.
	assert.strictEqual(definesFromArgs(expandLibraries(['-lib', 'missing'], project, env)).get('missing'), '1');
});

test('lix libraries are resolved from haxe_libraries', () => {
	const project = tempDir({
		'haxe_libraries/tink_web.hxml': '-lib tink_core\n-cp ${HAXE_LIBCACHE}/tink_web/src\n-D tink_web=0.3.0\n',
		'haxe_libraries/tink_core.hxml': '-cp ${HAXE_LIBCACHE}/tink_core/src\n-D tink_core=2.1.0\n',
	});
	const d = definesFromArgs(expandLibraries(['-lib', 'tink_web'], project, {}));
	assert.strictEqual(d.get('tink_web'), '0.3.0');
	assert.strictEqual(d.get('tink_core'), '2.1.0');
});

test('vshaxe configurations are turned into arguments', () => {
	// What vshaxe's getActiveConfiguration() returns at runtime: a compiled Haxe Map and enum.
	const config = {
		classPaths: [{ path: '/project/src' }],
		defines: { h: { 'my-lib': '1.2.3', 'dep-lib': '0.5.0', flag: '1' } },
		target: { _hx_index: 7, directory: 'bin/cpp', __enum__: 'vshaxe.Target', toString() { return ''; } },
		main: 'Main',
	};
	const args = argsFromVshaxeConfiguration(config)!;
	assert.deepStrictEqual(args, ['-D', 'my-lib=1.2.3', '-D', 'dep-lib=0.5.0', '-D', 'flag=1', '--cpp', 'bin/cpp']);
	const d = definesFromArgs(args);
	assert.strictEqual(d.get('dep_lib'), '0.5.0');
	assert.strictEqual(d.get('cpp'), '1');

	// vshaxe is built with `-D js-es=6`, where Haxe's StringMap wraps an ES6 Map.
	const vshaxeBuild = argsFromVshaxeConfiguration({ defines: { m: new Map([['my-lib', '1.2.3']]) }, target: { _hx_index: 1, file: 'x.js' } });
	assert.deepStrictEqual(vshaxeBuild, ['-D', 'my-lib=1.2.3', '--js', 'x.js']);

	const es6 = argsFromVshaxeConfiguration({ defines: new Map([['a', 'b']]), target: { _hx_name: 'Interp', _hx_index: 13 } });
	assert.deepStrictEqual(es6, ['-D', 'a=b', '--interp']);
	assert.deepStrictEqual(argsFromVshaxeConfiguration({ defines: { h: {} }, target: { _hx_name: 'None', _hx_index: 0 } }), []);
	assert.strictEqual(argsFromVshaxeConfiguration(undefined), undefined);
	assert.strictEqual(argsFromVshaxeConfiguration('No Haxe configuration available'), undefined);
});
