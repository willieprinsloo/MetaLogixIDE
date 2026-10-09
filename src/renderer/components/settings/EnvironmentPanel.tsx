import { copyEnvValueToClipboard } from '@renderer/env-clipboard';
import { saveAppEnv, useAppEnv } from '@renderer/hooks/useAppEnv';
import { APP_ENV_DRAFT_KEY, type EnvDrafts } from '@renderer/hooks/useEnvDrafts';
import { useRevealState } from '@renderer/hooks/useRevealState';
import { APP_ENV_COPY } from '@renderer/project-env-copy';
import { EnvEditor, type EnvSource } from '@renderer/components/env/EnvEditor';

/**
 * Settings → Environment: the shared env editor over the app-wide variables.
 * The saved map comes from `useAppEnv`; edits live under `APP_ENV_DRAFT_KEY`
 * in `drafts`, which App owns so they outlive this panel and the dialog.
 * Save goes through the validated `settings:set-app-env`; a rejection keeps
 * the draft and toasts the key-only reason. Unmounting masks every value.
 */
export function EnvironmentPanel({ drafts }: { readonly drafts: EnvDrafts }) {
  const { stored, load, setStored } = useAppEnv();
  const reveal = useRevealState();
  const source: EnvSource = {
    draftKey: APP_ENV_DRAFT_KEY,
    drafts,
    stored,
    load,
    persist: async (env) => setStored(await saveAppEnv(env)),
  };
  return (
    <EnvEditor
      source={source}
      scope="app"
      subtitle={APP_ENV_COPY.panelSubtitle}
      reveal={reveal}
      onCopy={copyEnvValueToClipboard}
    />
  );
}
