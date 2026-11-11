import type { ReactNode } from 'react';
import { SHORTCUT_COPY } from '@renderer/shortcut-copy';
import { useShortcutPlatform } from '@renderer/shortcut-platform';
import { CHROME_TESTIDS } from '@renderer/chrome-testids';
import { ICON_SIZE } from './icon-size';

export type ActivityView = 'projects' | 'chat' | 'git' | 'tasks' | 'fleet';

interface Props {
  active: ActivityView;
  onSelect: (v: ActivityView) => void;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  /** Unread chat count, rendered as a badge on the Chat icon. */
  chatUnread?: number;
  /** Dirty-file count from the git panel; shows a subtle pip on the icon. */
  gitDirty?: number;
  /** Discovered task count for the tiny "N" pip on the Tasks icon. */
  taskCount?: number;
  /** Number of paired devices currently online (self excluded). Shows a pip when > 0. */
  fleetOnline?: number;
  /** Utility buttons (theme, tile, settings) pinned to the bottom of the rail. */
  footer?: ReactNode;
}

/** The far-left icon rail: sidebar toggle, project tools, and fleet access. */
export function ActivityBar({ active, onSelect, onToggleSidebar, sidebarOpen, chatUnread, gitDirty, taskCount, fleetOnline, footer }: Props) {
  const platform = useShortcutPlatform();
  return (
    <nav
      className="drag w-14 shrink-0 h-full flex flex-col items-center pb-3 gap-2"
      data-testid="activity-bar"
    >
      {/* Room for the traffic lights; sized so the sidebar toggle (44px) centres on the sidebar's 36px filter field, which starts 48px down. */}
      <div aria-hidden className={`${platform === 'mac' ? 'drag' : ''} h-9 w-full shrink-0`} data-testid="ab-drag-region" />
      <ABButton
        label={SHORTCUT_COPY.toggleSidebarLabel(platform)}
        onClick={onToggleSidebar}
        active={false}
        data-testid="ab-toggle-sidebar"
      >
        <SidebarIcon open={sidebarOpen} />
      </ABButton>
      <div aria-hidden className="h-1" />
      <ABButton
        label="Projects"
        active={active === 'projects'}
        onClick={() => onSelect('projects')}
        data-testid="ab-projects"
      >
        <ProjectsIcon />
      </ABButton>
      <ABButton
        label={chatUnread ? `Chat — ${chatUnread} unread` : 'Chat'}
        active={active === 'chat'}
        onClick={() => onSelect('chat')}
        data-testid="ab-chat"
        badge={active === 'chat' ? 0 : chatUnread}
      >
        <ChatIcon />
      </ABButton>
      <ABButton
        label={gitDirty ? `Git — ${gitDirty} changed` : 'Git'}
        active={active === 'git'}
        onClick={() => onSelect('git')}
        data-testid="ab-git"
        badge={active === 'git' ? 0 : gitDirty}
      >
        <GitBranchIcon />
      </ABButton>
      <ABButton
        label={taskCount ? `Tasks — ${taskCount} discovered` : 'Tasks'}
        active={active === 'tasks'}
        onClick={() => onSelect('tasks')}
        data-testid="ab-tasks"
        badge={active === 'tasks' ? 0 : taskCount}
        badgeTone="orange"
      >
        <TasksIcon />
      </ABButton>
      <ABButton
        label={fleetOnline ? `Fleet — ${fleetOnline} paired machines online` : 'Fleet'}
        active={active === 'fleet'}
        onClick={() => onSelect('fleet')}
        data-testid="ab-fleet"
        badge={active === 'fleet' ? 0 : fleetOnline}
      >
        <FleetIcon />
      </ABButton>
      <div aria-hidden className="flex-1" />
      {footer && (
        <div className="flex flex-col items-center gap-2 no-drag" data-testid={CHROME_TESTIDS.titleButtons}>
          {footer}
        </div>
      )}
    </nav>
  );
}

function FleetIcon() {
  // Three stacked tiles — reads as "many machines" at 16 px.
  return (
    <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3"  y="4"  width="8" height="7" rx="1.5" />
      <rect x="13" y="4"  width="8" height="7" rx="1.5" />
      <rect x="8"  y="13" width="8" height="7" rx="1.5" />
    </svg>
  );
}

export function ABButton({
  children, label, onClick, active, badge, badgeTone = 'accent', ...rest
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  active: boolean;
  badge?: number;
  /** Fill colour of the count badge; tasks use orange so they read apart from git. */
  badgeTone?: 'accent' | 'orange';
} & Record<string, unknown>) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-current={active ? 'page' : undefined}
      {...rest}
      className={`relative w-11 h-11 flex items-center justify-center rounded-[10px] pressable ${
        active
          ? 'bg-[--accent-soft] text-[--accent-soft-text]'
          : 'text-[--text-muted] hover:text-[--text] hover:bg-[--surface-hover]'
      }`}
    >
      {children}
      {badge != null && badge > 0 && (
        <span
          data-tone={badgeTone}
          className={`absolute top-[3px] right-[1px] min-w-4 h-4 px-1 rounded-lg text-[10px] font-semibold flex items-center justify-center leading-none ${
            badgeTone === 'orange' ? 'bg-[--hue-orange-soft] text-[--hue-orange-soft-text]' : 'bg-[--accent-soft] text-[--badge-accent-text]'
          }`}
        >
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}


function SidebarIcon({ open }: { open: boolean }) {
  return (
    <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1={open ? '9' : '9'} y1="3" x2="9" y2="21" />
    </svg>
  );
}

function GitBranchIcon() {
  return (
    <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="18" r="2.5" />
      <path d="M6 8.5v4a4 4 0 0 0 4 4h5.5" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ProjectsIcon() {
  return (
    <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}


function TasksIcon() {
  // Play triangle inside a rounded square — reads as "runnable" at 16px.
  return (
    <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="3" />
      <polygon points="10,8 16,12 10,16" fill="currentColor" stroke="none" />
    </svg>
  );
}
