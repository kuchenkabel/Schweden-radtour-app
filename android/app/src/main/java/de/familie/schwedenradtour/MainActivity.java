package de.familie.schwedenradtour;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(FileRangePlugin.class);
        registerPlugin(IncomingFilePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
