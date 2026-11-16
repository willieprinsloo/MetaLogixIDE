import { forwardRef, useImperativeHandle, useRef } from 'react';
import { StyleSheet } from 'react-native';
import { WebView as RNWebView, type WebViewMessageEvent } from 'react-native-webview';
import { C } from './theme';
import { TERMINAL_HTML } from './terminalHtml.generated';

export interface TerminalHandle {
  write(text: string): void;
  reset(): void;
  focus(): void;
  blur(): void;
  key(name: string): void;
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

  useImperativeHandle(ref, () => ({
    write: (text) => enqueue(`__term.write(${JSON.stringify(text)})`),
    reset: () => enqueue('__term.reset()'),
    focus: () => enqueue('__term.focus()'),
    blur: () => enqueue('__term.blur()'),
    key: (name) => enqueue(`__term.key(${JSON.stringify(name)})`),
    setCtrl: (on) => enqueue(`__term.setCtrl(${on ? 'true' : 'false'})`),
    paste: (text) => enqueue(`__term.paste(${JSON.stringify(text)})`),
  }));

  const onMessage = (e: WebViewMessageEvent) => {
    let m: { t?: string; d?: string; cols?: number; rows?: number; on?: boolean };
    try { m = JSON.parse(e.nativeEvent.data) as typeof m; } catch { return; }
    if (m.t === 'in' && typeof m.d === 'string') onInput(m.d);
    else if (m.t === 'size' && m.cols && m.rows) onSize(m.cols, m.rows);
    else if (m.t === 'ctrl') onCtrl(!!m.on);
    else if (m.t === 'ready') { ready.current = true; flush(); }
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
