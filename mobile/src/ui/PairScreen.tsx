import { useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { fleet } from '../platform';
import type { ScreenProps } from './nav';
import { C, explain } from './theme';
import { useFleet } from './useFleet';

export function PairScreen({ navigation }: ScreenProps<'Pair'>) {
  const { settings } = useFleet();
  const insets = useSafeAreaInsets();
  const [code, setCode] = useState('');
  const [name, setName] = useState(settings.deviceName);
  const [host, setHost] = useState(settings.relayHost);
  const [port, setPort] = useState(String(settings.relayPort));
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await fleet.updateSettings({ deviceName: name, relayHost: host, relayPort: Number.parseInt(port, 10) });
      await fleet.pair(code);
      navigation.goBack();
    } catch (e) {
      setError(explain(e instanceof Error ? e.message : String(e)));
      setBusy(false);
    }
  };

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Pair a machine</Text>
        <Text style={styles.help}>
          On the desktop, open Settings → P2P and choose “Pair a new machine”. Enter the pair code it shows while that window is open.
        </Text>

        <Text style={styles.label}>Pair code</Text>
        <TextInput
          style={[styles.input, styles.code]}
          value={code}
          onChangeText={(t) => { setCode(t); setError(null); }}
          placeholder="Code from the desktop"
          placeholderTextColor={C.faint}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          autoFocus
          returnKeyType="go"
          onSubmitEditing={submit}
          editable={!busy}
        />

        <Text style={styles.label}>This phone’s name</Text>
        <TextInput style={styles.input} value={name} onChangeText={setName} placeholderTextColor={C.faint} maxLength={80} editable={!busy} autoCorrect={false} />

        <Pressable onPress={() => setAdvanced((v) => !v)} style={styles.advanced} hitSlop={8}>
          <Text style={styles.advancedText}>{advanced ? '▾' : '▸'}  Relay</Text>
        </Pressable>
        {advanced ? (
          <View style={styles.row}>
            <TextInput style={[styles.input, styles.host]} value={host} onChangeText={setHost} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="Relay host" placeholderTextColor={C.faint} editable={!busy} />
            <TextInput style={[styles.input, styles.port]} value={port} onChangeText={setPort} keyboardType="number-pad" placeholder="Port" placeholderTextColor={C.faint} maxLength={5} editable={!busy} />
          </View>
        ) : null}

        {error ? <Text style={styles.error}>{error}</Text> : null}

        <Pressable style={({ pressed }) => [styles.button, (!code.trim() || busy) && styles.disabled, pressed && styles.pressed]} onPress={submit} disabled={busy || !code.trim()}>
          {busy ? <ActivityIndicator color="#06101c" /> : <Text style={styles.buttonText}>Pair</Text>}
        </Pressable>
        <Pressable style={styles.cancel} onPress={() => navigation.goBack()} disabled={busy}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  body: { padding: 24, paddingTop: 28 },
  title: { color: C.text, fontSize: 26, fontWeight: '700' },
  help: { color: C.dim, fontSize: 15, lineHeight: 21, marginTop: 10, marginBottom: 12 },
  label: { color: C.dim, fontSize: 13, fontWeight: '600', marginTop: 16, marginBottom: 6 },
  input: { backgroundColor: C.card, borderColor: C.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 12, color: C.text, fontSize: 16, paddingHorizontal: 14, paddingVertical: 12 },
  code: { fontSize: 20, letterSpacing: 1, fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }) },
  advanced: { marginTop: 20, marginBottom: 8 },
  advancedText: { color: C.dim, fontSize: 14 },
  row: { flexDirection: 'row', gap: 10 },
  host: { flex: 1 },
  port: { width: 90 },
  error: { color: C.red, fontSize: 14, lineHeight: 20, marginTop: 16 },
  button: { backgroundColor: C.accent, borderRadius: 12, alignItems: 'center', paddingVertical: 14, marginTop: 24, minHeight: 50, justifyContent: 'center' },
  buttonText: { color: '#06101c', fontSize: 17, fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
  cancel: { alignItems: 'center', padding: 14, marginTop: 4 },
  cancelText: { color: C.dim, fontSize: 16 },
});
