package com.twinklebot.mobile;

import android.Manifest;
import android.content.Intent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.journeyapps.barcodescanner.ScanIntentResult;
import com.journeyapps.barcodescanner.ScanOptions;

@CapacitorPlugin(
    name = "QrScanner",
    permissions = {
        @Permission(alias = "camera", strings = { Manifest.permission.CAMERA })
    }
)
public class QrScannerPlugin extends Plugin {
    @PluginMethod
    public void scan(PluginCall call) {
        if (getActivity() == null) {
            JSObject res = new JSObject();
            res.put("ok", false);
            res.put("error", "Activity unavailable");
            call.resolve(res);
            return;
        }
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            requestPermissionForAlias("camera", call, "cameraPermissionCallback");
            return;
        }
        launchScanner(call);
    }

    @PermissionCallback
    private void cameraPermissionCallback(PluginCall call) {
        if (call == null) return;
        if (getPermissionState("camera") != PermissionState.GRANTED) {
            JSObject res = new JSObject();
            res.put("ok", false);
            res.put("permissionDenied", true);
            call.resolve(res);
            return;
        }
        launchScanner(call);
    }

    private void launchScanner(PluginCall call) {
        String prompt = call.getString("prompt", "");
        ScanOptions options = new ScanOptions();
        options.setDesiredBarcodeFormats(ScanOptions.QR_CODE);
        options.setBeepEnabled(false);
        options.setOrientationLocked(true);
        if (prompt != null && !prompt.trim().isEmpty()) {
            options.setPrompt(prompt.trim());
        }
        Intent intent = options.createScanIntent(getContext());
        startActivityForResult(call, intent, "handleScanResult");
    }

    @ActivityCallback
    private void handleScanResult(PluginCall call, ActivityResult result) {
        if (call == null) return;
        ScanIntentResult parsed = ScanIntentResult.parseActivityResult(
            result.getResultCode(),
            result.getData()
        );
        JSObject out = new JSObject();
        if (parsed == null || parsed.getContents() == null || parsed.getContents().trim().isEmpty()) {
            out.put("ok", false);
            out.put("cancelled", true);
            call.resolve(out);
            return;
        }
        out.put("ok", true);
        out.put("content", parsed.getContents().trim());
        call.resolve(out);
    }
}
