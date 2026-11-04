package ai.accesscare.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.speech.tts.Voice;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Locale;
import java.util.Set;

/**
 * The phone's speech services for the web app (see assets/bridge.js):
 * listening with Android's SpeechRecognizer, speaking with Android's TextToSpeech.
 * Results go back to the page; nothing is recorded or kept by this app.
 */
public class SpeechBridge {
    private final MainActivity act;
    private final WebView web;
    private final Handler main = new Handler(Looper.getMainLooper());

    private SpeechRecognizer recognizer;
    private int recId = 0;          // the listening turn the page is waiting for
    private boolean recFinal = false;
    private boolean background = false; // the app is not on screen: no listening

    private TextToSpeech tts;
    private boolean ttsReady = false;
    private final ArrayList<Object[]> waiting = new ArrayList<>(); // speak requests made before the voice engine was ready

    SpeechBridge(MainActivity act, WebView web) {
        this.act = act;
        this.web = web;
        tts = new TextToSpeech(act.getApplicationContext(), status -> main.post(() -> {
            ttsReady = status == TextToSpeech.SUCCESS;
            if (ttsReady) {
                tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
                    @Override public void onStart(String id) { send("__acTts", id, "'start'", "''"); }
                    @Override public void onDone(String id) { send("__acTts", id, "'end'", "''"); }
                    @Override public void onError(String id) { send("__acTts", id, "'error'", "'synthesis-failed'"); }
                    @Override public void onError(String id, int code) {
                        send("__acTts", id, "'error'", code == TextToSpeech.ERROR_NETWORK || code == TextToSpeech.ERROR_NETWORK_TIMEOUT ? "'network'" : "'synthesis-failed'");
                    }
                    @Override public void onStop(String id, boolean interrupted) { /* the page already knows: it asked to stop */ }
                });
                js("window.__acVoices&&window.__acVoices()");
            }
            for (Object[] w : waiting) {
                if (ttsReady) doSpeak((Integer) w[0], (String) w[1], (String) w[2], (String) w[3], (Float) w[4], (Float) w[5], (Float) w[6]);
                else send("__acTts", String.valueOf(w[0]), "'error'", "'synthesis-unavailable'");
            }
            waiting.clear();
        }));
    }

    private boolean pageIsOurs() {
        String u = web.getUrl();
        return u != null && MainActivity.isOurs(Uri.parse(u));
    }

    private void js(String code) {
        main.post(() -> { if (pageIsOurs()) web.evaluateJavascript(code, null); });
    }

    /** calls window[fn](id, a, b) in the page; a and b are already JavaScript literals */
    private void send(String fn, String id, String a, String b) {
        String n = id == null ? "0" : id.replaceAll("[^0-9]", "");
        if (n.isEmpty()) return;
        js("window." + fn + "&&window." + fn + "(" + n + "," + a + "," + b + ")");
    }

    static String quote(String s) { return JSONObject.quote(s == null ? "" : s); }

    // ------------------------------------------------------------ listening
    @JavascriptInterface
    public void listen(final int id, final String lang, final boolean interim, final int maxAlts) {
        main.post(() -> {
            if (!pageIsOurs()) return;
            cancelRecognizer();
            recId = id; recFinal = false;
            if (background) { recError(id, "aborted", ""); return; }
            if (!SpeechRecognizer.isRecognitionAvailable(act)) {
                recError(id, "service-not-allowed", "This phone has no speech recognition service.");
                return;
            }
            act.withMicrophone(() -> { if (recId == id) startRecognizer(id, lang, interim, maxAlts); },
                () -> recError(id, "not-allowed", "Microphone permission was not given."));
        });
    }

    private void startRecognizer(final int id, String lang, boolean interim, int maxAlts) {
        try {
            recognizer = SpeechRecognizer.createSpeechRecognizer(act);
        } catch (Exception e) {
            recError(id, "service-not-allowed", "");
            return;
        }
        recognizer.setRecognitionListener(new RecognitionListener() {
            @Override public void onReadyForSpeech(Bundle b) { if (recId == id) rec(id, "start", "{}"); }
            @Override public void onBeginningOfSpeech() { }
            @Override public void onRmsChanged(float v) { }
            @Override public void onBufferReceived(byte[] b) { }
            @Override public void onEndOfSpeech() { }
            @Override public void onError(int code) {
                if (recId != id) return;
                String e;
                switch (code) {
                    case SpeechRecognizer.ERROR_NO_MATCH:
                    case SpeechRecognizer.ERROR_SPEECH_TIMEOUT: e = "no-speech"; break;
                    case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: e = "not-allowed"; break;
                    case SpeechRecognizer.ERROR_NETWORK:
                    case SpeechRecognizer.ERROR_NETWORK_TIMEOUT:
                    case SpeechRecognizer.ERROR_SERVER: e = "network"; break;
                    case SpeechRecognizer.ERROR_AUDIO: e = "audio-capture"; break;
                    case SpeechRecognizer.ERROR_RECOGNIZER_BUSY: e = "aborted"; break;
                    default: e = (code == 12 || code == 13) ? "language-not-supported" : "other"; // 12/13: language not supported / unavailable (Android 12+)
                }
                recError(id, e, "");
            }
            @Override public void onPartialResults(Bundle b) {
                if (recId != id) return;
                ArrayList<String> r = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                if (r != null && !r.isEmpty() && !r.get(0).trim().isEmpty()) rec(id, "result", result(r, null, false));
            }
            @Override public void onResults(Bundle b) {
                if (recId != id) return;
                ArrayList<String> r = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
                float[] conf = b.getFloatArray(SpeechRecognizer.CONFIDENCE_SCORES);
                recFinal = true;
                if (r != null && !r.isEmpty()) rec(id, "result", result(r, conf, true));
                else rec(id, "error", "{error:'no-speech'}");
                endTurn(id);
            }
            @Override public void onEvent(int t, Bundle b) { }
        });
        Intent i = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE, lang);
        i.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, lang);
        i.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, interim);
        i.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, Math.max(1, Math.min(5, maxAlts)));
        i.putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, act.getPackageName());
        // wait longer before deciding the person has finished (people who speak slowly or with effort)
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, 2500L);
        i.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, 2000L);
        try {
            recognizer.startListening(i);
        } catch (Exception e) {
            recError(id, "other", "");
        }
    }

    private static String result(ArrayList<String> alts, float[] conf, boolean fin) {
        JSONArray a = new JSONArray();
        for (String s : alts) a.put(s);
        JSONArray c = new JSONArray();
        if (conf != null) for (float f : conf) { try { c.put((double) f); } catch (Exception e) { /* */ } }
        return "{alts:" + a + ",conf:" + c + ",final:" + fin + "}";
    }

    private void rec(int id, String kind, String payload) {
        js("window.__acRec&&window.__acRec(" + id + ",'" + kind + "'," + payload + ")");
    }

    private void recError(int id, String error, String message) {
        if (recId != id) return;
        rec(id, "error", "{error:" + quote(error) + ",message:" + quote(message) + "}");
        endTurn(id);
    }

    private void endTurn(int id) {
        rec(id, "end", "{}");
        if (recId == id) { recId = 0; destroyRecognizer(); }
    }

    @JavascriptInterface
    public void stopListening(final int id) {
        main.post(() -> { if (recId == id && recognizer != null) recognizer.stopListening(); else if (recId == id) endTurn(id); });
    }

    @JavascriptInterface
    public void cancelListening(final int id) {
        main.post(() -> { if (recId == id) { recId = 0; cancelRecognizer(); } });
    }

    private void cancelRecognizer() {
        if (recognizer != null) { try { recognizer.cancel(); } catch (Exception e) { /* */ } }
        destroyRecognizer();
    }

    private void destroyRecognizer() {
        if (recognizer != null) {
            final SpeechRecognizer r = recognizer;
            recognizer = null;
            main.post(() -> { try { r.destroy(); } catch (Exception e) { /* */ } });
        }
    }

    // ------------------------------------------------------------ speaking
    /** the phone's voices, plus one "default voice" per language (the engine picks its best voice for it) */
    @JavascriptInterface
    public String voices() {
        JSONArray out = new JSONArray();
        if (!ttsReady) return out.toString();
        try {
            Set<Voice> vs = tts.getVoices();
            if (vs == null) return out.toString();
            Set<String> langs = new LinkedHashSet<>();
            ArrayList<Voice> usable = new ArrayList<>();
            for (Voice v : vs) {
                if (v.getFeatures() != null && v.getFeatures().contains(TextToSpeech.Engine.KEY_FEATURE_NOT_INSTALLED)) continue;
                usable.add(v);
                langs.add(v.getLocale().toLanguageTag());
            }
            for (String l : langs) {
                JSONObject o = new JSONObject();
                o.put("voiceURI", "default:" + l);
                o.put("name", "Phone voice (" + Locale.forLanguageTag(l).getDisplayName(Locale.ENGLISH) + ")");
                o.put("lang", l);
                o.put("localService", true);
                o.put("default", true);
                out.put(o);
            }
            for (Voice v : usable) {
                JSONObject o = new JSONObject();
                o.put("voiceURI", v.getName());
                o.put("name", v.getName() + (v.isNetworkConnectionRequired() ? " (online)" : ""));
                o.put("lang", v.getLocale().toLanguageTag());
                o.put("localService", !v.isNetworkConnectionRequired());
                o.put("default", false);
                out.put(o);
            }
        } catch (Exception e) { /* engine without voice list */ }
        return out.toString();
    }

    @JavascriptInterface
    public void speak(final int id, final String text, final String lang, final String voice, final float rate, final float pitch, final float volume) {
        main.post(() -> {
            if (!pageIsOurs()) return;
            if (tts == null) { send("__acTts", String.valueOf(id), "'error'", "'synthesis-unavailable'"); return; }
            if (!ttsReady) { waiting.add(new Object[]{id, text, lang, voice, rate, pitch, volume}); return; }
            doSpeak(id, text, lang, voice, rate, pitch, volume);
        });
    }

    private void doSpeak(int id, String text, String lang, String voice, float rate, float pitch, float volume) {
        Voice chosen = null;
        if (voice != null && !voice.isEmpty() && !voice.startsWith("default:")) {
            try { for (Voice v : tts.getVoices()) if (v.getName().equals(voice)) { chosen = v; break; } } catch (Exception e) { /* */ }
        }
        int ok;
        if (chosen != null) ok = tts.setVoice(chosen);
        else {
            Locale loc = Locale.forLanguageTag(lang == null || lang.isEmpty() ? "en-US" : lang);
            ok = tts.setLanguage(loc);
            if (ok < TextToSpeech.LANG_AVAILABLE) ok = tts.setLanguage(new Locale(loc.getLanguage())); // e.g. ar-EG → ar
        }
        if (ok < TextToSpeech.LANG_AVAILABLE && chosen == null) {
            send("__acTts", String.valueOf(id), "'error'", "'language-unavailable'");
            return;
        }
        tts.setSpeechRate(Math.max(0.3f, Math.min(2.5f, rate)));
        tts.setPitch(Math.max(0.5f, Math.min(2f, pitch)));
        Bundle p = new Bundle();
        p.putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, Math.max(0f, Math.min(1f, volume)));
        int r = tts.speak(text == null ? "" : text, TextToSpeech.QUEUE_FLUSH, p, String.valueOf(id));
        if (r != TextToSpeech.SUCCESS) send("__acTts", String.valueOf(id), "'error'", "'synthesis-failed'");
    }

    @JavascriptInterface
    public void stopSpeaking() {
        main.post(() -> { waiting.clear(); if (tts != null && ttsReady) tts.stop(); });
    }

    /** the app went to the background: stop listening (the microphone goes off) */
    void pauseAll() {
        background = true;
        if (recId != 0) { int id = recId; recId = 0; cancelRecognizer(); rec(id, "error", "{error:'aborted'}"); rec(id, "end", "{}"); }
    }

    void resumeAll() { background = false; }

    void shutdown() {
        cancelRecognizer();
        if (tts != null) { try { tts.stop(); tts.shutdown(); } catch (Exception e) { /* */ } tts = null; }
    }
}
