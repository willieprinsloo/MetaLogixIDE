import { test } from 'vitest';
import { registerDesktopTerminalArtifactCases } from '../../packaging/desktop-terminal-artifact-cases.mjs';

registerDesktopTerminalArtifactCases((name, run) => {
  test(name, ({ onTestFinished }) => run({ after: onTestFinished }));
});
