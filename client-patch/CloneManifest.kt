import com.reandroid.apk.ApkModule
import com.reandroid.arsc.chunk.xml.ResXmlAttribute
import com.reandroid.arsc.chunk.xml.ResXmlElement
import java.io.File

/**
 * Gives the patched RustDesk APK its own package name so it installs beside the
 * official app (whose data and signature stay untouched).
 *
 * Renamed: the package, provider authorities, and the package-scoped permission
 * androidx derives from the package name at runtime. Component class names are
 * made fully qualified first, so the Java classes keep their original names.
 * The copy is debuggable, so its config can be inspected with `adb shell run-as`.
 *
 * usage: CloneManifestKt <in.apk> <out.apk> [package-suffix]
 */
private const val ORIGINAL_PACKAGE = "com.carriez.flutter_hbb"
private const val DEFAULT_SUFFIX = "p2pfix"
private const val LABEL = "RustDesk P2P fix"

fun main(args: Array<String>) {
    require(args.size in 2..3) { "usage: CloneManifestKt <in.apk> <out.apk> [package-suffix]" }
    val source = File(args[0])
    val target = File(args[1])
    val clonePackage = "$ORIGINAL_PACKAGE.${args.getOrElse(2) { DEFAULT_SUFFIX }}"
    require(source.canonicalFile != target.canonicalFile && !target.exists()) { "refusing to overwrite $target" }
    ApkModule.loadApkFile(source).use { apk ->
        val manifest = apk.androidManifest
        require(manifest.packageName == ORIGINAL_PACKAGE) { "unexpected package ${manifest.packageName}" }
        manifest.ensureFullClassNames()
        val elements = manifest.manifestElement.recursiveElements().asSequence().map { it as ResXmlElement }.toList()
        for (element in elements) {
            for (attribute in element.attributes.asSequence().map { it as ResXmlAttribute }.toList()) {
                val value = attribute.valueString ?: continue
                if (!value.startsWith("$ORIGINAL_PACKAGE.")) continue
                val renamed = value.replaceFirst(ORIGINAL_PACKAGE, clonePackage)
                when {
                    attribute.name == "authorities" -> attribute.setValueAsString(renamed)
                    // <permission>/<uses-permission> names; component names (classes) stay.
                    attribute.name == "name" && element.name in setOf("permission", "uses-permission") ->
                        attribute.setValueAsString(renamed)
                    attribute.name in setOf("permission", "readPermission", "writePermission", "taskAffinity") ->
                        attribute.setValueAsString(renamed)
                }
            }
        }
        apk.packageName = clonePackage
        manifest.setApplicationLabel(LABEL)
        manifest.setDebuggable(true)
        apk.refreshManifest()
        apk.writeApk(target)
    }
    ApkModule.loadApkFile(target).use { apk ->
        require(apk.packageName == clonePackage)
        val perms = apk.androidManifest.usesPermissions
        require("android.permission.INTERNET" in perms)
        require("$clonePackage.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION" in perms)
        require(perms.none { it.startsWith("$ORIGINAL_PACKAGE.") && !it.startsWith(clonePackage) })
    }
    println("Verified manifest: $clonePackage in ${target.name}")
}
