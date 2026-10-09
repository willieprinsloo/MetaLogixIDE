import { useEffect, useState } from 'react';
import { api } from '@renderer/api';
import { inheritedRows } from '@renderer/app-env-inherited';
import { copyEnvValueToClipboard } from '@renderer/env-clipboard';
import { useAppEnv } from '@renderer/hooks/useAppEnv';
import type { EnvDrafts } from '@renderer/hooks/useEnvDrafts';
import { useRevealState } from '@renderer/hooks/useRevealState';
import { toast } from '@renderer/hooks/useToasts';
import { ENV_COPY } from '@renderer/project-env-copy';
import {
  EnvEditor,
  envErrorDetail,
  useMaskOnStoredChange,
  type EnvLoad,
  type EnvSource,
} from './env/EnvEditor';
import { InheritedEnvList } from './env/InheritedEnvList';

interface Props {
  projectId: number;
  projectName: string;
  drafts: EnvDrafts;
  onOpenAppEnv: () => void;
}

/** Loads the project's stored env map fresh from main on mount; `load` reports progress and failure. */
function useStoredEnv(projectId: number): {
  stored: Record<string, string>;
  setStored: (env: Record<string, string>) => void;
  load: EnvLoad;
} {
  const [stored, setStored] = useState<Record<string, string>>({});
  const [load, setLoad] = useState<EnvLoad>('loading');
  useEffect(() => {
    let live = true;
    api
      .invoke('projects:list', undefined as never)
      .then(({ projects }) => {
        const project = projects.find((p) => p.id === projectId);
        if (!live) return;
        if (!project) throw new Error(`project ${projectId} not found`);
        setStored(project.config.env ?? {});
        setLoad('ready');
      })
      .catch((e: unknown) => {
        if (!live) return;
        setLoad('failed');
        toast(ENV_COPY.loadFailed, { kind: 'error', detail: envErrorDetail(e) });
      });
    return () => {
      live = false;
    };
  }, [projectId]);
  return { stored, setStored, load };
}

/**
 * The project's Env tab: the shared env editor over the project's variables,
 * then the read-only "From app settings" list. Stored values load fresh via
 * `projects:list` on mount; edits live in the project's entry in `drafts`
 * until Save, which persists `{ env }` alone through `projects:update-config`.
 * One reveal state covers both lists and is dropped on unmount, so leaving
 * the tab masks every value. The inherited list follows the saved app-wide
 * map live, and any change to that map masks every value before paint, so an
 * inherited row keyed by a re-added name never shows revealed.
 * `onOpenAppEnv` opens Settings → Environment.
 */
export function ProjectEnvTab({ projectId, projectName, drafts, onOpenAppEnv }: Props) {
  const { stored, setStored, load } = useStoredEnv(projectId);
  const appEnv = useAppEnv();
  const reveal = useRevealState();
  useMaskOnStoredChange(appEnv.stored, false, reveal);
  const source: EnvSource = {
    draftKey: projectId,
    drafts,
    stored,
    load,
    persist: async (env) => {
      await api.invoke('projects:update-config', { id: projectId, config: { env } });
      setStored(env);
    },
  };
  return (
    <EnvEditor
      source={source}
      scope="project"
      subtitle={projectName}
      reveal={reveal}
      onCopy={copyEnvValueToClipboard}
    >
      <InheritedEnvList
        rows={inheritedRows(appEnv.stored, stored)}
        load={appEnv.load}
        reveal={reveal}
        onCopy={copyEnvValueToClipboard}
        onOpenAppEnv={onOpenAppEnv}
      />
    </EnvEditor>
  );
}
