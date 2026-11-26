/** Owns active assignment mutations for the authorized requesting frame. */
import type { MetaprojectResult } from '@shared/metaproject-contract';
import { failure, ok } from './session-service';

type Operation = { readonly operationId: string };
type Scope = { readonly frame: object; contextCurrent(): boolean };

/** Bounds active work and fences canceled requests even while their remote calls settle. */
export class AssignmentOperations {
  private readonly active = new Map<string, { frame: object; canceled: boolean }>();
  private readonly recent = new Set<string>();

  /** Subscribe before starting work and release on all exits, including exceptions. */
  async run<T>(input: Operation, scope: Scope, execute: (owns: () => boolean) => MetaprojectResult<T> | Promise<MetaprojectResult<T>>): Promise<MetaprojectResult<T>> {
    const id = input.operationId.toLowerCase();
    if (!scope.contextCurrent() || this.active.has(id) || this.recent.has(id)) return failure('stale');
    if (this.active.size >= 32) return failure('conflict');
    const entry = { frame: scope.frame, canceled: false };
    this.active.set(id, entry);
    try { return await execute(() => !entry.canceled && scope.contextCurrent()); }
    finally { this.release(id); }
  }

  /** Cancel an active request only when its original frame matches. */
  cancel(input: Operation, frame: object): MetaprojectResult<undefined> {
    const entry = this.active.get(input.operationId.toLowerCase());
    if (!entry || entry.canceled || entry.frame !== frame) return failure('stale');
    entry.canceled = true;
    return ok(undefined);
  }

  private release(id: string): void {
    this.active.delete(id);
    this.recent.add(id);
    const oldest = this.recent.values().next().value;
    if (this.recent.size > 256 && oldest) this.recent.delete(oldest);
  }
}
