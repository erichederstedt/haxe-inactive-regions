/**
 * Working out which defines a Haxe build uses.
 *
 * The most accurate source is the compiler itself: we run it with the
 * project's arguments plus an initialization macro that prints
 * `Context.getDefines()` and exits before typing starts. When the compiler
 * isn't available we fall back to deriving the defines from the arguments.
 *
 * This module has no dependency on the VS Code API so it can be unit tested.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type Defines = Map<string, string>;

const DUMP_MARKER = '@@HAXE_INACTIVE_REGIONS_DEFINES@@';
const DUMP_CLASS = 'HaxeInactiveRegionsDump';

/** Splits an hxml line into arguments, honouring double quotes. */
export function splitHxmlLine(line: string): string[] {
	const args: string[] = [];
	const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(line))) args.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2]);
	return args;
}

/**
 * Flattens compiler arguments, recursively inlining any `.hxml` files
 * (resolved relative to `cwd`, like the compiler does).
 * `readFiles` collects the hxml files that were read.
 */
export function expandArgs(args: string[], cwd: string, readFiles: string[] = [], depth = 0): string[] {
	const out: string[] = [];
	for (const arg of args) {
		if (!arg.endsWith('.hxml') || depth > 16) {
			out.push(arg);
			continue;
		}
		const file = path.resolve(cwd, arg);
		readFiles.push(file);
		const content = fs.readFileSync(file, 'utf8');
		const lineArgs: string[] = [];
		for (let line of content.split(/\r?\n/)) {
			line = line.trim();
			if (line === '' || line.startsWith('#')) continue;
			// A flag and its value can be on one line: `-D foo=bar`, `-cp src`.
			// Haxe treats everything after the first space as the value.
			const m = /^(-\S+)\s+(.*)$/.exec(line);
			if (m) lineArgs.push(m[1], m[2].replace(/^"(.*)"$/, '$1'));
			else lineArgs.push(...splitHxmlLine(line));
		}
		out.push(...expandArgs(lineArgs, cwd, readFiles, depth + 1));
	}
	return out;
}

/**
 * Returns the arguments of the first compilation when the arguments describe
 * several (`--next`), including the common arguments before `--each`.
 */
export function firstCompilation(args: string[]): string[] {
	const each = args.indexOf('--each');
	const common = each >= 0 ? args.slice(0, each) : [];
	const rest = each >= 0 ? args.slice(each + 1) : args;
	const next = rest.indexOf('--next');
	return [...common, ...(next >= 0 ? rest.slice(0, next) : rest)];
}

/** Flags that take a value, so that the value isn't mistaken for a flag. */
const FLAGS_WITH_VALUE = new Set([
	'-cp', '-p', '--class-path', '-m', '-main', '--main', '-L', '-lib', '--library', '-D', '--define', '-r', '--resource',
	'--cmd', '--remap', '--macro', '-C', '--cwd', '-dce', '--dce', '--display', '--connect', '--server-connect', '--wait',
	'--server-listen', '--custom-target', '-js', '--js', '-swf', '--swf', '-neko', '--neko', '-php', '--php',
	'-cpp', '--cpp', '--cppia', '-cs', '--cs', '-java', '--java', '--jvm', '-python', '--python', '-lua', '--lua',
	'-hl', '--hl', '-x', '-xml', '--xml', '--json', '--swf-version', '--swf-header', '--swf-lib', '--swf-lib-extern',
	'--java-lib', '--java-lib-extern', '--net-lib', '--net-std', '--c-arg',
]);

interface TargetInfo {
	name: string;
	defines: string[];
	sys: boolean;
	static: boolean;
	threaded: boolean;
}

const TARGETS: Record<string, TargetInfo> = {
	js: { name: 'js', defines: ['js'], sys: false, static: false, threaded: false },
	swf: { name: 'flash', defines: ['flash', 'swf'], sys: false, static: true, threaded: false },
	neko: { name: 'neko', defines: ['neko'], sys: true, static: false, threaded: true },
	php: { name: 'php', defines: ['php'], sys: true, static: false, threaded: false },
	cpp: { name: 'cpp', defines: ['cpp'], sys: true, static: true, threaded: true },
	cppia: { name: 'cpp', defines: ['cpp', 'cppia'], sys: true, static: true, threaded: true },
	cs: { name: 'cs', defines: ['cs'], sys: true, static: true, threaded: true },
	java: { name: 'java', defines: ['java'], sys: true, static: true, threaded: true },
	jvm: { name: 'jvm', defines: ['java', 'jvm'], sys: true, static: true, threaded: true },
	python: { name: 'python', defines: ['python'], sys: true, static: false, threaded: true },
	lua: { name: 'lua', defines: ['lua'], sys: true, static: false, threaded: false },
	hl: { name: 'hl', defines: ['hl'], sys: true, static: true, threaded: true },
	interp: { name: 'eval', defines: ['eval', 'interp'], sys: true, static: false, threaded: true },
};

/** Adds a define the way the compiler does, making it reachable with dashes or underscores. */
function setDefine(defines: Defines, name: string, value: string) {
	defines.set(name, value);
	defines.set(name.replace(/-/g, '_'), value);
}

/** The defines Haxe sets for its own version, e.g. `haxe`, `haxe_ver`, `haxe4`. */
export function versionDefines(version: string): Defines {
	const defines: Defines = new Map();
	const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
	if (!m) return defines;
	const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
	defines.set('haxe', `${major}.${minor}.${patch}`);
	setDefine(defines, 'haxe-ver', (major + (minor * 100 + patch) / 1000).toFixed(3));
	for (let v = 3; v <= major; v++) defines.set(`haxe${v}`, '1');
	return defines;
}

const LIB_FLAGS = new Set(['-L', '-lib', '--library']);

function readTrimmed(file: string): string | undefined {
	try {
		return fs.readFileSync(file, 'utf8').trim() || undefined;
	} catch {
		return undefined;
	}
}

function isDirectory(dir: string): boolean {
	try {
		return fs.statSync(dir).isDirectory();
	} catch {
		return false;
	}
}

/** Where haxelib keeps its libraries, following haxelib's own lookup order. */
export function haxelibRepository(cwd: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
	// A project-local repository (`haxelib newrepo`) in the folder or one of its parents.
	for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
		if (isDirectory(path.join(dir, '.haxelib'))) return path.join(dir, '.haxelib');
		if (path.dirname(dir) === dir) break;
	}
	if (env.HAXELIB_PATH) return env.HAXELIB_PATH;
	const configs = [path.join(os.homedir(), '.haxelib')];
	if (process.platform !== 'win32') configs.push('/etc/.haxelib');
	for (const config of configs) {
		const repo = isDirectory(config) ? undefined : readTrimmed(config);
		if (repo) return repo;
	}
	if (process.platform === 'win32') return env.HAXEPATH ? path.join(env.HAXEPATH, 'lib') : undefined;
	return path.join(os.homedir(), 'haxelib');
}

/** Finds `name` in `dir`, ignoring case like haxelib does. */
function findEntry(dir: string, name: string): string | undefined {
	if (isDirectory(path.join(dir, name))) return path.join(dir, name);
	try {
		const match = fs.readdirSync(dir).find((e) => e.toLowerCase() === name.toLowerCase());
		return match && path.join(dir, match);
	} catch {
		return undefined;
	}
}

/**
 * The arguments haxelib adds for `-lib name[:version]` (what `haxelib path` prints):
 * the library's define, its dependencies as further `-lib`s and its `extraParams.hxml`.
 */
function haxelibArgs(repo: string, name: string, version: string | undefined): string[] {
	const libDir = findEntry(repo, name.replace(/\./g, ','));
	if (!libDir) return [];
	let dir: string | undefined;
	if (version) {
		dir = path.join(libDir, version.replace(/\./g, ','));
	} else {
		dir = readTrimmed(path.join(libDir, '.dev'));
		const current = dir ? undefined : readTrimmed(path.join(libDir, '.current'));
		if (current) dir = path.join(libDir, current.replace(/\./g, ','));
	}
	if (!dir || !isDirectory(dir)) return [];

	const args: string[] = [];
	let info: { version?: unknown; dependencies?: Record<string, unknown> } = {};
	try {
		info = JSON.parse(fs.readFileSync(path.join(dir, 'haxelib.json'), 'utf8'));
	} catch {
		// Not a haxelib library; it is still defined, just without a version.
	}
	if (typeof info.version === 'string') args.push('-D', `${name}=${info.version}`);
	for (const [dep, depVersion] of Object.entries(info.dependencies ?? {})) {
		// Versions can be `1.2.3`, `git:<url>` or empty for the current version.
		const v = typeof depVersion === 'string' ? depVersion.replace(/^(git|hg):.*$/, '$1') : '';
		args.push('-lib', v ? `${dep}:${v}` : dep);
	}
	const extraParams = path.join(dir, 'extraParams.hxml');
	if (fs.existsSync(extraParams)) {
		try {
			args.push(...expandArgs([extraParams], dir));
		} catch {
			// Ignore unreadable extra parameters.
		}
	}
	return args;
}

/**
 * Resolves `-lib` arguments the way haxelib (or lix, when the project has a
 * `haxe_libraries` folder) would, so that the defines of libraries and of
 * their dependencies are known without running the compiler.
 * The added arguments follow each `-lib`; libraries that can't be found are left as they are.
 */
export function expandLibraries(args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env): string[] {
	const lixDir = path.join(cwd, 'haxe_libraries');
	const useLix = isDirectory(lixDir);
	const repo = useLix ? undefined : haxelibRepository(cwd, env);
	const seen = new Set<string>();

	const expand = (args: string[], depth: number): string[] => {
		const out: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const flag = args[i];
			out.push(flag);
			if (flag === '--run') {
				out.push(...args.slice(i + 1));
				break;
			}
			if (!FLAGS_WITH_VALUE.has(flag) || i + 1 >= args.length) continue;
			const value = args[++i];
			out.push(value);
			if (!LIB_FLAGS.has(flag) || depth > 16) continue;

			// The first version of a library wins, as in haxelib.
			const [name, version] = value.split(':');
			if (!name || seen.has(name.toLowerCase())) continue;
			seen.add(name.toLowerCase());
			let libArgs: string[] = [];
			if (useLix) {
				const hxml = path.join(lixDir, `${name}.hxml`);
				if (fs.existsSync(hxml)) {
					try {
						libArgs = expandArgs([hxml], cwd);
					} catch {
						// Leave the library unresolved.
					}
				}
			} else if (repo) {
				libArgs = haxelibArgs(repo, name, version);
			}
			out.push(...expand(libArgs, depth + 1));
		}
		return out;
	};
	return expand(args, 0);
}

/**
 * Approximates the defines of a build from its (flattened) arguments.
 * This misses defines added by init macros, which is why the compiler is
 * preferred when available. Run the arguments through `expandLibraries` first
 * to include the defines of libraries' dependencies.
 */
export function definesFromArgs(args: string[], haxeVersion?: string): Defines {
	const defines: Defines = haxeVersion ? versionDefines(haxeVersion) : new Map();
	defines.set('true', '1');
	setDefine(defines, 'dce', 'std');

	let target: TargetInfo | undefined;
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		const value = FLAGS_WITH_VALUE.has(flag) ? args[++i] ?? '' : '';
		const bare = flag.replace(/^--?/, '');
		switch (flag) {
			case '-D':
			case '--define': {
				const eq = value.indexOf('=');
				if (eq >= 0) setDefine(defines, value.slice(0, eq), value.slice(eq + 1));
				else if (value) setDefine(defines, value, '1');
				break;
			}
			case '-L':
			case '-lib':
			case '--library': {
				// A library already defined (e.g. as a dependency) keeps its version.
				const [name, version] = value.split(':');
				if (name && !defines.has(name)) setDefine(defines, name, version || '1');
				break;
			}
			case '-debug':
			case '--debug':
				defines.set('debug', '1');
				break;
			case '-dce':
			case '--dce':
				setDefine(defines, 'dce', value);
				break;
			case '--interp':
			case '--run':
				target = TARGETS.interp;
				break;
			case '--custom-target': {
				const name = value.split('=')[0];
				target = { name, defines: [name], sys: false, static: false, threaded: false };
				break;
			}
			default:
				if (TARGETS[bare] && FLAGS_WITH_VALUE.has(flag)) target = TARGETS[bare];
		}
		// `--run` consumes all remaining arguments.
		if (flag === '--run') break;
	}

	if (target) {
		for (const d of target.defines) defines.set(d, '1');
		defines.set('target.name', target.name);
		if (target.sys) {
			defines.set('sys', '1');
			defines.set('target.sys', '1');
		}
		if (target.static) {
			defines.set('static', '1');
			defines.set('target.static', '1');
		}
		if (target.threaded) defines.set('target.threaded', '1');
	}
	return defines;
}

/** Compiler flags for vshaxe's `Target` enum, indexed by constructor (`None`, `Js`, `Lua`, ...). */
const VSHAXE_TARGETS = [
	undefined, '--js', '--lua', '--swf', undefined /* As3 */, '--neko', '--php', '--cpp', '--cppia', '--cs', '--java',
	'--python', '--hl', '--interp', '--jvm',
];

/**
 * Entries of a Haxe `Map<String, String>` as compiled to JS: `{m: Map}` with `-D js-es=6` (as vshaxe is built),
 * `{h: {...}}` otherwise, or an ES6 `Map` or plain object. Its methods are inlined, so they may not exist.
 */
function haxeMapEntries(map: unknown): [string, string][] {
	const isString = (e: [string, unknown]): e is [string, string] => typeof e[1] === 'string';
	if (map instanceof Map) return [...map].filter(isString);
	if (!map || typeof map !== 'object') return [];
	if ('m' in map && map.m instanceof Map) return haxeMapEntries(map.m);
	const obj = 'h' in map ? map.h : map;
	return obj && typeof obj === 'object' ? Object.entries(obj).filter(isString) : [];
}

/**
 * Turns the result of vshaxe's `getActiveConfiguration()` into compiler arguments:
 * its defines (which include those of the resolved `-lib`s and their dependencies) and its target.
 * Returns `undefined` if the value doesn't look like a configuration.
 */
export function argsFromVshaxeConfiguration(config: unknown): string[] | undefined {
	if (!config || typeof config !== 'object' || !('defines' in config)) return undefined;
	const { defines, target } = config as { defines: unknown; target?: { _hx_index?: unknown; [arg: string]: unknown } };
	const args: string[] = [];
	for (const [name, value] of haxeMapEntries(defines)) args.push('-D', `${name}=${value}`);
	const flag =
		typeof target?._hx_index === 'number'
			? VSHAXE_TARGETS[target._hx_index]
			: typeof target?._hx_name === 'string' && target._hx_name !== 'None' && target._hx_name !== 'As3'
				? `--${target._hx_name.toLowerCase()}`
				: undefined;
	if (flag === '--interp') {
		args.push(flag);
	} else if (flag) {
		// The output path doesn't matter as nothing is generated, but some targets look at its extension.
		const output = Object.entries(target!).find(([k, v]) => !k.startsWith('_') && typeof v === 'string')?.[1];
		args.push(flag, typeof output === 'string' ? output : 'out');
	}
	return args;
}

/** Flags that would make the compiler talk to a server or switch modes; dropped when querying it. */
const STRIP_FLAGS = new Set(['--connect', '--server-connect', '--wait', '--server-listen', '--display']);

export interface CompilerOptions {
	haxe: string;
	env?: NodeJS.ProcessEnv;
	cwd: string;
	/** Directory containing HaxeInactiveRegionsDump.hx. */
	dumpClassPath: string;
	timeoutMs?: number;
}

/** Asks the compiler for the defines of a build described by (flattened) arguments. */
export function queryCompilerDefines(args: string[], opts: CompilerOptions): Promise<Defines> {
	const filtered: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (STRIP_FLAGS.has(args[i])) i++;
		else filtered.push(args[i]);
	}
	// `--run` consumes everything after it, so our flags must go in front of it.
	const runIndex = filtered.indexOf('--run');
	const insertAt = runIndex >= 0 ? runIndex : filtered.length;
	filtered.splice(insertAt, 0, '--no-output', '-cp', opts.dumpClassPath, '--macro', `${DUMP_CLASS}.run()`);

	return new Promise((resolve, reject) => {
		execFile(
			opts.haxe,
			filtered,
			{ cwd: opts.cwd, env: opts.env, timeout: opts.timeoutMs ?? 20000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
			(err, stdout, stderr) => {
				const line = stdout.split(/\r?\n/).find((l) => l.startsWith(DUMP_MARKER));
				if (!line) {
					const detail = (stderr || stdout).trim() || (err ? err.message : 'no output');
					reject(new Error(`Haxe did not report its defines:\n${detail}`));
					return;
				}
				try {
					const obj = JSON.parse(line.slice(DUMP_MARKER.length)) as Record<string, string>;
					resolve(new Map(Object.entries(obj)));
				} catch (e) {
					reject(e);
				}
			},
		);
	});
}

/** Runs `haxe --version`. */
export function queryHaxeVersion(haxe: string, env?: NodeJS.ProcessEnv): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(haxe, ['--version'], { env, timeout: 10000, windowsHide: true }, (err, stdout, stderr) => {
			// Old versions print the version to stderr.
			const m = /\d+\.\d+\.\d+\S*/.exec(stdout + stderr);
			if (m) resolve(m[0]);
			else reject(err ?? new Error('Could not determine the Haxe version'));
		});
	});
}

/**
 * Applies user overrides: `name`, `name=value`, or `!name` to undefine.
 */
export function applyOverrides(defines: Defines, overrides: readonly string[]) {
	for (const raw of overrides) {
		const entry = raw.trim();
		if (!entry) continue;
		if (entry.startsWith('!') || entry.startsWith('-')) {
			const name = entry.slice(1);
			defines.delete(name);
			defines.delete(name.replace(/-/g, '_'));
			continue;
		}
		const eq = entry.indexOf('=');
		if (eq >= 0) setDefine(defines, entry.slice(0, eq), entry.slice(eq + 1));
		else setDefine(defines, entry, '1');
	}
}
