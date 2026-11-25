import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { parsePairLink } from '../core/pairLink';
import { fleet } from '../platform';
import type { ScreenProps } from './nav';
import { C, explain } from './theme';
import { useFleet } from './useFleet';

export function PairScreen({ navigation, route }: ScreenProps<'Pair'>) {
  const { settings } = useFleet();
  const insets = useSafeAreaInsets();
  const [code, setCode] = useState('');
  const [name, setName] = useState(settings.deviceName);
  const [host, setHost] = useState(settings.relayHost);
  const [port, setPort] = useState(String(settings.relayPort));
  const [advanced, setAdvanced] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const handled = useRef(false);

  const pair = async (c: string, h: string, p: string) => {
    if (busy || !c.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await fleet.updateSettings({ deviceName: name, relayHost: h, relayPort: Number.parseInt(p, 10) });
      await fleet.pair(c);
      navigation.goBack();
    } catch (e) {
      setError(explain(e instanceof Error ? e.message : String(e)));
      setBusy(false);
    }
  };
  const submit = () => pair(code, host, port);

  // A link opened from outside the app only fills the form: the person still has to tap Pair, so a
  // link someone sent cannot pair this phone, or change its relay, on its own.
  const link = route.params;
  useEffect(() => {
    if (!link?.code) return;
    const parsed = parsePairLink(`metaide://pair?code=${encodeURIComponent(link.code)}&relay=${encodeURIComponent(link.relay ?? '')}&port=${encodeURIComponent(link.port ?? '')}`);
    if (!parsed) return;
    setCode(parsed.code);
    if (parsed.relayHost) { setHost(parsed.relayHost); setAdvanced(true); }
    if (parsed.relayPort) setPort(String(parsed.relayPort));
  }, [link?.code, link?.relay, link?.port]);

  const startScan = async () => {
    setError(null);
    const granted = permission?.granted || (await requestPermission()).granted;
    if (!granted) { setError('Camera access is off. Allow it in Settings to scan, or type the code.'); return; }
    handled.current = false;
    setScanning(true);
  };

  // Scanning in the app is the person pointing their own camera at their own desktop, so it pairs straight away.
  const onScanned = (data: string) => {
    if (handled.current) return; // the camera reports the same code many times a second
    const parsed = parsePairLink(data);
    if (!parsed) return; // some other QR code in view: keep looking
    handled.current = true;
    setScanning(false);
    const h = parsed.relayHost ?? host;
    const p = parsed.relayPort ? String(parsed.relayPort) : port;
    setCode(parsed.code);
    setHost(h);
    setPort(p);
    void pair(parsed.code, h, p);
  };

  if (scanning) {
    return (
      <View style={styles.scanRoot}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={(r) => onScanned(r.data)}
        />
        <View style={[styles.scanTop, { paddingTop: insets.top + 24 }]} pointerEvents="none">
          <Text style={styles.scanTitle}>Scan the pairing QR code</Text>
          <Text style={styles.scanHelp}>On the desktop: Settings → P2P → Pair a new machine.</Text>
        </View>
        <View style={styles.scanFrame} pointerEvents="none" />
        <Pressable style={[styles.scanCancel, { marginBottom: insets.bottom + 28 }]} onPress={() => setScanning(false)}>
          <Text style={styles.scanCancelText}>Cancel</Text>
        </Pressable>
      </View>
    );
  }

  return (
    <KeyboardAvoidingView style={styles.root} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView contentContainerStyle={[styles.body, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled">
        <Text style={styles.title}>Pair a machine</Text>
        <Text style={styles.help}>
          On the desktop, open Settings → P2P and choose “Pair a new machine”. Scan the QR code it shows, or enter the pair code, while that window is open.
        </Text>

        <Pressable style={({ pressed }) => [styles.scan, busy && styles.disabled, pressed && styles.pressed]} onPress={startScan} disabled={busy}>
          <Text style={styles.scanText}>Scan QR code</Text>
        </Pressable>

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
          autoFocus={!link?.code}
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
  scan: { borderColor: C.accent, borderWidth: 1, borderRadius: 12, alignItems: 'center', paddingVertical: 13, marginTop: 4 },
  scanText: { color: C.accent, fontSize: 16, fontWeight: '600' },
  scanRoot: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'space-between' },
  scanTop: { alignItems: 'center', paddingHorizontal: 24, gap: 6 },
  scanTitle: { color: '#fff', fontSize: 20, fontWeight: '700', textAlign: 'center' },
  scanHelp: { color: '#d0d6dd', fontSize: 14, textAlign: 'center' },
  scanFrame: { width: 240, height: 240, borderRadius: 24, borderWidth: 3, borderColor: 'rgba(255,255,255,0.9)' },
  scanCancel: { backgroundColor: 'rgba(22,27,34,0.9)', borderRadius: 24, paddingHorizontal: 28, paddingVertical: 12 },
  scanCancelText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  cancel: { alignItems: 'center', padding: 14, marginTop: 4 },
  cancelText: { color: C.dim, fontSize: 16 },
});
