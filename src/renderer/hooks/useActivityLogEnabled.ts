import { useBooleanSetting } from '@renderer/hooks/useShowStatusBarPorts';
import { ACTIVITY_LOG_SETTING } from '@renderer/activity-log-contract';

/** Whether the activity log is on. True until loaded, on read failure, and for any stored value other than `false`; follows `settings:changed`. */
export function useActivityLogEnabled(): boolean {
  return useBooleanSetting(ACTIVITY_LOG_SETTING);
}
