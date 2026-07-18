import { app, Menu, BrowserWindow } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

export function buildAppMenu(mainWindow: BrowserWindow | null): Menu {
  const isMac = process.platform === 'darwin';

  const appMenu: MenuItemConstructorOptions = {
    label: 'metaIDE',
    submenu: [
      { role: 'about', label: 'About metaIDE' },
      { type: 'separator' },
      {
        label: 'Settings\u2026',
        accelerator: 'CmdOrCtrl+,',
        enabled: false,
      },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide', label: 'Hide metaIDE' },
      { role: 'hideOthers' },
      { role: 'unhide', label: 'Show All' },
      { type: 'separator' },
      { role: 'quit', label: 'Quit metaIDE' },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: 'File',
    submenu: [
      {
        label: 'New Window',
        accelerator: 'CmdOrCtrl+N',
        enabled: false,
      },
      isMac
        ? { role: 'close', label: 'Close Window' }
        : { role: 'quit', label: 'Close Window' },
    ],
  };

  const editMenu: MenuItemConstructorOptions = {
    label: 'Edit',
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      { role: 'selectAll' },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      { role: 'reload', accelerator: 'CmdOrCtrl+R' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = {
    label: 'Window',
    submenu: [
      { role: 'minimize' },
      { role: 'zoom' },
      ...(isMac ? [{ type: 'separator' as const }, { role: 'front' as const }] : []),
    ],
  };

  const helpMenu: MenuItemConstructorOptions = {
    role: 'help',
    submenu: [
      {
        label: 'metaIDE Help',
        enabled: false,
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [appMenu] : []),
    fileMenu,
    editMenu,
    viewMenu,
    windowMenu,
    helpMenu,
  ];

  // Suppress unused variable warning — mainWindow is kept for future IPC use
  void mainWindow;
  void app;

  return Menu.buildFromTemplate(template);
}
