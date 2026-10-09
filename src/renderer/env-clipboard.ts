/** Copies env values to the clipboard and reports the outcome without ever echoing the value or name. */
import { toast } from '@renderer/hooks/useToasts';
import { ENV_COPY } from '@renderer/project-env-copy';

export interface ClipboardWriter {
  writeText(text: string): Promise<void>;
}

export type CopyNotify = (kind: 'success' | 'error', title: string) => void;

/** Writes the raw value; notifies ENV_COPY.copied or ENV_COPY.copyFailed (never the value or name). Resolves true on success. */
export async function copyEnvValue(
  value: string,
  clipboard: ClipboardWriter,
  notify: CopyNotify,
): Promise<boolean> {
  try {
    await clipboard.writeText(value);
    notify('success', ENV_COPY.copied);
    return true;
  } catch {
    notify('error', ENV_COPY.copyFailed);
    return false;
  }
}

/** copyEnvValue bound to navigator.clipboard and the toast bus — what components call. */
export function copyEnvValueToClipboard(value: string): Promise<boolean> {
  return copyEnvValue(value, navigator.clipboard, (kind, title) => {
    toast(title, { kind });
  });
}
