import { z } from 'zod';

const projectId = z.number().int().positive();
const relPath = z.string().max(4096);
const project = z.object({ projectId });
const file = project.extend({ relPath: relPath.min(1) });
const ok = z.object({ ok: z.literal(true) });
const change = z.object({
  path: relPath,
  status: z.enum(['M', 'A', 'D', 'R', 'U', '?', '!']),
  origPath: relPath.optional(),
});
const side = z.object({
  text: z.string().nullable(),
  skipped: z.enum(['absent', 'too-large', 'binary', 'unavailable']).optional(),
});
const activity = z.object({
  id: z.string(),
  ts: z.string(),
  agent: z.string(),
  shellIndex: z.number(),
  kind: z.enum(['tool', 'prompt', 'notification', 'turn-end']),
  tool: z.string().optional(),
  target: z.string().optional(),
  ok: z.boolean().optional(),
  text: z.string().optional(),
});
const agentName = z.string().min(1).max(256);
const agentSettings = z.object({
  defaultAgent: agentName.nullable(),
  choices: z.array(agentName),
  hasCustomCommand: z.boolean(),
});

/** Named, project-scoped desktop workspace operations; not a general IPC bridge. */
export const WorkspaceMethods = {
  'workspace.info': { params: project, result: z.object({ activityEnabled: z.boolean() }) },
  'workspace.fileTree': {
    params: project.extend({ relPath: relPath.optional() }),
    result: z.object({ entries: z.array(z.object({ name: z.string(), isDir: z.boolean(), relPath })) }),
  },
  'workspace.fileRead': {
    params: file.extend({ forceText: z.boolean().optional() }),
    result: z.object({ content: z.string(), kind: z.enum(['text', 'binary']), sizeBytes: z.number() }),
  },
  'workspace.fileWrite': {
    params: file.extend({ content: z.string().max(512 * 1024) }),
    result: ok.extend({ sizeBytes: z.number() }),
  },
  'workspace.fileMkdir': { params: file, result: ok },
  'workspace.fileRename': {
    params: project.extend({ from: relPath.min(1), to: relPath.min(1) }), result: ok,
  },
  'workspace.fileDelete': { params: file, result: ok },
  'workspace.diffStatus': {
    params: project,
    result: z.object({
      isRepo: z.boolean(), branch: z.string().nullable(), ahead: z.number(), behind: z.number(),
      staged: z.array(change), unstaged: z.array(change), untracked: z.array(relPath),
      error: z.string().optional(),
    }),
  },
  'workspace.diffSides': {
    params: file.omit({ relPath: true }).extend({
      kind: z.enum(['staged', 'unstaged', 'untracked']),
      path: relPath.min(1), origPath: relPath.min(1).optional(), ifDiffHashNot: z.string().max(64).optional(),
    }),
    result: z.discriminatedUnion('status', [
      z.object({ status: z.literal('ok'), diff: z.string(), diffHash: z.string(), oldSide: side, newSide: side }),
      z.object({ status: z.literal('unchanged') }),
      z.object({ status: z.literal('too-large') }),
    ]),
  },
  'workspace.agentSettings': { params: project, result: agentSettings },
  'workspace.setDefaultAgent': {
    params: project.extend({ defaultAgent: agentName.nullable() }), result: agentSettings,
  },
  'workspace.activity': { params: project, result: z.object({ entries: z.array(activity).max(200) }) },
} as const;
