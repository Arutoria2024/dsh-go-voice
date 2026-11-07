package io.github.ccch1mneyyy.dsh_app.voice

import android.content.Context
import io.github.ccch1mneyyy.dsh_app.files.GuestFiles
import org.json.JSONObject
import java.io.File
import java.io.IOException

/**
 * The voice service's private config, inside the app's Linux runtime:
 * `<rootfs>/root/.dsh/voice/config.json` (mode 0600, directory 0700).
 *
 * Only *this* file carries provider keys, and it lives in app-private storage —
 * never in the APK, the source tree, SharedPreferences, logs or diagnostics.
 * The Dart side reads the key from Android Keystore-backed storage and hands the
 * assembled JSON here; this class only writes it and reports presence flags back
 * (never the values).
 *
 * Written with the same proven technique as [io.github.ccch1mneyyy.dsh_app.phone.PhoneGuest]:
 * a sibling temp file renamed over the target, permissions via java.io. Flutter's
 * `Files.move(ATOMIC_MOVE)` / POSIX calls throw on some Android filesystems and
 * used to surface as a bogus "write-failed" before the key was even stored.
 */
object VoiceConfigStore {
    private const val DIR = "root/.dsh/voice"
    private const val FILE = "config.json"

    private fun dir(context: Context): File = File(GuestFiles.rootfs(context), DIR)
    private fun file(context: Context): File = File(dir(context), FILE)

    /** Writes [json] atomically with 0600. Returns the written byte count. */
    @Synchronized
    fun write(context: Context, json: String): Long {
        val dir = dir(context)
        if (dir.exists() && !dir.isDirectory) dir.delete()
        if (!dir.isDirectory && !dir.mkdirs()) throw IOException("cannot create ${dir.path}")
        restrict(dir, exec = true)
        val target = file(context)
        val tmp = File(dir, ".$FILE.${System.nanoTime()}.tmp")
        try {
            if (!tmp.createNewFile()) throw IOException("cannot create tmp ${tmp.path}")
            restrict(tmp, exec = false)
            tmp.writeText(json, Charsets.UTF_8)
            if (!tmp.renameTo(target)) {
                // Filesystems without atomic rename: write through, then drop the temp.
                target.writeText(json, Charsets.UTF_8)
                tmp.delete()
            }
            restrict(target, exec = false)
            return target.length()
        } finally {
            if (tmp.exists()) tmp.delete()
        }
    }

    fun clear(context: Context): Boolean = file(context).delete() || !file(context).exists()

    /** Presence of the file and whether each service has a key/base. Never returns a value. */
    fun status(context: Context): Map<String, Any> {
        val target = file(context)
        if (!target.isFile) return mapOf("present" to false, "asr" to false, "tts" to false)
        val json = runCatching { JSONObject(target.readText(Charsets.UTF_8)) }.getOrNull()
            ?: return mapOf("present" to true, "asr" to false, "tts" to false, "invalid" to true)
        val asr = json.optString("siliconflowKey").isNotEmpty()
        // Either half is enough: cloud TTS has a base and no key; a LAN gateway may need both.
        val tts = json.optString("ttsBase").isNotEmpty() || json.optString("ttsKey").isNotEmpty()
        return mapOf("present" to true, "asr" to asr, "tts" to tts)
    }

    private fun restrict(f: File, exec: Boolean) {
        runCatching {
            f.setReadable(false, false)
            f.setWritable(false, false)
            f.setExecutable(false, false)
            f.setReadable(true, true)
            f.setWritable(true, true)
            if (exec) f.setExecutable(true, true)
        }
    }
}
