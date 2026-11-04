package ai.accesscare.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.ViewGroup;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

/**
 * AccessCare for Android: the AccessCare web app in a full-screen window of its own (no browser bar),
 * with the phone's speech recognizer and voices made available to it, the camera and microphone after
 * Android's permission prompt, and phone links (emergency numbers) opening the phone's dialer.
 */
public class MainActivity extends Activity {
    static final String HOME = "https://yasibrahim1414-blip.github.io/accesscare-ai/";
    static final String HOST = "yasibrahim1414-blip.github.io";
    static final String PATH = "/accesscare-ai";

    private static final int REQ_MEDIA = 11;
    private static final int REQ_LISTEN = 12;
    private static final int REQ_FILE = 13;
    private static final int REQ_CAMERA_FOR_FILE = 14;

    private WebView web;
    private SpeechBridge speech;
    private String bridgeJs = "";
    private PermissionRequest pendingWebPermission;
    private ValueCallback<Uri[]> pendingFiles;
    private WebChromeClient.FileChooserParams pendingFileParams;
    private Uri photoUri;
    private Runnable afterMicPermission;
    private final Handler main = new Handler(Looper.getMainLooper());
    private boolean showingOffline = false;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        bridgeJs = readAsset("bridge.js");
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.WHITE);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setUserAgentString(s.getUserAgentString() + " AccessCareAndroid/1");

        speech = new SpeechBridge(this, web);
        web.addJavascriptInterface(speech, "AndroidSpeech");
        web.addJavascriptInterface(new AppBridge(), "AndroidApp");
        web.setWebViewClient(new Client());
        web.setWebChromeClient(new Chrome());

        if (saved != null) web.restoreState(saved);
        else web.loadUrl(HOME);
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    public void onBackPressed() {
        if (web.canGoBack() && !showingOffline) web.goBack();
        else super.onBackPressed();
    }

    @Override
    protected void onPause() {
        super.onPause();
        speech.pauseAll(); // nothing listens while the app is in the background
        web.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        speech.resumeAll();
        web.onResume();
    }

    @Override
    protected void onDestroy() {
        speech.shutdown();
        web.destroy();
        super.onDestroy();
    }

    /** Only AccessCare's own pages run inside the app; the speech objects are given only to them. */
    static boolean isOurs(Uri u) {
        if (u == null) return false;
        String p = u.getPath() == null ? "" : u.getPath();
        return "https".equals(u.getScheme()) && HOST.equalsIgnoreCase(u.getHost()) && (p.equals(PATH) || p.startsWith(PATH + "/"));
    }

    private void inject(WebView v) {
        Uri u = Uri.parse(v.getUrl() == null ? "" : v.getUrl());
        if (isOurs(u) && !bridgeJs.isEmpty()) v.evaluateJavascript(bridgeJs, null);
    }

    private class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest req) {
            Uri u = req.getUrl();
            if (isOurs(u)) return false;
            openOutside(u);
            return true;
        }

        @Override
        public void onPageStarted(WebView v, String url, Bitmap icon) {
            super.onPageStarted(v, url, icon);
            inject(v);
        }

        @Override
        public void onPageCommitVisible(WebView v, String url) {
            super.onPageCommitVisible(v, url);
            inject(v);
        }

        @Override
        public void onPageFinished(WebView v, String url) {
            super.onPageFinished(v, url);
            inject(v);
        }

        @Override
        public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
            if (!req.isForMainFrame()) return;
            showingOffline = true;
            String html = "<!doctype html><html><head><meta name=viewport content='width=device-width,initial-scale=1'>"
                + "<style>body{font-family:sans-serif;margin:0;padding:32px 20px;color:#111;background:#fff;text-align:center}"
                + "h1{font-size:22px;color:#0e7c7b}p{font-size:17px;line-height:1.5}button{font-size:18px;padding:14px 26px;border:0;border-radius:12px;background:#0e7c7b;color:#fff}</style></head><body>"
                + "<h1>AccessCare</h1><p>AccessCare could not open. Please check the internet connection, then try again.</p>"
                + "<p dir=rtl>أكسس كير مش قادر يفتح. اتأكد من الإنترنت وجرّب تاني.</p>"
                + "<button onclick='AndroidApp.retry()'>Try again · جرّب تاني</button></body></html>";
            v.loadDataWithBaseURL(null, html, "text/html", "utf-8", null);
        }
    }

    private class Chrome extends WebChromeClient {
        @Override
        public void onPermissionRequest(final PermissionRequest req) {
            runOnUiThread(() -> {
                if (!isOurs(req.getOrigin())) { req.deny(); return; }
                List<String> need = new ArrayList<>();
                for (String r : req.getResources()) {
                    if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && !has(Manifest.permission.CAMERA)) need.add(Manifest.permission.CAMERA);
                    if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && !has(Manifest.permission.RECORD_AUDIO)) need.add(Manifest.permission.RECORD_AUDIO);
                }
                if (need.isEmpty()) { grantAllowed(req); return; }
                if (pendingWebPermission != null) pendingWebPermission.deny();
                pendingWebPermission = req;
                requestPermissions(need.toArray(new String[0]), REQ_MEDIA);
            });
        }

        @Override
        public void onPermissionRequestCanceled(PermissionRequest req) {
            if (pendingWebPermission == req) pendingWebPermission = null;
        }

        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams params) {
            if (pendingFiles != null) pendingFiles.onReceiveValue(null);
            pendingFiles = cb;
            pendingFileParams = params;
            if (params.isCaptureEnabled() && hasCameraApp()) {
                if (has(Manifest.permission.CAMERA)) takePhoto();
                else requestPermissions(new String[]{Manifest.permission.CAMERA}, REQ_CAMERA_FOR_FILE);
            } else pickFile();
            return true;
        }
    }

    // ------------------------------------------------------------ permissions
    boolean has(String p) { return checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }

    private void grantAllowed(PermissionRequest req) {
        List<String> ok = new ArrayList<>();
        for (String r : req.getResources()) {
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && has(Manifest.permission.CAMERA)) ok.add(r);
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && has(Manifest.permission.RECORD_AUDIO)) ok.add(r);
        }
        if (ok.isEmpty()) req.deny(); else req.grant(ok.toArray(new String[0]));
    }

    /** Asks Android for the microphone (if not allowed yet), then runs the listening step. */
    void withMicrophone(Runnable then, Runnable denied) {
        runOnUiThread(() -> {
            if (has(Manifest.permission.RECORD_AUDIO)) { then.run(); return; }
            afterMicPermission = () -> { if (has(Manifest.permission.RECORD_AUDIO)) then.run(); else denied.run(); };
            requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, REQ_LISTEN);
        });
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
        super.onRequestPermissionsResult(code, perms, results);
        if (code == REQ_MEDIA && pendingWebPermission != null) {
            PermissionRequest r = pendingWebPermission; pendingWebPermission = null;
            grantAllowed(r);
        } else if (code == REQ_LISTEN && afterMicPermission != null) {
            Runnable r = afterMicPermission; afterMicPermission = null; r.run();
        } else if (code == REQ_CAMERA_FOR_FILE) {
            if (has(Manifest.permission.CAMERA)) takePhoto(); else pickFile();
        }
    }

    // ------------------------------------------------------------ photos
    private boolean hasCameraApp() {
        return new Intent(MediaStore.ACTION_IMAGE_CAPTURE).resolveActivity(getPackageManager()) != null;
    }

    private void takePhoto() {
        try {
            File dir = new File(getCacheDir(), "photos");
            if (!dir.exists()) dir.mkdirs();
            File[] old = dir.listFiles();
            if (old != null) for (File f : old) f.delete(); // only the newest photo is kept, until the next one
            File f = new File(dir, "photo-" + System.currentTimeMillis() + ".jpg");
            photoUri = PhotoProvider.uriFor(this, f);
            Intent i = new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
            i.putExtra(MediaStore.EXTRA_OUTPUT, photoUri);
            i.addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION | Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivityForResult(i, REQ_FILE);
        } catch (Exception e) {
            photoUri = null;
            pickFile();
        }
    }

    private void pickFile() {
        photoUri = null;
        try {
            Intent i = pendingFileParams != null ? pendingFileParams.createIntent() : new Intent(Intent.ACTION_GET_CONTENT).setType("image/*");
            i.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(i, REQ_FILE);
        } catch (ActivityNotFoundException e) {
            if (pendingFiles != null) { pendingFiles.onReceiveValue(null); pendingFiles = null; }
        }
    }

    @Override
    protected void onActivityResult(int code, int result, Intent data) {
        super.onActivityResult(code, result, data);
        if (code != REQ_FILE || pendingFiles == null) return;
        Uri[] out = null;
        if (result == RESULT_OK) {
            if (photoUri != null) out = new Uri[]{photoUri};
            else if (data != null && data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                out = new Uri[n];
                for (int k = 0; k < n; k++) out[k] = data.getClipData().getItemAt(k).getUri();
            } else if (data != null && data.getData() != null) out = new Uri[]{data.getData()};
        }
        pendingFiles.onReceiveValue(out);
        pendingFiles = null; photoUri = null;
    }

    // ------------------------------------------------------------ links outside the app
    void openOutside(Uri u) {
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        Intent i;
        if (scheme.equals("tel")) i = new Intent(Intent.ACTION_DIAL, u); // the dialer opens with the number; the person presses call
        else if (scheme.equals("mailto") || scheme.equals("sms") || scheme.equals("smsto")) i = new Intent(Intent.ACTION_SENDTO, u);
        else if (scheme.equals("http") || scheme.equals("https")) i = new Intent(Intent.ACTION_VIEW, u);
        else if (scheme.equals("intent")) {
            try { i = Intent.parseUri(u.toString(), Intent.URI_INTENT_SCHEME); i.addCategory(Intent.CATEGORY_BROWSABLE); i.setComponent(null); i.setSelector(null); }
            catch (Exception e) { return; }
        } else return; // javascript:, file:, content: and others are never opened
        try { startActivity(i); } catch (ActivityNotFoundException e) { /* no app for it */ }
    }

    // ------------------------------------------------------------ small helpers for the page
    private class AppBridge {
        @android.webkit.JavascriptInterface
        public void retry() {
            main.post(() -> { showingOffline = false; web.clearHistory(); web.loadUrl(HOME); });
        }

        /** a text file the page wanted to save (e.g. the recovery code): shown in Android's share sheet */
        @android.webkit.JavascriptInterface
        public void shareText(String name, String text) {
            main.post(() -> {
                if (!isOurs(Uri.parse(web.getUrl() == null ? "" : web.getUrl()))) return;
                Intent i = new Intent(Intent.ACTION_SEND);
                i.setType("text/plain");
                i.putExtra(Intent.EXTRA_SUBJECT, name);
                i.putExtra(Intent.EXTRA_TEXT, text);
                try { startActivity(Intent.createChooser(i, name)); } catch (ActivityNotFoundException e) { /* */ }
            });
        }
    }

    private String readAsset(String name) {
        try (InputStream in = getAssets().open(name)) {
            ByteArrayOutputStream b = new ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            while ((n = in.read(buf)) > 0) b.write(buf, 0, n);
            return new String(b.toByteArray(), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return "";
        }
    }
}
