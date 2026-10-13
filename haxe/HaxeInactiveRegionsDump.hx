/**
	Initialization macro used by the extension to ask the compiler for the
	exact set of defines a build uses (including those added by haxelibs).

	It is added as the last `--macro` of the build and exits the compiler
	before any typing or code generation happens, so it is fast and has no
	side effects on the project.
**/
class HaxeInactiveRegionsDump {
	public static function run() {
		Sys.println("@@HAXE_INACTIVE_REGIONS_DEFINES@@" + haxe.Json.stringify(haxe.macro.Context.getDefines()));
		Sys.exit(0);
	}
}
