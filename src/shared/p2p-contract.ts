import { z } from 'zod';

/** Shapes for the RPC catalogue in docs/superpowers/specs/2026-10-26-metaide-p2p-design.md §5. */

export const DeviceInfo = z.object({
  name: z.string(),
  platform: z.string(),
  version: z.string(),
  uptime: z.number(),
});

/** Remote view of a project. Loose by design: mirrors the host's local Project row. */
export const Project = z.object({ id: z.number().int().positive(), name: z.string(), path: z.string() }).passthrough();

export const ShellInfo = z
  .object({ projectId: z.number().int().positive(), shellIndex: z.number() })
  .passthrough();

export const Dirent = z.object({
  name: z.string(),
  isDir: z.boolean(),
  size: z.number().optional(),
});

export const RpcMethods = {
  'device.info': { params: z.object({}), result: DeviceInfo },
  'projects.list': { params: z.object({}), result: z.array(Project) },
  'projects.get': { params: z.object({ id: z.number().int().positive() }), result: Project },
  'shells.list': { params: z.object({ projectId: z.number().int().positive() }), result: z.array(ShellInfo) },
  'shells.attach': {
    params: z.object({ projectId: z.number().int().positive(), shellIndex: z.number() }),
    result: z.object({ stream: z.number() }),
  },
  'shells.launch': {
    params: z.object({ projectId: z.number().int().positive(), forceFirst: z.boolean().optional() }),
    result: z.object({ shellIndex: z.number() }),
  },
  'shells.kill': {
    params: z.object({ projectId: z.number().int().positive(), shellIndex: z.number() }),
    result: z.object({ ok: z.literal(true) }),
  },
  'fs.list': {
    params: z.object({ projectId: z.number().int().positive(), path: z.string() }),
    result: z.array(Dirent),
  },
  'fs.read': {
    params: z.object({ projectId: z.number().int().positive(), path: z.string() }),
    result: z.object({ content: z.string(), encoding: z.enum(['utf8']) }),
  },
} as const;

export type RpcMethodName = keyof typeof RpcMethods;
export type Params<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]['params']>;
export type Result<M extends RpcMethodName> = z.infer<(typeof RpcMethods)[M]['result']>;

// z.union (not discriminatedUnion): two 'res' variants share `kind`, split by `ok`.
export const Frame = z.union([
  z.object({ kind: z.literal('req'), id: z.number(), method: z.string(), params: z.any() }),
  z.object({ kind: z.literal('res'), id: z.number(), ok: z.literal(true), result: z.any() }),
  z.object({
    kind: z.literal('res'),
    id: z.number(),
    ok: z.literal(false),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
  z.object({ kind: z.literal('evt'), stream: z.number(), data: z.any() }),
  z.object({
    kind: z.literal('open-stream'),
    id: z.number(),
    stream: z.number(),
    method: z.string(),
    params: z.any(),
  }),
  z.object({ kind: z.literal('close-stream'), stream: z.number() }),
]);
export type Frame = z.infer<typeof Frame>;

export type FleetEntry = { deviceId: string; name: string; online: boolean; lastSeenAt: number | null };
