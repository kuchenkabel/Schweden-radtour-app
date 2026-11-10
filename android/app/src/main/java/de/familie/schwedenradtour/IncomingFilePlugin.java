package de.familie.schwedenradtour;

import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;

/**
 * Nimmt Dateien entgegen, die per "Öffnen mit …" oder "Teilen" an die App geschickt werden (z. B. GPX).
 * Die JS-Seite holt eine beim Start wartende Datei mit take() ab und hört danach auf "fileOpened".
 */
@CapacitorPlugin(name = "IncomingFile")
public class IncomingFilePlugin extends Plugin {
    private static final int MAX_BYTES = 30 * 1024 * 1024;
    private JSObject pending;

    @Override
    public void load() {
        handle(getActivity().getIntent());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        handle(intent);
    }

    private void handle(Intent intent) {
        if (intent == null) return;
        Uri uri = null;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action)) {
            uri = intent.getData();
        } else if (Intent.ACTION_SEND.equals(action)) {
            uri = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                : intent.getParcelableExtra(Intent.EXTRA_STREAM);
        }
        if (uri == null) return;
        // Nicht noch einmal verarbeiten, wenn die Activity neu erzeugt wird (z. B. Drehen)
        intent.setAction(Intent.ACTION_MAIN);
        intent.setData(null);

        JSObject r = new JSObject();
        r.put("name", uri.getLastPathSegment());
        try (InputStream in = getContext().getContentResolver().openInputStream(uri)) {
            if (in == null) throw new Exception("Datei nicht lesbar");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[65536];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
                if (out.size() > MAX_BYTES) throw new Exception("Datei zu groß");
            }
            r.put("text", new String(out.toByteArray(), StandardCharsets.UTF_8));
        } catch (Exception e) {
            r.put("error", "Datei konnte nicht gelesen werden: " + e.getMessage());
        }
        pending = r;
        if (hasListeners("fileOpened")) {
            pending = null;
            notifyListeners("fileOpened", r);
        }
    }

    @PluginMethod
    public void take(PluginCall call) {
        JSObject r = pending != null ? pending : new JSObject();
        pending = null;
        call.resolve(r);
    }
}
