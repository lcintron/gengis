package com.luiscintron.gengis;

/* GenGIS Android app - signing in to OneDrive and Google Drive for cloud sync (js/cloudsync.js, through js/native.js).
 * The Android counterpart of the desktop app's electron/cloudauth.js, with the same calls (signIn, token, signOut):
 * - OneDrive: authorization code with PKCE in a browser tab (Custom Tab: the user's own browser, its password manager
 *   and work-account policies), back to the app by the redirect com.luiscintron.gengis://oauth (the Entra
 *   registration's "Mobile and desktop applications" platform), the state checked. The refresh token stays here,
 *   encrypted with a key in Android's keystore that never leaves it; where that fails it is kept in memory only.
 * - Google Drive: Android's own Google sign-in (Google Identity Services' authorization API: an "Android" OAuth client
 *   in the web app's Google Cloud project, matched by this package and its signing key). Google keeps the sign-in;
 *   only the account is noted here, to ask again for it without a prompt.
 * The page only ever receives short-lived access tokens. Added to the generated project by scripts/android-prepare.js. */

import android.accounts.Account;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.IntentSender;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.browser.customtabs.CustomTabsIntent;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.api.identity.AuthorizationRequest;
import com.google.android.gms.auth.api.identity.AuthorizationResult;
import com.google.android.gms.auth.api.identity.ClearTokenRequest;
import com.google.android.gms.auth.api.identity.Identity;
import com.google.android.gms.auth.api.identity.RevokeAccessRequest;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.CommonStatusCodes;
import com.google.android.gms.common.api.Scope;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

@CapacitorPlugin(name = "GenGISCloud")
public class CloudPlugin extends Plugin {
    private static final String SCHEME = "com.luiscintron.gengis";
    private static final String REDIRECT = SCHEME + "://oauth";
    // Microsoft: GenGIS's one Entra registration (the web and desktop apps' too: one Apps/GenGIS folder)
    private static final String MS_CLIENT = "7beaabe0-cfb2-406e-b687-7eace44b2edb";
    private static final String MS_AUTHORIZE = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
    private static final String MS_TOKEN = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
    private static final String MS_SCOPES = "openid profile email offline_access Files.ReadWrite.AppFolder";
    private static final String PERSONAL_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";
    // Google: drive.file (only the files GenGIS made), and who signed in
    private static final List<Scope> G_SCOPES = Arrays.asList(new Scope("openid"), new Scope("email"), new Scope("profile"),
        new Scope("https://www.googleapis.com/auth/drive.file"));
    private static final String USERINFO = "https://www.googleapis.com/oauth2/v3/userinfo"; // (js/cloud-gdrive.js's)
    private static final int G_LIFETIME = 3000; // s: a token asked for again is a fresh one (the one handed out before is cleared)
    private static final String KEY_ALIAS = "gengis-cloud";
    private static final String PREFS = "gengis-cloud";

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());
    private final SecureRandom random = new SecureRandom();
    private final Map<String, JSONObject> memory = new HashMap<>(); // accountId -> record, where the keystore failed
    private final Map<String, String> handedOut = new HashMap<>();  // accountId -> the last Google access token given

    // the Microsoft sign-in under way (one at a time: a new one replaces it; given up after 5 minutes, as the desktop
    // app's); main thread only. (A tab closed without an answer is not taken for a cancel: the sign-in may go on in
    // the browser it was opened in, and a new tap replaces it.)
    private static final long SIGN_IN_TIMEOUT = 5 * 60 * 1000;
    private PluginCall msCall;
    private String msState, msVerifier;
    // the Google sign-in under way, and the screen it shows (each launch its own key: a replaced one's answer is not
    // taken for the next one's)
    private PluginCall gCall;
    private ActivityResultLauncher<IntentSenderRequest> gLauncher;
    private int gLaunches;

    private interface Done { void ok(AuthorizationResult r); void no(String code, String message); }

    private static class TokenError extends Exception {
        final String code;
        TokenError(String code, String message) { super(message); this.code = code; }
    }

    /* ---------- the page's calls ---------- */

    @PluginMethod
    public void signIn(PluginCall call) {
        String provider = call.getString("provider", ""), hint = call.getString("hint", "");
        if ("onedrive".equals(provider)) main.post(() -> msSignIn(call, hint));
        else if ("gdrive".equals(provider)) main.post(() -> googleSignIn(call, hint));
        else fail(call, "bad_request", "Unknown provider");
    }

    // A fresh access token for an account signed in here.
    @PluginMethod
    public void token(PluginCall call) {
        String id = call.getString("accountId", "");
        JSONObject rec = load(id);
        if (rec == null) { fail(call, "signin", "Sign in again"); return; }
        if ("gdrive".equals(rec.optString("provider"))) { main.post(() -> googleToken(call, id, rec.optString("email"))); return; }
        io.execute(() -> {
            String refresh = rec.has("plain") ? rec.optString("plain") : decrypt(rec.optString("refresh"));
            if (refresh == null || refresh.isEmpty()) { fail(call, "signin", "Sign in again"); return; }
            try {
                JSONObject tok = post(MS_TOKEN, form("client_id", MS_CLIENT, "grant_type", "refresh_token", "refresh_token", refresh, "scope", MS_SCOPES));
                String next = tok.optString("refresh_token", "");
                if (!next.isEmpty() && !next.equals(refresh)) save(id, "onedrive", next, "");
                call.resolve(access(tok.optString("access_token"), tok.optInt("expires_in", 3600)));
            } catch (TokenError e) {
                fail(call, "network".equals(e.code) || "server".equals(e.code) ? e.code : "signin", e.getMessage());
            }
        });
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        String id = call.getString("accountId", "");
        JSONObject rec = load(id);
        forget(id);
        if (rec != null && "gdrive".equals(rec.optString("provider")) && !rec.optString("email").isEmpty()) {
            String email = rec.optString("email");
            main.post(() -> {
                handedOut.remove(id);
                try {
                    Identity.getAuthorizationClient(getActivity()).revokeAccess(RevokeAccessRequest.builder()
                        .setAccount(new Account(email, "com.google")).setScopes(G_SCOPES).build());
                } catch (Exception e) { /* forgotten here either way */ }
            });
        }
        JSObject o = new JSObject();
        o.put("ok", true);
        call.resolve(o);
    }

    /* ---------- OneDrive: a browser tab and back ---------- */

    private void msSignIn(PluginCall call, String hint) {
        if (msCall != null) fail(msCall, "superseded", "Replaced by a new sign-in");
        msCall = call;
        msVerifier = b64url(bytes(48));
        msState = b64url(bytes(24));
        main.postDelayed(() -> { if (msCall == call) { msCall = null; fail(call, "timeout", "The sign-in took too long"); } }, SIGN_IN_TIMEOUT);
        String challenge;
        try { challenge = b64url(MessageDigest.getInstance("SHA-256").digest(msVerifier.getBytes(StandardCharsets.US_ASCII))); }
        catch (Exception e) { msCall = null; fail(call, "failed", e.getMessage()); return; }
        Uri.Builder u = Uri.parse(MS_AUTHORIZE).buildUpon()
            .appendQueryParameter("client_id", MS_CLIENT)
            .appendQueryParameter("response_type", "code")
            .appendQueryParameter("redirect_uri", REDIRECT)
            .appendQueryParameter("scope", MS_SCOPES)
            .appendQueryParameter("state", msState)
            .appendQueryParameter("code_challenge", challenge)
            .appendQueryParameter("code_challenge_method", "S256")
            .appendQueryParameter("prompt", "select_account");
        if (!hint.isEmpty()) u.appendQueryParameter("login_hint", hint);
        try { new CustomTabsIntent.Builder().build().launchUrl(getActivity(), u.build()); }
        catch (Exception e) { msCall = null; fail(call, "failed", "No browser to sign in with"); }
    }

    // The browser tab coming back to the app (MainActivity is singleTask: the tab above it closes).
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        Uri u = intent == null ? null : intent.getData();
        if (u == null || !SCHEME.equals(u.getScheme()) || !"oauth".equals(u.getHost())) return;
        if (msCall == null || msState == null || !msState.equals(u.getQueryParameter("state"))) return; // not the answer: ignored
        PluginCall call = msCall;
        String verifier = msVerifier;
        msCall = null;
        String err = u.getQueryParameter("error");
        if (err != null) { fail(call, err, u.getQueryParameter("error_description")); return; }
        String code = u.getQueryParameter("code");
        if (code == null) { fail(call, "failed", "The sign-in did not come back with a code"); return; }
        io.execute(() -> msFinish(call, code, verifier));
    }

    private void msFinish(PluginCall call, String code, String verifier) {
        try {
            JSONObject tok = post(MS_TOKEN, form("client_id", MS_CLIENT, "grant_type", "authorization_code", "code", code,
                "redirect_uri", REDIRECT, "code_verifier", verifier, "scope", MS_SCOPES));
            JSONObject c = claims(tok.optString("id_token"));
            String tid = c.optString("tid");
            JSObject account = new JSObject();
            account.put("id", "onedrive:" + c.optString("oid", c.optString("sub")) + "@" + tid);
            account.put("provider", "onedrive");
            account.put("name", c.optString("name"));
            account.put("email", c.optString("preferred_username", c.optString("email")));
            account.put("kind", PERSONAL_TENANT.equals(tid) ? "personal" : "work");
            String refresh = tok.optString("refresh_token", "");
            boolean kept = !refresh.isEmpty() && save(account.getString("id"), "onedrive", refresh, "");
            JSObject o = access(tok.optString("access_token"), tok.optInt("expires_in", 3600));
            o.put("account", account);
            o.put("kept", kept);
            call.resolve(o);
        } catch (TokenError e) {
            fail(call, e.code, e.getMessage());
        }
    }

    /* ---------- Google Drive: Android's own sign-in ---------- */

    private void googleSignIn(PluginCall call, String hint) {
        if (gCall != null) fail(gCall, "superseded", "Replaced by a new sign-in");
        gCall = call;
        authorize(hint, true, new Done() {
            public void ok(AuthorizationResult r) {
                if (gCall != call) return;
                gCall = null;
                String token = r.getAccessToken();
                if (token == null) { fail(call, "failed", "Google gave no access"); return; }
                // who signed in: Google's userinfo, as the web app reads it (the same account id everywhere: gdrive:<sub>)
                io.execute(() -> {
                    JSONObject u;
                    try { u = request("GET", USERINFO, null, token); }
                    catch (TokenError e) { fail(call, e.code, e.getMessage()); return; }
                    String sub = u.optString("sub"), email = u.optString("email");
                    if (sub.isEmpty()) { fail(call, "failed", "Google did not say which account signed in"); return; }
                    JSObject account = new JSObject();
                    account.put("id", "gdrive:" + sub);
                    account.put("provider", "gdrive");
                    account.put("name", u.optString("name"));
                    account.put("email", email);
                    account.put("kind", u.optString("hd").isEmpty() ? "personal" : "work");
                    save("gdrive:" + sub, "gdrive", "", email);
                    main.post(() -> {
                        handedOut.put("gdrive:" + sub, token);
                        JSObject o = access(token, G_LIFETIME);
                        o.put("account", account);
                        o.put("kept", true);
                        call.resolve(o);
                    });
                });
            }
            public void no(String code, String message) {
                if (gCall != call) return;
                gCall = null;
                fail(call, code, message);
            }
        });
    }

    // A new access token for an account, without a prompt: the one handed out before is cleared first, so that Google
    // gives a fresh one (not a cached token that is about to run out, or that was refused).
    private void googleToken(PluginCall call, String id, String email) {
        Runnable ask = () -> authorize(email, false, new Done() {
            public void ok(AuthorizationResult r) {
                if (r.getAccessToken() == null) { fail(call, "signin", "Sign in again"); return; }
                handedOut.put(id, r.getAccessToken());
                call.resolve(access(r.getAccessToken(), G_LIFETIME));
            }
            public void no(String code, String message) { fail(call, "network".equals(code) ? code : "signin", message); }
        });
        String last = handedOut.remove(id);
        if (last == null) { ask.run(); return; }
        try {
            Identity.getAuthorizationClient(getActivity()).clearToken(ClearTokenRequest.builder().setToken(last).build())
                .addOnCompleteListener(t -> ask.run());
        } catch (Exception e) { ask.run(); }
    }

    private void authorize(String email, boolean interactive, Done done) {
        AuthorizationRequest.Builder b = AuthorizationRequest.builder().setRequestedScopes(G_SCOPES);
        if (email != null && !email.isEmpty()) b.setAccount(new Account(email, "com.google"));
        try {
            Identity.getAuthorizationClient(getActivity()).authorize(b.build())
                .addOnSuccessListener(r -> {
                    if (!r.hasResolution()) { done.ok(r); return; }
                    if (!interactive || r.getPendingIntent() == null) { done.no("signin", "Sign in to Google Drive again"); return; }
                    prompt(r.getPendingIntent().getIntentSender(), done);
                })
                .addOnFailureListener(e -> done.no(codeOf(e), e.getMessage()));
        } catch (Exception e) {
            done.no("failed", e.getMessage());
        }
    }

    // Google's own screens (the account picker, the consent), and their answer.
    private void prompt(IntentSender sender, Done done) {
        Activity activity = getActivity();
        if (gLauncher != null) gLauncher.unregister();
        gLauncher = getActivity().getActivityResultRegistry().register("gengis-google-signin-" + (++gLaunches),
            new ActivityResultContracts.StartIntentSenderForResult(), res -> {
                if (gLauncher != null) { gLauncher.unregister(); gLauncher = null; }
                if (res.getResultCode() != Activity.RESULT_OK) { done.no("cancelled", "The sign-in was closed"); return; }
                try { done.ok(Identity.getAuthorizationClient(activity).getAuthorizationResultFromIntent(res.getData())); }
                catch (ApiException e) { done.no(codeOf(e), e.getMessage()); }
            });
        gLauncher.launch(new IntentSenderRequest.Builder(sender).build());
    }

    private static String codeOf(Exception e) {
        if (e instanceof ApiException) {
            int s = ((ApiException) e).getStatusCode();
            if (s == CommonStatusCodes.NETWORK_ERROR) return "network";
            if (s == CommonStatusCodes.CANCELED) return "cancelled";
        }
        return "failed";
    }

    /* ---------- the sign-ins kept: encrypted with a key in Android's keystore ---------- */

    private SharedPreferences prefs() { return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE); }

    // (synchronized: the token calls run on the io thread, the sign-ins on the main thread)
    private synchronized boolean save(String id, String provider, String refresh, String email) {
        JSONObject rec = new JSONObject();
        try {
            rec.put("provider", provider);
            rec.put("email", email);
            if (!refresh.isEmpty()) rec.put("refresh", encrypt(refresh));
            prefs().edit().putString(id, rec.toString()).apply();
            memory.remove(id);
            return true;
        } catch (Exception e) {
            try { rec.put("plain", refresh); } catch (JSONException x) { /* not reached */ }
            memory.put(id, rec);
            prefs().edit().remove(id).apply();
            return false;
        }
    }

    private synchronized JSONObject load(String id) {
        if (id == null || id.isEmpty()) return null;
        if (memory.containsKey(id)) return memory.get(id);
        String s = prefs().getString(id, null);
        if (s == null) return null;
        try { return new JSONObject(s); } catch (JSONException e) { return null; }
    }

    private synchronized void forget(String id) {
        memory.remove(id);
        prefs().edit().remove(id).apply();
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build());
        return g.generateKey();
    }

    private static String encrypt(String s) throws Exception {
        Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
        c.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = c.getIV(), ct = c.doFinal(s.getBytes(StandardCharsets.UTF_8));
        byte[] out = new byte[1 + iv.length + ct.length];
        out[0] = (byte) iv.length;
        System.arraycopy(iv, 0, out, 1, iv.length);
        System.arraycopy(ct, 0, out, 1 + iv.length, ct.length);
        return Base64.encodeToString(out, Base64.NO_WRAP);
    }

    // (null when it cannot be read: a backup restored on another device, a key gone; the account signs in again)
    private static String decrypt(String b) {
        try {
            byte[] all = Base64.decode(b, Base64.NO_WRAP);
            int n = all[0];
            Cipher c = Cipher.getInstance("AES/GCM/NoPadding");
            c.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, all, 1, n));
            return new String(c.doFinal(all, 1 + n, all.length - 1 - n), StandardCharsets.UTF_8);
        } catch (Exception e) {
            return null;
        }
    }

    /* ---------- the token endpoint (and Google's userinfo) ---------- */

    // A token answer: one without an access token is an error too.
    private static JSONObject post(String url, String body) throws TokenError {
        JSONObject json = request("POST", url, body, null);
        if (!json.has("access_token")) throw new TokenError("failed", "No access token in the answer");
        return json;
    }

    // A JSON answer (a form body, or a bearer token); an HTTP error is a TokenError with the server's own code.
    private static JSONObject request(String method, String url, String body, String bearer) throws TokenError {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(url).openConnection();
            c.setRequestMethod(method);
            c.setConnectTimeout(20000);
            c.setReadTimeout(30000);
            c.setRequestProperty("Accept", "application/json");
            if (bearer != null) c.setRequestProperty("Authorization", "Bearer " + bearer);
            if (body != null) {
                c.setDoOutput(true);
                c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                try (OutputStream os = c.getOutputStream()) { os.write(body.getBytes(StandardCharsets.UTF_8)); }
            }
            int status = c.getResponseCode();
            String text = read(status < 400 ? c.getInputStream() : c.getErrorStream());
            JSONObject json;
            try { json = new JSONObject(text); } catch (JSONException e) { json = new JSONObject(); }
            if (status >= 200 && status < 300) return json;
            throw new TokenError(json.optString("error", status >= 500 ? "server" : "http_" + status), json.optString("error_description", "HTTP " + status));
        } catch (IOException e) {
            throw new TokenError("network", "offline");
        } finally {
            if (c != null) c.disconnect();
        }
    }

    private static String read(InputStream in) throws IOException {
        if (in == null) return "";
        try (InputStream s = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            for (int n; (n = s.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toString("UTF-8");
        }
    }

    private static String form(String... kv) {
        StringBuilder b = new StringBuilder();
        try {
            for (int i = 0; i + 1 < kv.length; i += 2) {
                if (b.length() > 0) b.append('&');
                b.append(URLEncoder.encode(kv[i], "UTF-8")).append('=').append(URLEncoder.encode(kv[i + 1], "UTF-8"));
            }
        } catch (IOException e) { /* UTF-8 is always there */ }
        return b.toString();
    }

    private static JSONObject claims(String idToken) {
        try {
            String[] parts = idToken.split("\\.");
            return new JSONObject(new String(Base64.decode(parts[1], Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return new JSONObject();
        }
    }

    /* ---------- small things ---------- */

    private byte[] bytes(int n) { byte[] b = new byte[n]; random.nextBytes(b); return b; }

    private static String b64url(byte[] b) { return Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP); }

    private static JSObject access(String token, int expiresIn) {
        JSObject o = new JSObject();
        o.put("accessToken", token);
        o.put("expiresIn", expiresIn);
        return o;
    }

    private static void fail(PluginCall call, String code, String message) {
        JSObject o = new JSObject();
        o.put("error", code == null ? "failed" : code);
        o.put("message", message == null ? "" : message);
        call.resolve(o);
    }
}
