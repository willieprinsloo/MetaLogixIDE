import { app, Menu, BrowserWindow } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

export function buildAppMenu(mainWindow: BrowserWindow | null): Menu {
  const isMac = process.platform === 'darwin';

  const appMenu: MenuItemConstructorOptions = {
    label: 'MetaLogix IDE',
    submenu: [
      { role: 'about', label: 'About MetaLogix IDE' },
      { type: 'separator' },
      {
        label: 'Settings\u2026',
        accelerator: 'CmdOrCtrl+,',
        enabled: false,
      },
      { type: 'separator' },
      { role: 'services' },
      { type: 'separator' },
      { role: 'hide', label: 'Hide MetaLogix IDE' },
      { role: 'hideOthers' },
      { role: 'unhide', label: 'Show All' },
      { type: 'separator' },
      { role: 'quit', label: 'Quit MetaLogix IDE' },
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
        label: 'MetaLogix IDE Help',
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
