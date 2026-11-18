// Must load first: the crypto libraries need crypto.getRandomValues, which Hermes lacks.
import 'react-native-get-random-values';
import { registerRootComponent } from 'expo';
import App from './App';

registerRootComponent(App);
