package com.twinklebot.mobile;

import android.content.Context;
import android.content.pm.ActivityInfo;
import android.net.wifi.WifiManager;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InterfaceAddress;
import java.net.NetworkInterface;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

@CapacitorPlugin(name = "LanDiscovery")
public class LanDiscoveryPlugin extends Plugin {
    private static final int DISCOVERY_PORT = 41234;
    private static final String PROBE_MAGIC = "TWINKLEBOT_DISCOVER_V1";
    private final ExecutorService executor = Executors.newCachedThreadPool();

    private JSObject resolveLocalIpv4() {
        JSObject info = new JSObject();
        info.put("ip", "");
        info.put("subnetPrefix", "");
        info.put("broadcast", "255.255.255.255");
        info.put("isWifi", false);
        try {
            Enumeration<NetworkInterface> ifaces = NetworkInterface.getNetworkInterfaces();
            while (ifaces != null && ifaces.hasMoreElements()) {
                NetworkInterface iface = ifaces.nextElement();
                if (!iface.isUp() || iface.isLoopback()) continue;
                for (InterfaceAddress addr : iface.getInterfaceAddresses()) {
                    InetAddress inet = addr.getAddress();
                    if (inet instanceof Inet4Address && inet.isSiteLocalAddress() && !inet.isLoopbackAddress()) {
                        String ip = inet.getHostAddress();
                        if (ip == null) continue;
                        String[] parts = ip.split("\\.");
                        if (parts.length == 4) {
                            String prefix = parts[0] + "." + parts[1] + "." + parts[2];
                            String bcast = addr.getBroadcast() != null
                                ? addr.getBroadcast().getHostAddress()
                                : (prefix + ".255");
                            info.put("ip", ip);
                            info.put("subnetPrefix", prefix);
                            info.put("broadcast", bcast);
                            info.put("isWifi", true);
                            return info;
                        }
                    }
                }
            }
        } catch (Exception ignored) {
        }
        return info;
    }

    @PluginMethod
    public void getNetworkInfo(PluginCall call) {
        call.resolve(resolveLocalIpv4());
    }

    @PluginMethod
    public void discover(PluginCall call) {
        int timeoutMs = Math.max(400, Math.min(4000, call.getInt("timeoutMs", 1200)));
        executor.execute(() -> {
            WifiManager.MulticastLock lock = null;
            DatagramSocket socket = null;
            Map<String, JSObject> found = new LinkedHashMap<>();
            try {
                WifiManager wifi = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
                if (wifi != null) {
                    lock = wifi.createMulticastLock("TwinkleBotLanDiscovery");
                    lock.setReferenceCounted(false);
                    lock.acquire();
                }

                JSObject netInfo = resolveLocalIpv4();
                String bcastIp = netInfo.getString("broadcast", "255.255.255.255");

                socket = new DatagramSocket();
                socket.setBroadcast(true);
                socket.setSoTimeout(350);

                byte[] probe = PROBE_MAGIC.getBytes(StandardCharsets.UTF_8);
                try {
                    socket.send(new DatagramPacket(probe, probe.length, InetAddress.getByName("255.255.255.255"), DISCOVERY_PORT));
                } catch (Exception ignored) {}
                if (bcastIp != null && !bcastIp.isEmpty() && !"255.255.255.255".equals(bcastIp)) {
                    try {
                        socket.send(new DatagramPacket(probe, probe.length, InetAddress.getByName(bcastIp), DISCOVERY_PORT));
                    } catch (Exception ignored) {}
                }

                long deadline = System.currentTimeMillis() + timeoutMs;
                byte[] buf = new byte[4096];
                while (System.currentTimeMillis() < deadline) {
                    DatagramPacket pkt = new DatagramPacket(buf, buf.length);
                    try {
                        socket.receive(pkt);
                        String text = new String(pkt.getData(), 0, pkt.getLength(), StandardCharsets.UTF_8).trim();
                        JSONObject json = new JSONObject(text);
                        if (!"TWINKLEBOT_OFFER_V1".equals(json.optString("type"))) continue;
                        String instanceId = json.optString("instanceId", "");
                        if (instanceId.isEmpty()) continue;
                        String host = pkt.getAddress().getHostAddress();
                        int port = json.optInt("port", 3230);
                        JSObject item = new JSObject();
                        item.put("instanceId", instanceId);
                        item.put("hostname", json.optString("hostname", host));
                        item.put("platform", json.optString("platform", ""));
                        item.put("port", port);
                        item.put("host", host);
                        item.put("baseUrl", "http://" + host + ":" + port);
                        item.put("appVersion", json.optString("appVersion", ""));
                        item.put("lanAccessEnabled", json.optBoolean("lanAccessEnabled", true));
                        found.put(instanceId, item);
                    } catch (SocketTimeoutException ignored) {
                    } catch (Exception ignored) {
                    }
                }
            } catch (Exception ignored) {
            } finally {
                if (socket != null) {
                    try { socket.close(); } catch (Exception ignored) {}
                }
                if (lock != null && lock.isHeld()) {
                    try { lock.release(); } catch (Exception ignored) {}
                }
            }

            JSArray devices = new JSArray();
            for (JSObject item : found.values()) {
                devices.put(item);
            }
            JSObject result = new JSObject();
            result.put("devices", devices);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void setScreenOrientation(PluginCall call) {
        String mode = call.getString("mode", "portrait");
        if (getActivity() == null) {
            call.resolve();
            return;
        }
        getActivity().runOnUiThread(() -> {
            try {
                boolean allowLandscape = "sensor".equalsIgnoreCase(mode);
                getActivity().setRequestedOrientation(
                    allowLandscape
                        ? ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
                        : ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                );
                Window window = getActivity().getWindow();
                if (window != null) {
                    WindowInsetsControllerCompat controller =
                        WindowCompat.getInsetsController(window, window.getDecorView());
                    if (controller != null) {
                        if (allowLandscape) {
                            controller.setSystemBarsBehavior(
                                WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                            );
                            controller.hide(WindowInsetsCompat.Type.systemBars());
                        } else {
                            controller.show(WindowInsetsCompat.Type.systemBars());
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            call.resolve();
        });
    }
}
