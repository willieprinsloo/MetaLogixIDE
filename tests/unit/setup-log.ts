/**
 * Sends electron-log's file output to one shared file in the temp directory. Without this,
 * main-process code under test appends to the user's real `~/.config/metaide/logs/main.log`.
 * electron-log rotates the file at its default 1 MB cap, so it never grows without bound.
 */
import log from 'electron-log/main';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const file = join(tmpdir(), 'metaide-unit-tests.log');
log.transports.file.resolvePathFn = () => file;
