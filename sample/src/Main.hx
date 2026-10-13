class Main {
	static function main() {
		#if new_renderer
		var renderer = new NewRenderer();
		#else
		var renderer = new OldRenderer();
		#end

		// A whole-line directive and a single-line one.
		#if js trace("running on JS"); #else trace("not JS"); #end

		#if (api_level >= 3)
		useModernApi();
		#elseif (api_level == 2)
		useLegacyApi();
		#else
		useAncientApi();
		#end

		#if (sys && !debug)
		Sys.println("sys release");
			#if cpp
			nativeOnly();
			#end
		#end

		#if (haxe >= version("4.0.0"))
		var s = "#if this is just a string";
		#else
		haxe3Fallback();
		#end

		// Hover over any #if / #elseif / #else to see why it is (in)active.
	}
}
