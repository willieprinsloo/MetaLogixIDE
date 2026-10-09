import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { LazyMotion, MotionConfig, domAnimation } from 'motion/react';
import { App } from './App';
import { FontSettingsProvider } from './fonts/font-settings-context';
import { TerminalFontSizeProvider } from './fonts/terminal-font-size-context';
import { TerminalFontWeightProvider } from './fonts/terminal-font-weight-context';
import './styles.css';
import 'katex/dist/katex.min.css';

const rootElement = document.getElementById('root');
if (rootElement === null) throw new Error('renderer root element is missing');

createRoot(rootElement).render(
  <StrictMode>
    <MotionConfig reducedMotion="user">
      <LazyMotion features={domAnimation} strict>
        <FontSettingsProvider>
          <TerminalFontSizeProvider>
            <TerminalFontWeightProvider>
              <App />
            </TerminalFontWeightProvider>
          </TerminalFontSizeProvider>
        </FontSettingsProvider>
      </LazyMotion>
    </MotionConfig>
  </StrictMode>,
);
