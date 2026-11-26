interface StandbyParser {
  write(data: string, parsed?: () => void): void;
}

interface StandbyOutput {
  write(data: string, parsed?: () => void): void;
  promote(signal: AbortSignal, enableEffects: () => void): Promise<void>;
}

/** Feed standby history; transfer interactive input only after the last passive write parses. */
export function createXtermStandbyOutput(parser: StandbyParser): StandbyOutput {
  let submitted = 0;
  let promotionStarted = false;
  return {
    write(data, parsed) { submitted++; parser.write(data, parsed); },
    async promote(signal, enableEffects) {
      if (promotionStarted) throw new Error('Xterm standby promotion already attempted');
      promotionStarted = true;
      for (;;) {
        signal.throwIfAborted();
        const cut = submitted;
        // A write callback is ordered after all preceding parse work, unlike onWriteParsed.
        await untilAbort(new Promise<void>(resolve => parser.write('', resolve)), signal);
        signal.throwIfAborted();
        if (submitted === cut) break;
      }
      enableEffects(); // No await between the last cut and installing the active handlers.
    },
  };
}
import { untilAbort } from './terminal-abort';
