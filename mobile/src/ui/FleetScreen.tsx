import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, useWindowDimensions, View,
  type NativeScrollEvent, type NativeSyntheticEvent,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { activeProjects, type ActiveProject, type Machine } from '../core/fleet';
import { fleet } from '../platform';
import type { ScreenProps } from './nav';
import { AGENT, C, explain, shortPath } from './theme';
import { useFleet } from './useFleet';

const STATUS: Record<Machine['status'], { label: string; color: string }> = {
  online: { label: 'Online', color: C.green },
  connecting: { label: 'Connecting…', color: C.amber },
  offline: { label: 'Offline', color: C.faint },
  revoked: { label: 'Not paired', color: C.red },
};

/** One page per paired machine; swipe left and right to move between them. */
export function FleetScreen({ navigation }: ScreenProps<'Fleet'>) {
  const { ready, machines } = useFleet();
  const { width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [page, setPage] = useState(0);
  const list = useRef<FlatList<Machine>>(null);
  const index = Math.min(page, Math.max(0, machines.length - 1));
  const current = machines[index];

  const onScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(e.nativeEvent.contentOffset.x / width);
    if (next !== page) setPage(next);
  };

  const confirmRemove = (m: Machine) =>
    Alert.alert(`Remove ${m.device.name}?`, 'This phone will forget the machine. To finish, also remove the phone under Settings → P2P on that machine.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void fleet.remove(m.device.id) },
    ]);

  const openProject = useCallback((m: Machine, p: ActiveProject) => {
    navigation.navigate('Terminal', { deviceId: m.device.id, projectId: p.project.id, shellIndex: p.shells[0]!.shellIndex, projectName: p.project.name });
  }, [navigation]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <Pressable style={styles.titleWrap} onLongPress={current ? () => confirmRemove(current) : undefined} accessibilityHint="Long press to remove this machine">
          <Text style={styles.title} numberOfLines={1}>{current ? current.device.name : 'MetaLogix IDE'}</Text>
          {current ? (
            <View style={styles.statusRow}>
              <View style={[styles.dot, { backgroundColor: STATUS[current.status].color }]} />
              <Text style={styles.status}>{STATUS[current.status].label}</Text>
            </View>
          ) : null}
        </Pressable>
        <Pressable style={({ pressed }) => [styles.add, pressed && styles.pressed]} onPress={() => navigation.navigate('Pair')} accessibilityLabel="Pair a machine" hitSlop={8}>
          <Text style={styles.addText}>＋</Text>
        </Pressable>
      </View>

      {machines.length > 1 ? (
        <View style={styles.dots}>
          {machines.map((m, i) => (
            <Pressable key={m.device.id} hitSlop={6} onPress={() => list.current?.scrollToIndex({ index: i, animated: true })}>
              <View style={[styles.pageDot, i === index && styles.pageDotOn]} />
            </Pressable>
          ))}
        </View>
      ) : null}

      {!ready ? (
        <View style={styles.center}><ActivityIndicator color={C.dim} /></View>
      ) : machines.length === 0 ? (
        <View style={styles.center}>
          <Text style={styles.emptyTitle}>No machines yet</Text>
          <Text style={styles.emptyText}>Pair this phone with a desktop running MetaLogix IDE to see its active projects and open their terminals.</Text>
          <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]} onPress={() => navigation.navigate('Pair')}>
            <Text style={styles.buttonText}>Pair a machine</Text>
          </Pressable>
        </View>
      ) : (
        <FlatList
          ref={list}
          data={machines}
          key={width /* re-lay out pages on rotation */}
          keyExtractor={(m) => m.device.id}
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          onScroll={onScroll}
          scrollEventThrottle={32}
          getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
          initialScrollIndex={index}
          renderItem={({ item }) => (
            <MachinePage machine={item} width={width} bottom={insets.bottom} onOpen={openProject} onPair={() => navigation.navigate('Pair')} onRemove={confirmRemove} />
          )}
        />
      )}
    </View>
  );
}

function MachinePage({ machine, width, bottom, onOpen, onPair, onRemove }: {
  machine: Machine; width: number; bottom: number;
  onOpen(m: Machine, p: ActiveProject): void; onPair(): void; onRemove(m: Machine): void;
}) {
  const [refreshing, setRefreshing] = useState(false);
  const projects = activeProjects(machine);
  const refresh = () => {
    setRefreshing(true);
    void fleet.refresh(machine.device.id).finally(() => setRefreshing(false));
  };

  let body;
  if (machine.status === 'revoked') {
    body = (
      <Notice title="Pairing removed" text={explain(machine.error)}>
        <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]} onPress={onPair}><Text style={styles.buttonText}>Pair again</Text></Pressable>
        <Pressable style={styles.link} onPress={() => onRemove(machine)}><Text style={styles.linkText}>Remove machine</Text></Pressable>
      </Notice>
    );
  } else if (machine.status !== 'online' && !machine.loaded) {
    body = machine.status === 'connecting' ? (
      <Notice title="Connecting…" text={`Reaching ${machine.device.name}.`}><ActivityIndicator color={C.dim} /></Notice>
    ) : (
      <Notice title="Offline" text={explain(machine.error) || 'That machine is not reachable right now.'}>
        <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]} onPress={() => fleet.reconnect(machine.device.id)}><Text style={styles.buttonText}>Try again</Text></Pressable>
      </Notice>
    );
  } else if (!machine.loaded) {
    body = <Notice title="Loading projects…" text=""><ActivityIndicator color={C.dim} /></Notice>;
  } else if (machine.status !== 'online') {
    body = (
      <Notice title={machine.status === 'connecting' ? 'Reconnecting…' : 'Offline'} text={machine.status === 'connecting' ? '' : explain(machine.error)}>
        {machine.status === 'connecting' ? <ActivityIndicator color={C.dim} /> : (
          <Pressable style={({ pressed }) => [styles.button, pressed && styles.pressed]} onPress={() => fleet.reconnect(machine.device.id)}><Text style={styles.buttonText}>Try again</Text></Pressable>
        )}
      </Notice>
    );
  } else if (projects.length === 0) {
    body = <Notice title="No active projects" text="Projects appear here while they have a shell running on this machine." />;
  } else {
    body = (
      <>
        <Text style={styles.section}>ACTIVE PROJECTS</Text>
        {projects.map((p) => {
          const agent = p.agentState ? AGENT[p.agentState] : null;
          return (
            <Pressable key={p.project.id} style={({ pressed }) => [styles.card, pressed && styles.cardPressed]} onPress={() => onOpen(machine, p)}>
              <View style={styles.cardMain}>
                <Text style={styles.cardTitle} numberOfLines={1}>{p.project.name}</Text>
                <Text style={styles.cardPath} numberOfLines={1} ellipsizeMode="head">{shortPath(p.project.path)}</Text>
              </View>
              <View style={styles.cardSide}>
                {agent ? (
                  <View style={styles.badge}>
                    <View style={[styles.dot, { backgroundColor: agent.color }]} />
                    <Text style={[styles.badgeText, { color: agent.color }]}>{agent.label}</Text>
                  </View>
                ) : null}
                <Text style={styles.shells}>{p.shells.length === 1 ? '1 shell' : `${p.shells.length} shells`}</Text>
              </View>
              <Text style={styles.chevron}>›</Text>
            </Pressable>
          );
        })}
      </>
    );
  }

  return (
    <ScrollView
      style={{ width }}
      contentContainerStyle={[styles.page, { paddingBottom: bottom + 24 }]}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={C.dim} colors={[C.accent]} progressBackgroundColor={C.card} />}
    >
      {body}
    </ScrollView>
  );
}

function Notice({ title, text, children }: { title: string; text: string; children?: React.ReactNode }) {
  return (
    <View style={styles.notice}>
      <Text style={styles.emptyTitle}>{title}</Text>
      {text ? <Text style={styles.emptyText}>{text}</Text> : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 20, paddingTop: 12, paddingBottom: 8 },
  titleWrap: { flex: 1 },
  title: { color: C.text, fontSize: 28, fontWeight: '700' },
  statusRow: { flexDirection: 'row', alignItems: 'center', marginTop: 4, gap: 6 },
  status: { color: C.dim, fontSize: 13 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  add: { width: 40, height: 40, borderRadius: 20, backgroundColor: C.card, alignItems: 'center', justifyContent: 'center' },
  addText: { color: C.text, fontSize: 20, lineHeight: 24 },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: 8, paddingVertical: 8 },
  pageDot: { width: 7, height: 7, borderRadius: 4, backgroundColor: C.border },
  pageDotOn: { backgroundColor: C.text },
  page: { paddingHorizontal: 16, paddingTop: 8, flexGrow: 1 },
  section: { color: C.faint, fontSize: 12, fontWeight: '600', letterSpacing: 0.6, marginBottom: 8, marginLeft: 4, marginTop: 8 },
  card: { flexDirection: 'row', alignItems: 'center', backgroundColor: C.card, borderRadius: 14, paddingVertical: 14, paddingLeft: 16, paddingRight: 12, marginBottom: 10, borderWidth: StyleSheet.hairlineWidth, borderColor: C.border },
  cardPressed: { backgroundColor: C.cardPressed },
  cardMain: { flex: 1, marginRight: 12 },
  cardTitle: { color: C.text, fontSize: 17, fontWeight: '600' },
  cardPath: { color: C.dim, fontSize: 13, marginTop: 3 },
  cardSide: { alignItems: 'flex-end', gap: 4 },
  badge: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  badgeText: { fontSize: 13, fontWeight: '600' },
  shells: { color: C.faint, fontSize: 12 },
  chevron: { color: C.faint, fontSize: 24, marginLeft: 8, marginTop: -2 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 32, gap: 12 },
  notice: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16, paddingBottom: 80, gap: 12 },
  emptyTitle: { color: C.text, fontSize: 19, fontWeight: '600', textAlign: 'center' },
  emptyText: { color: C.dim, fontSize: 15, lineHeight: 21, textAlign: 'center' },
  button: { backgroundColor: C.accent, borderRadius: 12, paddingHorizontal: 22, paddingVertical: 12, marginTop: 8 },
  buttonText: { color: '#06101c', fontSize: 16, fontWeight: '600' },
  pressed: { opacity: 0.7 },
  link: { padding: 8 },
  linkText: { color: C.dim, fontSize: 14 },
});
