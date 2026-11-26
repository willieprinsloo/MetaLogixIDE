import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStack = {
  Fleet: undefined;
  /** Set by a `metaide://pair?…` link opened from outside the app: fills the form, never pairs by itself. */
  Pair: { code?: string; relay?: string; port?: string } | undefined;
  Terminal: { deviceId: string; projectId: number; shellIndex: number; projectName: string };
};
export type ScreenProps<K extends keyof RootStack> = NativeStackScreenProps<RootStack, K>;
