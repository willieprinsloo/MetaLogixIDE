import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@main': resolve(__dirname, 'src/main'),
      '@shared': resolve(__dirname, 'src/shared'),
      '@renderer': resolve(__dirname, 'src/renderer'),
    },
  },
  test: {
    environment: 'node',
    // Cap the worker pool: the default uses every core, in every session sharing this machine.
    // minWorkers must be set too, or its core-count default conflicts with the cap.
    maxWorkers: 4,
    minWorkers: 1,
    // .claude/ holds mutation-test copies of the tree; dist/ and out/ hold
    // packaged builds whose bundled node_modules ship their own tests.
    exclude: ['tests/e2e/**', 'node_modules/**', '.claude/**', 'dist/**', 'out/**'],
    coverage: {
      provider: 'v8',
      all: true,
      reporter: ['json', 'text-summary'],
      reportsDirectory: '.claude/reports/command-palette-coverage',
      include: [
        'src/renderer/command-palette-contract.ts',
        'src/renderer/modal-glass.ts',
        'src/renderer/palette-*.ts',
        'src/renderer/hooks/usePaletteFiles.ts',
        'src/renderer/components/CommandPalette.tsx',
        'src/renderer/components/ModalFrame.tsx',
        'src/renderer/components/ShortcutsHelp.tsx',
        'src/renderer/components/StatusBar.tsx',
        'src/renderer/components/palette/**',
        'src/renderer/components/Settings.tsx',
        'src/renderer/components/PermissionModeDialog.tsx',
        'src/renderer/components/NewProjectDialog.tsx',
        'src/renderer/components/ProjectSearch.tsx',
        'src/renderer/components/PromptLibrary.tsx',
        'src/renderer/components/ScrollbackSearch.tsx',
        'src/renderer/components/ToastStack.tsx',
        'src/renderer/shortcut-*.ts',
        'src/renderer/app-keys.ts',
        'src/renderer/terminal-keys.ts',
        'src/shared/terminal-drop-contract.ts',
        'src/shared/paste-sanitize.ts',
        'src/shared/shell-escape.ts',
        'src/renderer/terminal-drop.ts',
        'src/renderer/clipboard-paste.ts',
        'src/renderer/drag-hover.ts',
        'src/renderer/terminal-drop-controller.ts',
        'src/main/drops/**',
        'src/renderer/hooks/useTerminalDrop.ts',
        'src/renderer/hooks/useTerminalPaste.ts',
        'src/renderer/hooks/useExternalDragGuard.ts',
        'src/renderer/components/permission-mode-keys.ts',
        'src/renderer/sidebar-add-menu.ts',
        'src/renderer/fonts/font-contract.ts',
        'src/main/menu-template.ts',
        'src/renderer/components/ShellTabsBar.tsx',
        'src/renderer/components/ActivityBar.tsx',
        'src/renderer/components/settings/TerminalFontSizeControl.tsx',
        'src/renderer/App.tsx',
      ],
    },
  },
});
