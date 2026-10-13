import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	applyOverrides,
	argsFromVshaxeConfiguration,
	Defines,
	definesFromArgs,
	expandArgs,
	expandLibraries,
	firstCompilation,
	queryCompilerDefines,
	queryHaxeVersion,
} from './defines';
import { analyze, Analysis } from './preprocessor';

const SECTION = 'haxeInactiveRegions';

interface ResolvedDefines {
	defines: Defines;
	/** Short name of the build configuration, e.g. `build.hxml`. */
	label: string;
	/** Where the defines came from, for display. */
	source: string;
	/** Set when the compiler could not be used and the defines are approximate. */
	warning?: string;
	/** Defines whose value could not be determined. */
	unknown?: Set<string>;
}

interface BuildConfig {
	args: string[];
	label: string;
	/**
	 * What vshaxe reported when the build was chosen: its arguments, `null` if it had no
	 * configuration yet, or `undefined` if vshaxe isn't used.
	 */
	vshaxe?: string[] | null;
}

export function activate(context: vscode.ExtensionContext) {
	const output = vscode.window.createOutputChannel('Haxe Inactive Regions');
	const provider = new DefinesProvider(context, output);
	const regions = new InactiveRegions(provider);
	context.subscriptions.push(output, regions);

	const updateVisible = () => vscode.window.visibleTextEditors.forEach((e) => regions.update(e));
	const refreshAll = () => {
		provider.invalidate();
		regions.scheduleAll();
	};

	const watcher = vscode.workspace.createFileSystemWatcher('**/*.hxml');
	watcher.onDidChange(refreshAll);
	watcher.onDidCreate(refreshAll);
	watcher.onDidDelete(refreshAll);

	// vshaxe has no event for when its active configuration changes, so check for changes periodically.
	const vshaxePoll = setInterval(async () => {
		if (vscode.window.visibleTextEditors.some((e) => isHaxe(e.document)) && (await provider.vshaxeChanged())) {
			refreshAll();
		}
	}, 3000);

	context.subscriptions.push(
		{ dispose: () => clearInterval(vshaxePoll) },
		watcher,
		vscode.window.onDidChangeVisibleTextEditors(updateVisible),
		vscode.window.onDidChangeActiveTextEditor((e) => regions.activeEditorChanged(e)),
		vscode.workspace.onDidChangeTextDocument((e) => regions.schedule(e.document)),
		vscode.workspace.onDidCloseTextDocument((d) => regions.forget(d)),
		vscode.workspace.onDidGrantWorkspaceTrust(refreshAll),
		vscode.workspace.onDidChangeWorkspaceFolders(refreshAll),
		vscode.workspace.onDidChangeConfiguration((e) => {
			if (e.affectsConfiguration(`${SECTION}.opacity`)) regions.recreateDecoration();
			if (
				e.affectsConfiguration(SECTION) ||
				e.affectsConfiguration('haxe.configurations') ||
				e.affectsConfiguration('haxe.executable')
			) {
				refreshAll();
			}
		}),
		vscode.languages.registerHoverProvider({ language: 'haxe' }, regions),
		vscode.commands.registerCommand(`${SECTION}.refresh`, refreshAll),
		vscode.commands.registerCommand(`${SECTION}.toggle`, async () => {
			const config = vscode.workspace.getConfiguration(SECTION);
			await config.update('enabled', !config.get<boolean>('enabled', true), vscode.ConfigurationTarget.Global);
		}),
		vscode.commands.registerCommand(`${SECTION}.selectConfiguration`, () => selectConfiguration()),
		vscode.commands.registerCommand(`${SECTION}.showDefines`, async () => {
			const editor = vscode.window.activeTextEditor;
			const resolved = await provider.get(folderFor(editor?.document));
			output.appendLine('');
			output.appendLine(`Defines for ${resolved.label} (${resolved.source}):`);
			if (resolved.warning) output.appendLine(`  ⚠ ${resolved.warning}`);
			for (const [name, value] of [...resolved.defines].sort(([a], [b]) => a.localeCompare(b))) {
				output.appendLine(`  ${name} = ${value}`);
			}
			output.show(true);
		}),
	);

	updateVisible();
}

export function deactivate() {}

function isHaxe(doc: vscode.TextDocument): boolean {
	return doc.languageId === 'haxe' || doc.fileName.endsWith('.hx');
}

/**
 * The workspace folder whose build decides what is active in `doc`. In a multi-root workspace,
 * folders without a build of their own (e.g. a library added to debug it) use the first folder's
 * build, which is also the folder vshaxe works with.
 */
function folderFor(doc: vscode.TextDocument | undefined): vscode.WorkspaceFolder | undefined {
	const first = vscode.workspace.workspaceFolders?.[0];
	const own = doc && vscode.workspace.getWorkspaceFolder(doc.uri);
	if (!own || !first || own === first) return own ?? first;
	return hasOwnBuild(own) ? own : first;
}

/** Whether a folder configures a build itself; settings inherited from the workspace don't count. */
function hasOwnBuild(folder: vscode.WorkspaceFolder): boolean {
	const ownSetting = (section: string, key: string) => {
		const value = vscode.workspace.getConfiguration(section, folder.uri).inspect<unknown[]>(key)?.workspaceFolderValue;
		return Array.isArray(value) && value.length > 0;
	};
	if (ownSetting(SECTION, 'compilerArgs') || ownSetting('haxe', 'configurations')) return true;
	try {
		// A library's hxml files (tests, extraParams.hxml) aren't the build it is used in.
		const files = fs.readdirSync(folder.uri.fsPath);
		return !files.includes('haxelib.json') && files.some((f) => f.endsWith('.hxml'));
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Decorations and hover
// ---------------------------------------------------------------------------

class InactiveRegions implements vscode.HoverProvider, vscode.Disposable {
	private decoration = createDecoration();
	private readonly analyses = new Map<string, { version: number; analysis: Analysis; defines: ResolvedDefines }>();
	private readonly timers = new Map<string, NodeJS.Timeout>();
	private readonly statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);

	constructor(private readonly provider: DefinesProvider) {
		this.statusBar.command = `${SECTION}.selectConfiguration`;
	}

	dispose() {
		this.decoration.dispose();
		this.statusBar.dispose();
		this.timers.forEach(clearTimeout);
	}

	recreateDecoration() {
		this.decoration.dispose();
		this.decoration = createDecoration();
	}

	/** Re-analyses a document shortly after it stops changing. */
	schedule(doc: vscode.TextDocument, delay = 150) {
		if (!isHaxe(doc)) return;
		const key = doc.uri.toString();
		clearTimeout(this.timers.get(key));
		this.timers.set(
			key,
			setTimeout(() => {
				this.timers.delete(key);
				for (const editor of vscode.window.visibleTextEditors) {
					if (editor.document === doc) this.update(editor);
				}
			}, delay),
		);
	}

	scheduleAll() {
		for (const editor of vscode.window.visibleTextEditors) this.schedule(editor.document, 300);
	}

	forget(doc: vscode.TextDocument) {
		this.analyses.delete(doc.uri.toString());
	}

	async update(editor: vscode.TextEditor) {
		const doc = editor.document;
		if (!isHaxe(doc)) return;

		if (!vscode.workspace.getConfiguration(SECTION, doc.uri).get<boolean>('enabled', true)) {
			editor.setDecorations(this.decoration, []);
			this.analyses.delete(doc.uri.toString());
			if (editor === vscode.window.activeTextEditor) this.statusBar.hide();
			return;
		}

		const defines = await this.provider.get(folderFor(doc));
		if (doc.isClosed) return;
		const analysis = analyze(doc.getText(), (name) => (defines.unknown?.has(name) ? null : defines.defines.get(name)));
		this.analyses.set(doc.uri.toString(), { version: doc.version, analysis, defines });

		const ranges = analysis.inactive.map((r) => new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)));
		editor.setDecorations(this.decoration, ranges);

		if (editor === vscode.window.activeTextEditor) this.showStatus(defines);
	}

	activeEditorChanged(editor: vscode.TextEditor | undefined) {
		if (!editor || !isHaxe(editor.document)) this.statusBar.hide();
		else this.update(editor);
	}

	private showStatus(defines: ResolvedDefines) {
		this.statusBar.text = `${defines.warning ? '$(warning)' : '$(symbol-constant)'} ${defines.label}`;
		const tooltip = new vscode.MarkdownString(`**Haxe inactive regions**\n\nDefines from ${defines.source}.`);
		if (defines.warning) tooltip.appendMarkdown(`\n\n$(warning) ${defines.warning}`);
		tooltip.appendMarkdown('\n\nClick to choose the build configuration.');
		tooltip.supportThemeIcons = true;
		this.statusBar.tooltip = tooltip;
		this.statusBar.show();
	}

	provideHover(doc: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
		const entry = this.analyses.get(doc.uri.toString());
		if (!entry || entry.version !== doc.version) return undefined;
		const offset = doc.offsetAt(position);
		const directive = entry.analysis.directives.find((d) => offset >= d.start && offset <= d.end);
		if (!directive || directive.kind === 'end') return undefined;

		const md = new vscode.MarkdownString();
		const cond = directive.condition;
		if (cond) {
			const verdict =
				cond.result === undefined ? `could not be evaluated: ${cond.error}` : `is **${cond.result}**`;
			md.appendMarkdown(`\`#${directive.kind} ${cond.text}\` ${verdict}\n\n`);
			for (const name of cond.identifiers) {
				const value = entry.defines.defines.get(name);
				const shown = entry.defines.unknown?.has(name)
					? '_unknown_'
					: value === undefined
						? '_not defined_'
						: `= \`${JSON.stringify(value)}\``;
				md.appendMarkdown(`- \`${name}\` ${shown}\n`);
			}
			if (cond.identifiers.some((name) => entry.defines.unknown?.has(name))) {
				md.appendMarkdown(
					'\nThe Haxe version could not be determined because the `haxe` executable was not found. ' +
						'Set `haxeInactiveRegions.haxePath` (or vshaxe\'s `haxe.executable`) to your Haxe executable, ' +
						'or set `haxeInactiveRegions.haxeVersion`, e.g. `"4.3.6"`.\n',
				);
			}
		}
		if (!directive.reachable) {
			md.appendMarkdown('\n_This directive is inside code that is not compiled._\n');
		} else if (directive.branchActive !== undefined) {
			md.appendMarkdown(`\nThe following branch is **${directive.branchActive ? 'compiled' : 'not compiled'}**.\n`);
		}
		md.appendMarkdown(`\n---\nDefines from ${entry.defines.source}.`);
		return new vscode.Hover(md, new vscode.Range(doc.positionAt(directive.start), doc.positionAt(directive.end)));
	}
}

function createDecoration(): vscode.TextEditorDecorationType {
	const opacity = vscode.workspace.getConfiguration(SECTION).get<number>('opacity', 0.4);
	return vscode.window.createTextEditorDecorationType({
		opacity: String(Math.min(1, Math.max(0, opacity))),
		rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
	});
}

// ---------------------------------------------------------------------------
// Defines
// ---------------------------------------------------------------------------

class DefinesProvider {
	private readonly cache = new Map<string, Promise<ResolvedDefines>>();
	private readonly versionCache = new Map<string, Promise<string | undefined>>();
	/** What vshaxe reported when the defines were last resolved; `undefined` if vshaxe isn't used. */
	private vshaxeSignature: string | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly output: vscode.OutputChannel,
	) {}

	invalidate() {
		this.cache.clear();
	}

	/**
	 * Whether vshaxe's active configuration changed since the defines were resolved, including
	 * vshaxe becoming ready after it had no configuration yet (usually the case right after startup).
	 */
	async vshaxeChanged(): Promise<boolean> {
		const folder = vscode.workspace.workspaceFolders?.[0];
		if (this.vshaxeSignature === undefined || !folder) return false;
		const args = await vshaxeArgs(folder);
		return args !== undefined && JSON.stringify(args) !== this.vshaxeSignature;
	}

	get(folder: vscode.WorkspaceFolder | undefined): Promise<ResolvedDefines> {
		const key = folder?.uri.toString() ?? '';
		let result = this.cache.get(key);
		if (!result) {
			result = this.resolve(folder);
			this.cache.set(key, result);
		}
		return result;
	}

	private log(message: string) {
		this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${message}`);
	}

	private async resolve(folder: vscode.WorkspaceFolder | undefined): Promise<ResolvedDefines> {
		const config = vscode.workspace.getConfiguration(SECTION, folder?.uri);
		const overrides = config.get<string[]>('defines', []);
		const build = folder && (await findBuildConfig(folder));
		this.vshaxeSignature = build?.vshaxe !== undefined ? JSON.stringify(build.vshaxe) : undefined;
		if (build?.vshaxe === null) this.log('vshaxe has no active configuration yet; using the hxml until it does.');
		if (build?.vshaxe) this.log(`Using vshaxe's active configuration: ${build.vshaxe.join(' ') || '(no defines or target)'}`);
		const haxe = resolveHaxeExecutable(folder);
		const cwd = folder?.uri.fsPath ?? process.cwd();

		let args: string[] = [];
		let warning: string | undefined;
		if (build) {
			try {
				args = firstCompilation(expandArgs(build.args, cwd));
			} catch (e) {
				warning = `Could not read ${build.label}: ${(e as Error).message}`;
				this.log(warning);
			}
		}

		const finish = (defines: Defines, source: string): ResolvedDefines => {
			applyOverrides(defines, overrides);
			if (overrides.length > 0) source += ' + settings';
			this.log(`Using ${defines.size} defines from ${source}`);
			return { defines, label: build?.label ?? 'no build configuration', source, warning };
		};

		const useCompiler = config.get<string>('definesSource', 'auto') === 'auto';
		if (build && !warning && useCompiler && vscode.workspace.isTrusted) {
			try {
				const defines = await queryCompilerDefines(args, {
					haxe: haxe.path,
					env: haxe.env,
					cwd,
					dumpClassPath: this.context.asAbsolutePath('haxe'),
				});
				return finish(defines, `the Haxe compiler (${build.label})`);
			} catch (e) {
				warning = `The Haxe compiler could not be queried, so defines are estimated from ${build.label}. Defines added by initialization macros may be missing. See the output channel for details.`;
				this.log(`Querying the compiler failed: ${(e as Error).message}`);
			}
		}

		const version = config.get<string>('haxeVersion', '') || (await this.haxeVersion(haxe));
		const source = build ? `the arguments in ${build.label}` : 'settings only';
		const resolved = finish(definesFromArgs(expandLibraries(args, cwd, haxe.env ?? process.env), version), source);
		if (!version) {
			// Don't guess: leave conditions on the Haxe version un-greyed.
			resolved.unknown = new Set(['haxe', 'haxe_ver', 'haxe-ver', 'haxe3', 'haxe4', 'haxe5'].filter((d) => !resolved.defines.has(d)));
			this.log('The Haxe version is unknown; set haxeInactiveRegions.haxeVersion to evaluate conditions that use it.');
		}
		return resolved;
	}

	private haxeVersion(haxe: HaxeExecutable): Promise<string | undefined> {
		if (!vscode.workspace.isTrusted) return Promise.resolve(undefined);
		let result = this.versionCache.get(haxe.path);
		if (!result) {
			result = queryHaxeVersion(haxe.path, haxe.env).catch(() => undefined);
			this.versionCache.set(haxe.path, result);
		}
		return result;
	}
}

/** vshaxe's `haxe.configurations` entries are either an argument list or `{ label, args }`. */
type VshaxeConfiguration = string[] | { label?: string; args: string[] };

async function findBuildConfig(folder: vscode.WorkspaceFolder): Promise<BuildConfig | undefined> {
	const explicit = vscode.workspace.getConfiguration(SECTION, folder.uri).get<string[]>('compilerArgs', []);
	if (explicit.length > 0) return { args: explicit, label: explicit.join(' ') };

	const fromVshaxe = await vshaxeArgs(folder);
	if (fromVshaxe) return { args: fromVshaxe, label: 'vshaxe configuration', vshaxe: fromVshaxe };

	const vshaxe = vscode.workspace.getConfiguration('haxe', folder.uri).get<VshaxeConfiguration[]>('configurations', []);
	if (vshaxe.length > 0) {
		const first = vshaxe[0];
		if (Array.isArray(first)) return { args: first, label: first.join(' '), vshaxe: fromVshaxe };
		if (first && Array.isArray(first.args)) return { args: first.args, label: first.label ?? first.args.join(' '), vshaxe: fromVshaxe };
	}

	let rootHxml: string[] = [];
	try {
		rootHxml = fs.readdirSync(folder.uri.fsPath).filter((f) => f.endsWith('.hxml')).sort();
	} catch {
		// Not a local folder.
	}
	const hxml = rootHxml.includes('build.hxml') ? 'build.hxml' : rootHxml[0];
	if (hxml) return { args: [hxml], label: hxml, vshaxe: fromVshaxe };
	// Nothing to go on yet, but vshaxe will have a configuration shortly.
	return fromVshaxe === null ? { args: [], label: 'waiting for vshaxe', vshaxe: null } : undefined;
}

const VSHAXE_ID = 'nadako.vshaxe';

/** The part of vshaxe's extension API that is used (`getActiveConfiguration` needs vshaxe 2.19+). */
interface VshaxeApi {
	getActiveConfiguration?: () => Promise<unknown>;
}

/**
 * Compiler arguments for vshaxe's active configuration (the one shown in its status bar),
 * `null` if vshaxe has no configuration yet, or `undefined` if vshaxe isn't installed,
 * too old, or turned off in the settings.
 */
async function vshaxeArgs(folder: vscode.WorkspaceFolder): Promise<string[] | null | undefined> {
	if (!vscode.workspace.getConfiguration(SECTION, folder.uri).get<boolean>('useVshaxeConfiguration', true)) return undefined;
	// vshaxe only handles the first workspace folder.
	if (vscode.workspace.workspaceFolders?.[0]?.uri.toString() !== folder.uri.toString()) return undefined;
	const extension = vscode.extensions.getExtension<VshaxeApi>(VSHAXE_ID);
	if (!extension) return undefined;
	try {
		const api = extension.isActive ? extension.exports : await extension.activate();
		if (typeof api?.getActiveConfiguration !== 'function') return undefined;
		// vshaxe waits for a Haxe installation provider before answering, which may never come.
		const timeout = new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5000));
		return argsFromVshaxeConfiguration(await Promise.race([api.getActiveConfiguration(), timeout])) ?? null;
	} catch {
		// vshaxe rejects until it has resolved its configuration, which takes a moment after startup.
		return null;
	}
}

interface HaxeExecutable {
	path: string;
	env?: NodeJS.ProcessEnv;
}

type ExecutableSetting = { path?: string; env?: Record<string, string> };

/** Uses our own setting, then vshaxe's `haxe.executable`, then `haxe` from the PATH. */
function resolveHaxeExecutable(folder: vscode.WorkspaceFolder | undefined): HaxeExecutable {
	const own = vscode.workspace.getConfiguration(SECTION, folder?.uri).get<string>('haxePath', '');
	const vshaxe = vscode.workspace
		.getConfiguration('haxe', folder?.uri)
		.get<string | (ExecutableSetting & Record<string, ExecutableSetting>)>('executable');

	let exe = own || 'auto';
	let env: Record<string, string> | undefined;
	if (!own && typeof vshaxe === 'string') {
		exe = vshaxe;
	} else if (!own && vshaxe && typeof vshaxe === 'object') {
		const platformKey = ({ win32: 'windows', darwin: 'osx', linux: 'linux' } as Record<string, string>)[process.platform];
		const merged = { ...vshaxe, ...(platformKey ? vshaxe[platformKey] : undefined) };
		exe = merged.path ?? 'auto';
		env = merged.env;
	}

	if (exe === 'auto') {
		// Projects using lix have a local haxe shim.
		const local = folder && path.join(folder.uri.fsPath, 'node_modules', '.bin', process.platform === 'win32' ? 'haxe.cmd' : 'haxe');
		exe = local && fs.existsSync(local) ? local : 'haxe';
	} else if (folder && !path.isAbsolute(exe) && /[\\/]/.test(exe)) {
		exe = path.resolve(folder.uri.fsPath, exe);
	}
	return { path: exe, env: env ? { ...process.env, ...env } : undefined };
}

async function selectConfiguration() {
	const editor = vscode.window.activeTextEditor;
	const folder = folderFor(editor?.document);
	if (!folder) {
		vscode.window.showWarningMessage('Open a workspace folder to choose a Haxe build configuration.');
		return;
	}

	type Item = vscode.QuickPickItem & { args: string[] };
	const items: Item[] = [
		{ label: '$(search) Auto-detect', description: 'vshaxe\'s active configuration, then build.hxml', args: [] },
	];
	const vshaxe = vscode.workspace.getConfiguration('haxe', folder.uri).get<VshaxeConfiguration[]>('configurations', []);
	for (const c of vshaxe) {
		const args = Array.isArray(c) ? c : c.args;
		if (!Array.isArray(args)) continue;
		items.push({ label: Array.isArray(c) ? args.join(' ') : c.label ?? args.join(' '), description: 'haxe.configurations', args });
	}
	const files = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*.hxml'), '**/node_modules/**', 500);
	for (const file of files.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
		const rel = path.relative(folder.uri.fsPath, file.fsPath).split(path.sep).join('/');
		items.push({ label: rel, description: 'hxml file', args: [rel] });
	}

	const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Which build should decide what code is active?' });
	if (!picked) return;
	const target = (vscode.workspace.workspaceFolders?.length ?? 0) > 1 ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
	await vscode.workspace
		.getConfiguration(SECTION, folder.uri)
		.update('compilerArgs', picked.args.length > 0 ? picked.args : undefined, target);
}
