/** Validates explicit project default choices and replaces legacy launch commands through one repository patch. */
import type { ProjectDefaultAgentRequest } from '@shared/project-default-agent';
import type { Project } from '@shared/types';
import type { ProjectsRepo } from '@main/repos/projects-repo';
import type { SettingsRepo } from '@main/repos/settings-repo';
import { findCliProfile } from '@main/domain/launch';
import { TERMINAL_AGENT_NAME } from '@shared/project-default-agent';

/** Repository capabilities needed to select a default without accessing shell or global-setting mutations. */
export interface ProjectDefaultAgentDependencies {
  readonly projects: Pick<ProjectsRepo, 'get' | 'updateConfig'>;
  readonly settings: Pick<SettingsRepo, 'get'>;
}

/** Parsed explicit choice or an actionable request validation error. */
export type ProjectDefaultAgentParse =
  | { readonly ok: true; readonly value: ProjectDefaultAgentRequest }
  | { readonly ok: false; readonly error: string };

/** Persisted project on success or an expected missing-project/profile failure. */
export type ProjectDefaultAgentResult =
  | { readonly ok: true; readonly project: Project }
  | { readonly ok: false; readonly error: string };

/** Parses the existing setter payload, preserves exact catalog names, and drops all unrelated fields. */
export function parseProjectDefaultAgent(input: unknown): ProjectDefaultAgentParse {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, error: 'Default agent request must be an object' };
  }
  if (!('projectId' in input) || !('name' in input)) {
    return { ok: false, error: 'Default agent request requires a project ID and profile name or null' };
  }
  const { projectId, name } = input;
  if (typeof projectId !== 'number' || !Number.isSafeInteger(projectId) || projectId <= 0) {
    return { ok: false, error: 'Default agent project ID must be a positive safe integer' };
  }
  if (name !== null && (typeof name !== 'string' || name.length === 0)) {
    return { ok: false, error: 'Default agent name must be a nonempty profile name or null' };
  }
  return { ok: true, value: { projectId, name } };
}

/** Saves a validated explicit choice/reset, clearing both legacy variants even for the current value; persistence errors propagate. */
export function setProjectDefaultAgent(
  dependencies: ProjectDefaultAgentDependencies,
  request: ProjectDefaultAgentRequest,
): ProjectDefaultAgentResult {
  const { projects, settings } = dependencies;
  const { projectId, name } = request;
  const project = projects.get(projectId);
  if (!project) return { ok: false, error: `No project ${projectId}; reopen project settings and try again` };
  if (name !== null && name !== TERMINAL_AGENT_NAME && !findCliProfile(project, settings, name)) {
    return { ok: false, error: 'Selected CLI profile is unavailable; choose an available profile or Use global default' };
  }
  return { ok: true, project: projects.updateConfig(projectId, { defaultCliName: name, launchCmd: null }) };
}
