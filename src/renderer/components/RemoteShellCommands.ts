/**
 * The bridge App's ⌘T / ⌘W (Ctrl+T / Ctrl+W) shortcuts use to reach a remote project's shell tabs.
 * App provides the ref; the remote pane's shell view fills it while its Shell tab is showing and
 * clears it when it hides, so the keys act on the remote host instead of the hidden local project.
 */
import { createContext, type MutableRefObject } from 'react';

export interface RemoteShellCommands {
  /** Opens a new terminal tab on the host (its login shell), like ⌘T on a local project. */
  newTab(): void;
  /** Closes the shown remote tab, like ⌘W on a local project. */
  closeActive(): void;
}

export const RemoteShellCommandsContext = createContext<MutableRefObject<RemoteShellCommands | null> | null>(null);
