import type { NativeStackScreenProps } from '@react-navigation/native-stack';

export type RootStack = {
  Fleet: undefined;
  Pair: undefined;
  Terminal: { deviceId: string; projectId: number; shellIndex: number; projectName: string };
};
export type ScreenProps<K extends keyof RootStack> = NativeStackScreenProps<RootStack, K>;
