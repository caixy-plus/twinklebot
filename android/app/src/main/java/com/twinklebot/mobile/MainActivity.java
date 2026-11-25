package com.twinklebot.mobile;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        WebUpdaterPlugin.prepareBeforeBridgeCreate(this);
        registerPlugin(LanDiscoveryPlugin.class);
        registerPlugin(QrScannerPlugin.class);
        registerPlugin(WebUpdaterPlugin.class);
        super.onCreate(savedInstanceState);
        WebUpdaterPlugin.bindBridge(getBridge());
    }
}
