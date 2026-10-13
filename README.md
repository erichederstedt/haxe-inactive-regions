# Haxe Inactive Regions

Greys out Haxe code that is excluded by conditional compilation (`#if` / `#elseif` / `#else` / `#end`),
the way C/C++ editors grey out inactive `#ifdef` blocks.

## How it decides what is active

1. **Which build**: `haxeInactiveRegions.compilerArgs` if set, otherwise the active configuration of the
   Haxe extension (vshaxe 2.19+, the one shown in its status bar; this also covers Lime/OpenFL projects),
   otherwise the first entry of `haxe.configurations`, otherwise `build.hxml`, otherwise the first `.hxml`
   in the workspace folder.
   In a multi-root workspace, a folder without a build of its own (no folder-level `compilerArgs` or
   `haxe.configurations`, and no `.hxml` in its root, or a `haxelib.json` there) uses the first folder's build,
   so files of a library added to the workspace are greyed according to the game that uses it. vshaxe provides the configuration's defines (including those of libraries and
   their dependencies) and target but not its raw arguments, so defines that libraries add in initialization
   macros are not seen in that case; set `haxeInactiveRegions.useVshaxeConfiguration` to `false` to use the hxml instead.
   Use **Haxe Inactive Regions: Select Build Configuration** (or click the status bar item) to pick one.
   If the build has several compilations (`--next`), the first one is used.
2. **Which defines**: the extension runs the Haxe compiler with the build's arguments plus a tiny
   initialization macro that prints `Context.getDefines()` and exits before typing, so it is fast and
   exact, including defines added by haxelibs, target defines (`js`, `sys`, `target.name`, …) and
   version defines (`haxe4`, `haxe_ver`, …).
   If the compiler can't be run (not installed, missing haxelibs, untrusted workspace), the defines are
   estimated from the hxml (`-D`, `-lib`, target flags, `--debug`) and the status bar shows a warning.
   Libraries are looked up in the haxelib repository (or lix's `haxe_libraries`), so their versions,
   dependencies and `extraParams.hxml` defines are included; only defines set by initialization macros are missed.
3. **Overrides**: `haxeInactiveRegions.defines` adds (`name`, `name=value`) or removes (`!name`) defines.

Conditions are evaluated with the compiler's own rules (string vs. numeric comparison, `version("x.y.z")`,
dotted names like `target.sys`, unparenthesised single-operand conditions such as `#if js trace(1); #end`).
A condition that can't be evaluated (syntax error, unknown value) is left un-greyed.

Hover over an `#if` / `#elseif` / `#else` to see the condition's value and the defines it uses.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `haxeInactiveRegions.enabled` | `true` | Turn greying on/off (also: **Toggle Greying** command). |
| `haxeInactiveRegions.opacity` | `0.4` | Opacity of inactive code. |
| `haxeInactiveRegions.compilerArgs` | `[]` | Build arguments, e.g. `["build.hxml"]`. |
| `haxeInactiveRegions.useVshaxeConfiguration` | `true` | Follow vshaxe's active configuration. |
| `haxeInactiveRegions.defines` | `[]` | Extra defines: `name`, `name=value`, `!name`. |
| `haxeInactiveRegions.definesSource` | `auto` | `auto` (ask the compiler) or `hxml` (never run it). |
| `haxeInactiveRegions.haxePath` | `""` | Haxe executable; defaults to vshaxe's `haxe.executable`, a lix shim, or `haxe`. |
| `haxeInactiveRegions.haxeVersion` | `""` | Haxe version for the `hxml` fallback; defaults to `haxe --version`. |

Defines are refreshed automatically when `.hxml` files or settings change. Run **Refresh** after
installing/upgrading haxelibs. **Show Active Defines** lists the defines in the output panel.

## Development

Requires Node 20 or newer. The dev container (`.devcontainer.json`) provides Node 26 and installs Haxe via
`scripts/install-haxe.sh`.

```sh
npm install
npm test            # unit tests; set HAXE=/path/to/haxe to also check against the real compiler
npm run package     # builds haxe-inactive-regions-<version>.vsix
```

Press F5 (**Run Extension**) to open the `sample/` project in an Extension Development Host.
