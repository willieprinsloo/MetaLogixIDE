import type { ReactNode } from 'react';
import { ICON_SIZE } from './icon-size';

export type ActivityView = 'projects' | 'chat' | 'group' | 'git' | 'tasks';

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
}

export function ActivityBar({ active, onSelect, onToggleSidebar, sidebarOpen, chatUnread, gitDirty, taskCount }: Props) {
  return (
    <nav
      className="w-14 shrink-0 h-full flex flex-col items-center pt-1 pb-3 gap-1.5"
      data-testid="activity-bar"
    >
      <ABButton
        label="Toggle sidebar (⌘B)"
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
        label="Group chat — your agents talking together"
        active={active === 'group'}
        onClick={() => onSelect('group')}
        data-testid="ab-group"
      >
        <GroupIcon />
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
    </nav>
  );
}

function ABButton({
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
      {...rest}
      className={`relative w-9 h-9 flex items-center justify-center rounded-[10px] pressable ${
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

/** Two overlapping speech bubbles: agents talking together. */
function GroupIcon() {
  return (
    <svg width={ICON_SIZE.lg} height={ICON_SIZE.lg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15 10a2 2 0 0 1-2 2H6l-3 3V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
      <path d="M18 8h1a2 2 0 0 1 2 2v11l-3-3h-6a2 2 0 0 1-2-2v-1" />
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
