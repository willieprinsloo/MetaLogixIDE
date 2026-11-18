import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useHeaderHeight } from '@react-navigation/elements';
import { tabLabels, type ShellSession } from '../core/fleet';
import { fleet } from '../platform';
import type { ScreenProps } from './nav';
import { ComposeBar } from './ComposeBar';
import type { KeyName } from '../terminal/protocol';
import { TerminalView, type TerminalHandle } from './TerminalView';
import { AGENT, C, explain } from './theme';
import { useMachine } from './useFleet';

/** The key bar: terminal keys, plus two that act on the app itself. */
const KEYS: Array<{ id: KeyName | 'ctrl' | 'dictate'; label: string }> = [
  { id: 'dictate', label: '🎤' },
  { id: 'esc', label: 'esc' },
  { id: 'tab', label: 'tab' },
  { id: 'ctrl', label: 'ctrl' },
  { id: 'up', label: '↑' },
  { id: 'down', label: '↓' },
  { id: 'left', label: '←' },
  { id: 'right', label: '→' },
  { id: 'ctrl-c', label: '^C' },
  { id: 'shift-tab', label: '⇧tab' },
  { id: 'enter', label: '⏎' },
  { id: 'pgup', label: 'pg↑' },
  { id: 'pgdn', label: 'pg↓' },
];

type Ended = { key: string; text: string } | null;

/** A live shell on a paired machine. The host replays the screen on attach, then streams output. */
export function TerminalScreen({ route, navigation }: ScreenProps<'Terminal'>) {
  const { deviceId, projectId, projectName } = route.params;
  const machine = useMachine(deviceId);
  const insets = useSafeAreaInsets();
  const headerHeight = useHeaderHeight();
  const term = useRef<TerminalHandle>(null);
  const session = useRef<ShellSession | null>(null);
  const size = useRef<{ cols: number; rows: number } | null>(null);
  const [shellIndex, setShellIndex] = useState(route.params.shellIndex);
  const [attempt, setAttempt] = useState(0);
  const [ended, setEnded] = useState<Ended>(null);
  const [ctrl, setCtrl] = useState(false);
  const [composing, setComposing] = useState(false);

  const online = machine?.status === 'online';
  const shells = (machine?.shells ?? []).filter((s) => s.projectId === projectId).sort((a, b) => a.shellIndex - b.shellIndex);
  const labels = tabLabels(shells);
  const agentState = shells.find((s) => s.shellIndex === shellIndex)?.agentState ?? null;
  const attachKey = `${shellIndex}:${attempt}`;

  useLayoutEffect(() => {
    navigation.setOptions({ title: projectName, headerBackTitle: machine?.device.name ?? 'Back' });
  }, [navigation, projectName, machine?.device.name]);

  // (Re)attach whenever the shell changes or the machine comes back online.
  useEffect(() => {
    if (!online) return;
    setEnded(null);
    term.current?.reset();
    const s = fleet.openShell(deviceId, projectId, shellIndex, {
      onData: (text) => term.current?.write(text),
      onExit: (code) => setEnded({ key: attachKey, text: code === null || code === 0 ? 'Shell exited.' : `Shell exited with code ${code}.` }),
      onClose: (reason) => {
        if (session.current === s) session.current = null;
        // A lost link shows as the machine going offline; the attach above runs again once it is back.
        if (reason === 'link_lost' || reason === 'offline') return;
        setEnded((cur) => cur ?? { key: attachKey, text: reason.includes('unknown_shell') ? 'This shell is no longer running.' : reason === 'remote_ended' ? 'Shell closed.' : explain(reason) });
      },
    });
    session.current = s;
    if (size.current) s.resize(size.current.cols, size.current.rows);
    return () => {
      if (session.current === s) session.current = null;
      s.close();
    };
    // attachKey covers shellIndex and attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceId, projectId, attachKey, online]);

  // Dictated text goes in as a paste, so a program that asks for bracketed paste gets it as one block.
  const insert = (text: string, enter: boolean) => {
    if (text) term.current?.paste(text);
    if (enter) term.current?.key('enter');
    setComposing(false);
  };

  const press = (id: KeyName | 'ctrl' | 'dictate') => {
    if (id === 'dictate') { term.current?.blur(); setComposing(true); return; }
    if (id === 'ctrl') {
      const next = !ctrl;
      setCtrl(next);
      term.current?.setCtrl(next);
      return;
    }
    term.current?.key(id);
  };

  const overlay = ended && ended.key === attachKey ? ended.text : null;
  const banner = !machine ? 'This machine was removed.' : machine.status === 'revoked' ? explain(machine.error) : !online ? 'Reconnecting…' : null;

  return (
    <KeyboardAvoidingView style={styles.root} behavior="padding" keyboardVerticalOffset={Platform.OS === 'ios' ? headerHeight : 0}>
      {shells.length > 1 || agentState ? (
        <View style={styles.tabs}>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabsInner}>
            {shells.length > 1 ? shells.map((s, i) => {
              const on = s.shellIndex === shellIndex;
              const color = s.agentState ? AGENT[s.agentState].color : C.faint;
              return (
                <Pressable key={s.shellIndex} style={[styles.tab, on && styles.tabOn]} onPress={() => setShellIndex(s.shellIndex)}>
                  <View style={[styles.dot, { backgroundColor: color }]} />
                  <Text style={[styles.tabText, on && styles.tabTextOn]}>{labels[i]}</Text>
                </Pressable>
              );
            }) : null}
          </ScrollView>
          {agentState ? <Text style={[styles.agent, { color: AGENT[agentState].color }]}>{AGENT[agentState].label}</Text> : null}
        </View>
      ) : null}

      <View style={styles.term}>
        <TerminalView
          ref={term}
          onInput={(d) => session.current?.send(d)}
          onSize={(cols, rows) => { size.current = { cols, rows }; session.current?.resize(cols, rows); }}
          onCtrl={setCtrl}
        />
        {banner || overlay ? (
          <View style={styles.overlay} pointerEvents="box-none">
            <View style={styles.overlayCard}>
              <Text style={styles.overlayText}>{banner ?? overlay}</Text>
              {!banner && overlay ? (
                <Pressable style={({ pressed }) => [styles.overlayButton, pressed && styles.pressed]} onPress={() => setAttempt((n) => n + 1)}>
                  <Text style={styles.overlayButtonText}>Reattach</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ) : null}
      </View>

      {composing ? <ComposeBar bottomInset={Math.max(insets.bottom, 6)} disabled={!online} onInsert={insert} onClose={() => setComposing(false)} /> : null}
      <View style={[styles.keys, { paddingBottom: Math.max(insets.bottom, 6) }, composing && styles.hidden]}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" contentContainerStyle={styles.keysInner}>
          {KEYS.map((k) => (
            <Pressable key={k.id} style={({ pressed }) => [styles.key, k.id === 'ctrl' && ctrl && styles.keyOn, pressed && styles.keyPressed]} onPress={() => press(k.id)} accessibilityLabel={k.id === 'dictate' ? 'Dictate' : k.id}>
              <Text style={[styles.keyText, k.id === 'ctrl' && ctrl && styles.keyTextOn]}>{k.label}</Text>
            </Pressable>
          ))}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  tabs: { flexDirection: 'row', alignItems: 'center', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border, paddingRight: 12, minHeight: 40 },
  tabsInner: { paddingHorizontal: 8, paddingVertical: 6, gap: 6 },
  tab: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 8 },
  tabOn: { backgroundColor: C.card },
  tabText: { color: C.dim, fontSize: 13, fontWeight: '500' },
  tabTextOn: { color: C.text },
  agent: { fontSize: 12, fontWeight: '600', marginLeft: 8 },
  dot: { width: 7, height: 7, borderRadius: 4 },
  term: { flex: 1 },
  overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'flex-end', padding: 16 },
  overlayCard: { backgroundColor: C.card, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border, paddingHorizontal: 16, paddingVertical: 12, flexDirection: 'row', alignItems: 'center', gap: 14, maxWidth: '100%' },
  overlayText: { color: C.text, fontSize: 14, flexShrink: 1 },
  overlayButton: { backgroundColor: C.accent, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 7 },
  overlayButtonText: { color: '#06101c', fontSize: 14, fontWeight: '600' },
  keys: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border, backgroundColor: C.bg, paddingTop: 6 },
  keysInner: { paddingHorizontal: 6, gap: 6 },
  key: { minWidth: 44, height: 38, paddingHorizontal: 10, borderRadius: 8, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  keyOn: { backgroundColor: C.accent },
  keyPressed: { backgroundColor: C.cardPressed },
  keyText: { color: C.text, fontSize: 15, fontWeight: '500' },
  keyTextOn: { color: '#06101c' },
  pressed: { opacity: 0.7 },
  hidden: { display: 'none' },
});
