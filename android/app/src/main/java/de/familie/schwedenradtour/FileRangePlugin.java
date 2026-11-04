package de.familie.schwedenradtour;

import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.RandomAccessFile;
import java.util.HashMap;
import java.util.Map;

/**
 * Liest Byte-Bereiche aus lokalen Dateien (für Offline-Kartenpakete im PMTiles-Format).
 * Der WebView-Server von Capacitor liefert bei Range-Anfragen sonst die ganze Datei.
 */
@CapacitorPlugin(name = "FileRange")
public class FileRangePlugin extends Plugin {
    private final Map<String, RandomAccessFile> open = new HashMap<>();

    private synchronized RandomAccessFile file(String path) throws Exception {
        RandomAccessFile f = open.get(path);
        if (f == null) {
            f = new RandomAccessFile(path, "r");
            open.put(path, f);
        }
        return f;
    }

    @PluginMethod
    public void read(PluginCall call) {
        String path = call.getString("path");
        Double offsetD = call.getDouble("offset");
        Integer length = call.getInt("length");
        if (path == null || offsetD == null || length == null) {
            call.reject("path, offset und length nötig");
            return;
        }
        if (path.startsWith("file://")) path = path.substring(7);
        long offset = offsetD.longValue();
        try {
            byte[] buf;
            synchronized (this) {
                RandomAccessFile f = file(path);
                long size = f.length();
                int n = (int) Math.max(0, Math.min(length, size - offset));
                buf = new byte[n];
                f.seek(offset);
                f.readFully(buf);
            }
            JSObject r = new JSObject();
            r.put("data", Base64.encodeToString(buf, Base64.NO_WRAP));
            call.resolve(r);
        } catch (Exception e) {
            call.reject("Lesefehler: " + e.getMessage());
        }
    }

    @PluginMethod
    public void close(PluginCall call) {
        synchronized (this) {
            for (RandomAccessFile f : open.values()) {
                try { f.close(); } catch (Exception ignored) { }
            }
            open.clear();
        }
        call.resolve();
    }
}
