import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { C } from './theme';

interface Props {
  bottomInset: number;
  /** True when there is no shell to type into (the buttons that send are disabled). */
  disabled: boolean;
  onInsert(text: string, enter: boolean): void;
  onClose(): void;
}

const join = (a: string, b: string): string => (!a ? b : !b ? a : /\s$/.test(a) ? a + b : `${a} ${b}`);

function errorText(code: string): string {
  switch (code) {
    case 'not-allowed': return 'Microphone or speech recognition access is off. Allow both in Settings.';
    case 'service-not-allowed': return 'Speech recognition is not available on this device.';
    case 'language-not-supported': return 'Speech recognition does not support this device’s language.';
    case 'network': return 'Speech recognition needs a connection right now.';
    case 'audio-capture': return 'Could not use the microphone.';
    default: return 'Dictation stopped.';
  }
}

/**
 * Dictate (or type) text, read it back, then put it in the terminal. Nothing reaches the shell until
 * Insert or Send, so a misheard command can be fixed first. Opens listening.
 */
export function ComposeBar({ bottomInset, disabled, onInsert, onClose }: Props) {
  const [text, setText] = useState('');
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // What was in the box when dictation started, plus the phrases finished since.
  const committed = useRef('');

  useSpeechRecognitionEvent('start', () => setListening(true));
  useSpeechRecognitionEvent('end', () => setListening(false));
  useSpeechRecognitionEvent('result', (e) => {
    const said = e.results[0]?.transcript ?? '';
    if (e.isFinal) {
      committed.current = join(committed.current, said.trim());
      setText(committed.current);
    } else {
      setText(join(committed.current, said.trim()));
    }
  });
  useSpeechRecognitionEvent('error', (e) => {
    setListening(false);
    // Stopping it ourselves, or a pause with nothing said, is not a failure.
    if (e.error !== 'aborted' && e.error !== 'no-speech') setError(errorText(e.error));
  });

  const start = async () => {
    setError(null);
    try {
      if (!ExpoSpeechRecognitionModule.isRecognitionAvailable()) { setError(errorText('service-not-allowed')); return; }
      const perm = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
      if (!perm.granted) { setError(errorText('not-allowed')); return; }
      committed.current = text.trim();
      ExpoSpeechRecognitionModule.start({ interimResults: true, continuous: true, addsPunctuation: true });
    } catch {
      setError(errorText(''));
    }
  };
  const stop = () => { try { ExpoSpeechRecognitionModule.stop(); } catch { /* not running */ } };

  // Open listening; never leave the microphone on after the bar goes away.
  useEffect(() => {
    void start();
    return () => { try { ExpoSpeechRecognitionModule.abort(); } catch { /* not running */ } };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = (enter: boolean) => {
    stop();
    onInsert(text.trim(), enter);
  };
  const empty = !text.trim();

  return (
    <View style={[styles.root, { paddingBottom: bottomInset }]}>
      <TextInput
        style={styles.input}
        value={text}
        onChangeText={(t) => { setText(t); committed.current = t; }}
        // Typing and dictating at once would fight over the text: stop the microphone to edit.
        editable={!listening}
        multiline
        placeholder={listening ? 'Listening…' : 'Tap the microphone and speak, or type'}
        placeholderTextColor={C.faint}
        autoCapitalize="none"
        autoCorrect={false}
        accessibilityLabel="Dictated text"
      />
      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.row}>
        <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]} onPress={() => { stop(); onClose(); }} accessibilityLabel="Close dictation">
          <Text style={styles.buttonText}>✕</Text>
        </Pressable>
        <Pressable
          style={({ pressed }) => [styles.button, styles.mic, listening && styles.micOn, pressed && styles.pressed]}
          onPress={listening ? stop : () => void start()}
          accessibilityLabel={listening ? 'Stop listening' : 'Start listening'}
        >
          <Text style={[styles.buttonText, listening && styles.onText]}>{listening ? '■  Stop' : '🎤  Speak'}</Text>
        </Pressable>
        <View style={styles.spacer} />
        <Pressable style={({ pressed }) => [styles.button, (empty || disabled) && styles.disabled, pressed && styles.pressed]} onPress={() => send(false)} disabled={empty || disabled}>
          <Text style={styles.buttonText}>Insert</Text>
        </Pressable>
        <Pressable style={({ pressed }) => [styles.button, styles.send, (empty || disabled) && styles.disabled, pressed && styles.pressed]} onPress={() => send(true)} disabled={empty || disabled}>
          <Text style={[styles.buttonText, styles.onText]}>Send ⏎</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, backgroundColor: C.bg, paddingTop: 8, paddingHorizontal: 8, gap: 8 },
  input: { backgroundColor: C.card, borderColor: C.border, borderWidth: StyleSheet.hairlineWidth, borderRadius: 10, color: C.text, fontSize: 16, lineHeight: 21, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 10, minHeight: 44, maxHeight: 132 },
  error: { color: C.red, fontSize: 13, paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  spacer: { flex: 1 },
  button: { height: 38, minWidth: 44, paddingHorizontal: 12, borderRadius: 8, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  buttonText: { color: C.text, fontSize: 15, fontWeight: '500' },
  mic: { minWidth: 96 },
  micOn: { backgroundColor: C.red },
  send: { backgroundColor: C.accent },
  onText: { color: '#06101c', fontWeight: '600' },
  disabled: { opacity: 0.4 },
  pressed: { opacity: 0.7 },
});
