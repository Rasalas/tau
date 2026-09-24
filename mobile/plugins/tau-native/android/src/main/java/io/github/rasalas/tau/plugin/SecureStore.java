package io.github.rasalas.tau.plugin;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.Arrays;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Host tokens and the host list, encrypted with an AES key that lives in the
 * Android Keystore and never leaves it. The ciphertext sits in the app's
 * private preferences, which are left out of backups (the key would not come along).
 */
final class SecureStore {

    private static final String KEY_ALIAS = "tau-secure-store";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";
    private static final int IV_BYTES = 12;

    private final SharedPreferences preferences;

    SecureStore(Context context) {
        preferences = context.getSharedPreferences("tau-secure-store", Context.MODE_PRIVATE);
    }

    private static SecretKey key() throws Exception {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        KeyStore.Entry entry = keyStore.getEntry(KEY_ALIAS, null);
        if (entry instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) entry).getSecretKey();
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        generator.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return generator.generateKey();
    }

    String get(String name) throws Exception {
        String stored = preferences.getString(name, null);
        if (stored == null) return null;
        byte[] bytes = Base64.decode(stored, Base64.NO_WRAP);
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Arrays.copyOfRange(bytes, 0, IV_BYTES)));
            return new String(cipher.doFinal(bytes, IV_BYTES, bytes.length - IV_BYTES), StandardCharsets.UTF_8);
        } catch (javax.crypto.AEADBadTagException | java.security.InvalidKeyException unreadable) {
            // Written under a key this install does not have: gone, not an error to show.
            preferences.edit().remove(name).commit();
            return null;
        }
    }

    void set(String name, String value) throws Exception {
        Cipher cipher = Cipher.getInstance(TRANSFORMATION);
        cipher.init(Cipher.ENCRYPT_MODE, key());
        byte[] iv = cipher.getIV();
        byte[] sealed = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        byte[] joined = new byte[iv.length + sealed.length];
        System.arraycopy(iv, 0, joined, 0, iv.length);
        System.arraycopy(sealed, 0, joined, iv.length, sealed.length);
        if (!preferences.edit().putString(name, Base64.encodeToString(joined, Base64.NO_WRAP)).commit()) {
            throw new IllegalStateException("The secure store could not be written.");
        }
    }

    void remove(String name) {
        preferences.edit().remove(name).commit();
    }
}
