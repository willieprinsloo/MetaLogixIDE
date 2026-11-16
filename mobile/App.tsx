import { useEffect } from 'react';
import { AppState } from 'react-native';
import { StatusBar } from 'expo-status-bar';
import { DarkTheme, NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { fleet } from './src/platform';
import { FleetScreen } from './src/ui/FleetScreen';
import type { RootStack } from './src/ui/nav';
import { PairScreen } from './src/ui/PairScreen';
import { TerminalScreen } from './src/ui/TerminalScreen';
import { C } from './src/ui/theme';

const Stack = createNativeStackNavigator<RootStack>();
const theme = { ...DarkTheme, colors: { ...DarkTheme.colors, background: C.bg, card: C.bg, text: C.text, border: C.border, primary: C.accent } };

export default function App() {
  useEffect(() => {
    void fleet.init();
    fleet.setActive(AppState.currentState !== 'background');
    // 'inactive' (app switcher, a system sheet) is not a reason to stop: only real backgrounding is.
    const sub = AppState.addEventListener('change', (s) => { if (s !== 'inactive') fleet.setActive(s === 'active'); });
    return () => sub.remove();
  }, []);

  return (
    <SafeAreaProvider>
      <NavigationContainer theme={theme}>
        <Stack.Navigator screenOptions={{ headerStyle: { backgroundColor: C.bg }, headerTintColor: C.text, headerShadowVisible: false, contentStyle: { backgroundColor: C.bg } }}>
          <Stack.Screen name="Fleet" component={FleetScreen} options={{ headerShown: false }} />
          <Stack.Screen name="Pair" component={PairScreen} options={{ headerShown: false, presentation: 'modal' }} />
          <Stack.Screen name="Terminal" component={TerminalScreen} />
        </Stack.Navigator>
      </NavigationContainer>
      <StatusBar style="light" />
    </SafeAreaProvider>
  );
}
