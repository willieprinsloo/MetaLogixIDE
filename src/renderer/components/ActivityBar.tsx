import type { ReactNode } from 'react';

export type ActivityView = 'projects' | 'chat' | 'settings';

interface Props {
  active: ActivityView;
  onSelect: (v: ActivityView) => void;
  onToggleSidebar: () => void;
  sidebarOpen: boolean;
  /** Unread chat count, rendered as a badge on the Chat icon. */
  chatUnread?: number;
}

export function ActivityBar({ active, onSelect, onToggleSidebar, sidebarOpen, chatUnread }: Props) {
  return (
    <nav
      className="w-11 shrink-0 h-full border-r border-[--border] bg-[--panel]/40 backdrop-blur-md flex flex-col items-center py-1 gap-0.5"
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
      <Separator />
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

      <div className="mt-auto flex flex-col items-center gap-0.5">
        <ABButton
          label="Settings (⌘,)"
          active={active === 'settings'}
          onClick={() => onSelect('settings')}
          data-testid="ab-settings"
        >
          <GearIcon />
        </ABButton>
      </div>
    </nav>
  );
}

function ABButton({
  children, label, onClick, active, badge, ...rest
}: {
  children: ReactNode;
  label: string;
  onClick: () => void;
  active: boolean;
  badge?: number;
} & Record<string, unknown>) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      {...rest}
      className={`relative w-8 h-8 flex items-center justify-center rounded-md transition ${
        active
          ? 'bg-[--panel-strong] text-[--text]'
          : 'text-[--text-muted] hover:text-[--text] hover:bg-[--panel-strong]'
      }`}
    >
      {/* Active-indicator strip on the left, VS Code style */}
      {active && (
        <span className="absolute left-[-6px] top-1 bottom-1 w-[2px] rounded-full bg-[color:var(--accent)]" />
      )}
      {children}
      {badge != null && badge > 0 && (
        <span className="absolute -bottom-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-[color:var(--accent)] text-white text-[9px] font-semibold flex items-center justify-center leading-none">
          {badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  );
}

function Separator() {
  return <div className="w-6 h-px my-1 bg-[--border]" />;
}

function SidebarIcon({ open }: { open: boolean }) {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1={open ? '9' : '9'} y1="3" x2="9" y2="21" />
    </svg>
  );
}

function ChatIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function ProjectsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}


function GearIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}
