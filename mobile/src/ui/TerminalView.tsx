import { forwardRef, useImperativeHandle, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView as RNWebView, type WebViewMessageEvent } from 'react-native-webview';
import type { KeyName, PageMessage, TerminalApi } from '../terminal/protocol';
import { C } from './theme';
import { TERMINAL_HTML } from './terminalHtml.generated';

export interface TerminalHandle {
  write(text: string): void;
  reset(): void;
  focus(): void;
  blur(): void;
  key(name: KeyName): void;
  setCtrl(on: boolean): void;
  paste(text: string): void;
}

interface Props {
  onInput(data: string): void;
  onSize(cols: number, rows: number): void;
  onCtrl(on: boolean): void;
}

// The library's default type argument (`undefined`) collapses its props to `never` under strict TS.
const WebView = RNWebView<object>;
type WebViewRef = RNWebView<object>;

const SOURCE = { html: TERMINAL_HTML, baseUrl: 'about:blank' };

/** xterm.js in a WebView. Output is batched so a busy shell costs one bridge call per frame, not one per chunk. */
export const TerminalView = forwardRef<TerminalHandle, Props>(function TerminalView({ onInput, onSize, onCtrl }, ref) {
  const web = useRef<WebViewRef>(null);
  const ready = useRef(false);
  const queue = useRef<string[]>([]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const run = (js: string) => web.current?.injectJavaScript(`${js};true;`);
  const flush = () => {
    timer.current = null;
    if (!ready.current || queue.current.length === 0) return;
    const calls = queue.current.join(';');
    queue.current = [];
    run(calls);
  };
  // Everything goes through one ordered queue so a reset can never overtake earlier output.
  const enqueue = (call: string) => {
    queue.current.push(call);
    if (ready.current && !timer.current) timer.current = setTimeout(flush, 16);
  };

  /** Queues one call on the page's `window.__term`, checked against the page's API. */
  const call = <K extends keyof TerminalApi>(method: K, ...args: Parameters<TerminalApi[K]>) =>
    enqueue(`__term.${method}(${args.map((a) => JSON.stringify(a)).join(',')})`);

  useImperativeHandle(ref, () => ({
    write: (text) => call('write', text),
    reset: () => call('reset'),
    focus: () => call('focus'),
    blur: () => call('blur'),
    key: (name) => call('key', name),
    setCtrl: (on) => call('setCtrl', on),
    paste: (text) => call('paste', text),
  }));

  const onMessage = (e: WebViewMessageEvent) => {
    // The page is our own bundle (see src/terminal/bridge.ts), so its messages follow the protocol.
    let m: PageMessage;
    try { m = JSON.parse(e.nativeEvent.data) as PageMessage; } catch { return; }
    switch (m.t) {
      case 'in': onInput(m.d); break;
      case 'size': onSize(m.cols, m.rows); break;
      case 'ctrl': onCtrl(m.on); break;
      case 'ready': ready.current = true; flush(); break;
    }
  };

  return (
    <WebView
      ref={web}
      source={SOURCE}
      originWhitelist={['*']}
      onMessage={onMessage}
      onLoadStart={() => { ready.current = false; }}
      style={styles.web}
      containerStyle={styles.web}
      scrollEnabled={false}
      bounces={false}
      overScrollMode="never"
      hideKeyboardAccessoryView
      keyboardDisplayRequiresUserAction={false}
      automaticallyAdjustContentInsets={false}
      contentInsetAdjustmentBehavior="never"
      textZoom={100}
      setBuiltInZoomControls={false}
      showsVerticalScrollIndicator={false}
      showsHorizontalScrollIndicator={false}
      webviewDebuggingEnabled={__DEV__}
    />
  );
});

const styles = StyleSheet.create({ web: { flex: 1, backgroundColor: C.bg } });
